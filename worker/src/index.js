// TeleTVShare: Telegram bot -> ArvanCloud Object Storage -> Android TV.
//
// * Main bot (@Teletvsharepro_bot): users send files; files are stored in the Arvan bucket and
//   shown on the user's paired TV. No links are shown in the bot.
// * Admin bot (separate token): only the owner; receipts, users, gift codes, settings.
// * The TV never talks to Cloudflare (workers.dev is filtered in Iran). It reads everything
//   from Arvan: a pairing object p/<CODE>.json and a per-TV manifest m/<token>.json, and
//   reports viewing usage through a presigned PUT URL (r/<token>.json).
// * Bookkeeping lives in one SQLite-backed Durable Object ("Store").
import { DurableObject } from 'cloudflare:workers';
import { AwsClient } from 'aws4fetch';

const CHUNK = 1_900_000;              // in-DO storage chunk (owner's Cloudflare storage)
const VPS_CAP = 5 * 1024 ** 3;          // owner's storage on the VPS disk
const CF_CAP = 4_600_000_000;         // free plan: 5 GB of Durable Object storage per account
const TG_BOT_MAX = 20 * 1024 * 1024;  // Bot API getFile limit; bigger files go to the helper
const TG_MAX = 2000 * 1024 * 1024;    // Telegram's file limit for bots (MTProto)
const VPS_ALIVE = 60_000;             // the VPS counts as online if it asked for jobs this recently
const VPS_DOWN_ALERT = 3 * 60_000;    // tell the owner when the VPS has been silent this long
const LEASE = 3 * 60_000;             // a helper must show progress this often or the job is handed on
const HANDOFF = 90_000;               // unclaimed jobs go to GitHub after this long
const BUSY_ST = `('queued','uploading','waiting_helper','helper_uploading','waiting_space')`; // a user's file being saved
const HELPER_ST = `('waiting_helper','helper_uploading','link_probe','link_download')`;
const PAGE = 8;
const DAY = 864e5;
const GRACE_MS = DAY;                 // files over quota are kept 24h after a plan ends
const REMIND_BEFORE = 3 * DAY;
const PAIR_TTL = 15 * 60_000;
const MAINT_EVERY = 30 * 60_000;
const MANIFEST_REFRESH = 3 * DAY;     // presigned report URL lives 7 days
const WELCOME = { plan: 'p500', days: 7 };
const REF_BONUS = 500e6;          // referral reward
const REF_DAYS = 7;
const REF_MAX_PER_MONTH = 10;
const RATE_PER_MIN = 30;           // messages + button presses per user
const RATE_PER_DAY = 1500;

const PLANS = {
  free: { title: 'رایگان', quota: 100e6, price: 0, fw: 4 },
  p500: { title: '۵۰۰ مگابایت (هدیه عضویت)', quota: 500e6, price: 0, fw: 4 }, // welcome gift only
  // fw = fair-use monthly viewing as a multiple of the plan's storage (not shown to users)
  p1g: { title: '۱ گیگابایت', quota: 1e9, price: 19_900, fw: 4, util: 0.7 },
  p5g: { title: '۵ گیگابایت', quota: 5e9, price: 69_900, fw: 4, util: 0.6 },
  p20g: { title: '۲۰ گیگابایت', quota: 20e9, price: 199_000, fw: 4, util: 0.5, badge: '⭐ محبوب‌ترین' },
  p50g: { title: '۵۰ گیگابایت', quota: 50e9, price: 399_000, fw: 4, util: 0.4, badge: '💎 به‌صرفه‌ترین' },
};
const PLAN_ORDER = ['free', 'p500', 'p1g', 'p5g', 'p20g', 'p50g']; // for upgrade/downgrade checks
const SALE = ['p1g', 'p5g', 'p20g', 'p50g'];
// Arvan cost per GB incl. 10% VAT (toman): storage per month, download traffic.
const ARVAN_STORE_GB = 3960;
const ARVAN_TRAFFIC_GB = 1062;
// Realistic pricing basis: average share of the quota actually used, and views per stored GB per month.
const VIEWS_PER_GB = 2;
const PERIODS = [1, 3, 6, 12];                                      // months
const PERIOD_TITLE = { 1: 'یک ماهه', 3: 'سه ماهه', 6: 'شش ماهه', 12: 'یک ساله' };                        // plans that can be bought or gifted
const PLAN_ALIAS = { '1': 'p1g', '1g': 'p1g', p1g: 'p1g', '5': 'p5g', '5g': 'p5g', p5g: 'p5g',
  '20': 'p20g', '20g': 'p20g', p20g: 'p20g', '50': 'p50g', '50g': 'p50g', p50g: 'p50g' };
const ACTIVE = `('ready','uploading','queued','waiting_helper','helper_uploading','link_download')`;
const CODE_ABC = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
// Adult sites are refused: such content is illegal in Iran and would get the Arvan account closed.
const BLOCKED_SITES = ['pornhub.com', 'xvideos.com', 'xnxx.com', 'xhamster.com', 'redtube.com', 'youporn.com', 'tube8.com',
  'spankbang.com', 'eporner.com', 'bdsmvilla.com', 'femdomtube.com', 'beeg.com', 'txxx.com', 'hqporner.com', 'porntrex.com',
  'motherless.com', 'thumbzilla.com', 'onlyfans.com', 'chaturbate.com', 'stripchat.com', 'xxx'];

// ---------------------------------------------------------------- helpers
const enc = new TextEncoder();

function randomId(len = 16, abc = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789') {
  const max = 256 - (256 % abc.length);
  let s = '';
  while (s.length < len) {
    for (const b of crypto.getRandomValues(new Uint8Array(len * 2))) {
      if (b < max) s += abc[b % abc.length];
      if (s.length === len) break;
    }
  }
  return s;
}
const giftCode = () => randomId(4, CODE_ABC) + '-' + randomId(4, CODE_ABC);
const faNum = (n) => new Intl.NumberFormat('fa-IR').format(n);

function fmtSize(n) {
  if (n == null) return '?';
  if (!Number.isFinite(n)) return 'نامحدود';
  if (n < 1000) return `${n} B`;
  if (n < 1e6) return `${(n / 1e3).toFixed(1)} KB`;
  if (n < 1e9) return `${(n / 1e6).toFixed(1)} MB`;
  return `${(n / 1e9).toFixed(2)} GB`;
}

function fmtDate(ms, withTime = true) {
  try {
    return new Intl.DateTimeFormat('fa-IR', {
      timeZone: 'Asia/Tehran', year: 'numeric', month: '2-digit', day: '2-digit',
      ...(withTime ? { hour: '2-digit', minute: '2-digit' } : {}),
    }).format(new Date(ms));
  } catch {
    return new Date(ms).toISOString().slice(0, 16).replace('T', ' ');
  }
}

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const short = (s, n = 28) => (String(s).length > n ? String(s).slice(0, n - 1) + '…' : String(s));
const monthKey = (ms = Date.now()) => new Date(ms + 3.5 * 3600e3).toISOString().slice(0, 7);
const pctOf = (a, b) => (Number.isFinite(b) && b > 0 ? Math.min(100, Math.round((a / b) * 100)) : 0);
const bar = (pct) => {
  const k = Math.max(0, Math.min(10, Math.round(pct / 10)));
  return '█'.repeat(k) + '░'.repeat(10 - k);
};
const encodeKey = (key) => key.split('/').map(encodeURIComponent).join('/');

function cleanName(name) {
  const s = String(name || '').replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '_').trim();
  return s.slice(0, 180) || 'file';
}

function kindOf(mime = '', name = '') {
  if (mime.startsWith('video/')) return 'video';
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('audio/')) return 'audio';
  const ext = (name.split('.').pop() || '').toLowerCase();
  if (['mp4', 'mkv', 'webm', 'mov', 'avi', 'm4v', 'ts', '3gp'].includes(ext)) return 'video';
  if (['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'heic'].includes(ext)) return 'image';
  if (['mp3', 'm4a', 'ogg', 'oga', 'flac', 'wav', 'aac', 'opus'].includes(ext)) return 'audio';
  return 'file';
}

function guessMime(name) {
  const ext = (name.split('.').pop() || '').toLowerCase();
  return ({
    mp4: 'video/mp4', mkv: 'video/x-matroska', webm: 'video/webm', mov: 'video/quicktime', m4v: 'video/mp4',
    jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp',
    mp3: 'audio/mpeg', m4a: 'audio/mp4', ogg: 'audio/ogg', flac: 'audio/flac', wav: 'audio/wav',
    pdf: 'application/pdf', zip: 'application/zip', txt: 'text/plain; charset=utf-8',
    apk: 'application/vnd.android.package-archive',
  })[ext] || 'application/octet-stream';
}

function extractMedia(m) {
  const stamp = new Date((m.date || Date.now() / 1000) * 1000).toISOString().slice(0, 19).replace(/[:T]/g, '-');
  const pick = (o, fallbackName, fallbackMime, kind) => {
    const name = cleanName(o.file_name || fallbackName);
    const mime = o.mime_type || fallbackMime || guessMime(name);
    return {
      fileId: o.file_id, uniqueId: o.file_unique_id || null, name, mime, size: o.file_size || 0,
      kind: kind || kindOf(mime, name),
      thumbId: (o.thumbnail || o.thumb)?.file_id || null,
      width: o.width || null, height: o.height || null, duration: o.duration || null,
    };
  };
  if (m.document) return pick(m.document, `file_${stamp}`);
  if (m.video) return pick(m.video, `video_${stamp}.mp4`, 'video/mp4', 'video');
  if (m.animation) return pick(m.animation, `animation_${stamp}.mp4`, 'video/mp4', 'video');
  if (m.video_note) return pick(m.video_note, `videonote_${stamp}.mp4`, 'video/mp4', 'video');
  if (m.audio) {
    const a = m.audio;
    const n = a.file_name || [a.performer, a.title].filter(Boolean).join(' - ') + '.mp3';
    return pick(a, n === '.mp3' ? `audio_${stamp}.mp3` : n, 'audio/mpeg', 'audio');
  }
  if (m.voice) return pick(m.voice, `voice_${stamp}.ogg`, 'audio/ogg', 'audio');
  if (m.photo?.length) {
    const p = m.photo[m.photo.length - 1];
    const t = m.photo.find((x) => x.width >= 320) || p;
    return { ...pick(p, `photo_${stamp}.jpg`, 'image/jpeg', 'image'), thumbId: t.file_id };
  }
  if (m.sticker && !m.sticker.is_animated && !m.sticker.is_video) {
    return pick(m.sticker, `sticker_${stamp}.webp`, 'image/webp', 'image');
  }
  return null;
}

// ---------------------------------------------------------------- Durable Object
export class Store extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS files(
        id TEXT PRIMARY KEY, name TEXT NOT NULL, mime TEXT, size INTEGER NOT NULL,
        kind TEXT NOT NULL, status TEXT NOT NULL, tg_file_id TEXT, thumb_file_id TEXT,
        thumb BLOB, width INTEGER, height INTEGER, duration INTEGER,
        chat_id INTEGER, msg_id INTEGER, created_at INTEGER NOT NULL, error TEXT);
      CREATE INDEX IF NOT EXISTS files_created ON files(created_at);
      CREATE TABLE IF NOT EXISTS chunks(file_id TEXT NOT NULL, idx INTEGER NOT NULL,
        data BLOB NOT NULL, PRIMARY KEY(file_id, idx));
      CREATE TABLE IF NOT EXISTS seen(update_id TEXT PRIMARY KEY, at INTEGER);
      CREATE TABLE IF NOT EXISTS vps_del(id TEXT PRIMARY KEY, at INTEGER);
      CREATE TABLE IF NOT EXISTS users(
        id INTEGER PRIMARY KEY, first_name TEXT, username TEXT,
        plan TEXT NOT NULL DEFAULT 'free', expires_at INTEGER, grace_until INTEGER,
        reminded INTEGER NOT NULL DEFAULT 0, banned INTEGER NOT NULL DEFAULT 0, state TEXT,
        bw_month TEXT, bw_used INTEGER NOT NULL DEFAULT 0, bw_warned INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL, last_seen INTEGER);
      CREATE TABLE IF NOT EXISTS welcomed(id INTEGER PRIMARY KEY, at INTEGER);
      CREATE TABLE IF NOT EXISTS payments(
        id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, plan TEXT NOT NULL,
        amount INTEGER NOT NULL, status TEXT NOT NULL, file_id TEXT, is_photo INTEGER,
        admin_msg_id INTEGER, created_at INTEGER NOT NULL, decided_at INTEGER);
      CREATE TABLE IF NOT EXISTS gift_codes(
        code TEXT PRIMARY KEY, plan TEXT NOT NULL, days INTEGER NOT NULL,
        max_uses INTEGER NOT NULL, used INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS gift_uses(code TEXT NOT NULL, user_id INTEGER NOT NULL, at INTEGER,
        PRIMARY KEY(code, user_id));
      CREATE TABLE IF NOT EXISTS devices(token TEXT PRIMARY KEY, user_id INTEGER NOT NULL UNIQUE,
        name TEXT, created_at INTEGER NOT NULL, last_seen INTEGER);
      CREATE TABLE IF NOT EXISTS tv_pairs(code TEXT PRIMARY KEY, created_at INTEGER NOT NULL, user_id INTEGER);
      CREATE TABLE IF NOT EXISTS seen2(id TEXT PRIMARY KEY, at INTEGER);
      CREATE TABLE IF NOT EXISTS bonuses(id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, bytes INTEGER NOT NULL,
        expires_at INTEGER NOT NULL, created_at INTEGER NOT NULL, from_user INTEGER, done INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT);
      CREATE TABLE IF NOT EXISTS support(admin_msg_id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL, created_at INTEGER);
    `);
    this.addCols('files', { owner: 'INTEGER', storage: "TEXT NOT NULL DEFAULT 'do'", obj_key: 'TEXT', thumb_key: 'TEXT', source_url: 'TEXT', formats: 'TEXT', fmt: 'TEXT', src_msg_id: 'INTEGER', lease_by: 'TEXT', lease_until: 'INTEGER', uniq: 'TEXT' });
    this.addCols('users', {
      up_month: 'TEXT', up_used: 'INTEGER NOT NULL DEFAULT 0',
      watch_month: 'TEXT', watch_used: 'INTEGER NOT NULL DEFAULT 0', watch_warned: 'INTEGER NOT NULL DEFAULT 0',
    });
    this.addCols('payments', { months: 'INTEGER NOT NULL DEFAULT 1' });
    this.addCols('support', { answered_at: 'INTEGER' });
    this.addCols('users', { terms_at: 'INTEGER', ref_code: 'TEXT', referred_by: 'INTEGER', ref_rewarded: 'INTEGER NOT NULL DEFAULT 0' });
    this.addCols('welcomed', { gifted: 'INTEGER NOT NULL DEFAULT 1' });
    this.addCols('devices', { manifest_at: 'INTEGER', rep_month: 'TEXT', rep_bytes: 'INTEGER NOT NULL DEFAULT 0' });
    this.sql.exec('UPDATE files SET owner=? WHERE owner IS NULL', Number(env.OWNER_ID));
    this.sql.exec('CREATE INDEX IF NOT EXISTS files_owner ON files(owner, created_at)');
  }

  addCols(table, cols) {
    const have = this.q(`PRAGMA table_info(${table})`).map((c) => c.name);
    for (const [name, type] of Object.entries(cols)) {
      if (!have.includes(name)) this.sql.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${type}`);
    }
  }

  // ---- storage primitives
  q(query, ...args) { return this.sql.exec(query, ...args).toArray(); }
  one(query, ...args) { return this.q(query, ...args)[0] || null; }
  meta(key, value) {
    if (value === undefined) return this.one('SELECT value FROM meta WHERE key=?', key)?.value ?? null;
    if (value === null) this.sql.exec('DELETE FROM meta WHERE key=?', key);
    else this.sql.exec('INSERT OR REPLACE INTO meta(key,value) VALUES (?,?)', key, String(value));
  }

  // ---- settings editable from the admin bot
  setting(key) {
    const v = this.meta('set_' + key);
    if (v != null) return v;
    return ({
      card_number: this.env.CARD_NUMBER, card_name: this.env.CARD_NAME, card_bank: this.env.CARD_BANK,
      mult_up: '10', links: '0', welcome_daily: '50',
      ...Object.fromEntries(Object.keys(PLANS).map((k) => ['fw_' + k, String(PLANS[k].fw)])),
      ...Object.fromEntries(SALE.map((k) => ['price_' + k, String(PLANS[k].price)])),
      disc_3: '10', disc_6: '15', disc_12: '25',
    })[key] ?? null;
  }
  price(plan) { return Number(this.setting('price_' + plan)) || 0; }
  fairWatch(plan) { return Number(this.setting('fw_' + plan)) || PLANS[plan]?.fw || 3; }
  discount(months) { return months === 1 ? 0 : Math.min(90, Number(this.setting('disc_' + months)) || 0); }
  // Estimated real Arvan cost of a plan per month (typical usage), without and with a 5% margin.
  estCost(plan) {
    const gb = (PLANS[plan].quota / 1e9) * (PLANS[plan].util || 0.6);
    return gb * (ARVAN_STORE_GB + VIEWS_PER_GB * ARVAN_TRAFFIC_GB);
  }
  floorMonthly(plan) { return this.estCost(plan) * 1.05; }
  // Psychological price: nearest amount ending in 9,000 (189,000 rather than 190,000).
  charm(x) { return x < 100_000 ? Math.max(4900, Math.round((x + 100) / 1000) * 1000 - 100) : Math.round((x + 1000) / 10000) * 10000 - 1000; }
  // Total for a period. Discounts never push the price below the worst-case cost.
  priceFor(plan, months) {
    const base = this.price(plan) * months;
    if (months === 1) return this.price(plan);
    const min = this.floorMonthly(plan) * months;
    let total = this.charm(base * (1 - this.discount(months) / 100));
    while (total < min) total += total < 100_000 ? 1000 : 10000;
    return Math.min(total, base);
  }
  savedPct(plan, months) { return Math.max(0, Math.floor((1 - this.priceFor(plan, months) / (this.price(plan) * months)) * 100)); }

  isAdmin(id) { return String(id) === String(this.env.OWNER_ID); }
  linksFor(uid) { return this.isAdmin(uid) || this.setting('links') === '1'; }
  totalUsed() { return this.one(`SELECT COALESCE(SUM(size),0) AS s FROM files WHERE status IN ${ACTIVE}`).s; }
  userUsed(uid) { return this.one(`SELECT COALESCE(SUM(size),0) AS s FROM files WHERE owner=? AND status IN ${ACTIVE} AND storage NOT IN ('cf','vps')`, uid).s; }
  user(uid) { return this.one('SELECT * FROM users WHERE id=?', uid); }

  // Effective limits. Monthly upload and viewing caps are `mult` x storage quota.
  limits(u) {
    if (this.isAdmin(u.id)) return { plan: 'admin', title: 'مدیر', quota: Infinity, upCap: Infinity, watchCap: Infinity };
    const p = PLANS[u.plan] || PLANS.free;
    const up = Number(this.setting('mult_up')) || 10;
    const quota = p.quota + this.bonusBytes(u.id);
    return { plan: u.plan, title: p.title, quota, upCap: quota * up, watchCap: quota * this.fairWatch(u.plan) };
  }
  monthUsage(u) {
    const mk = monthKey();
    return { up: u.up_month === mk ? u.up_used : 0, watch: u.watch_month === mk ? u.watch_used : 0 };
  }
  freeFor(u) { return Math.max(0, this.limits(u).quota - this.userUsed(u.id)); }

  touchUser(from) {
    const now = Date.now();
    const isNew = !this.user(from.id);
    this.sql.exec(`INSERT INTO users(id, first_name, username, created_at, last_seen) VALUES (?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET first_name=excluded.first_name, username=excluded.username, last_seen=excluded.last_seen`,
      from.id, from.first_name || '', from.username || null, now, now);
    let welcomed = false;
    if (isNew && !this.isAdmin(from.id) && !this.one('SELECT 1 AS x FROM welcomed WHERE id=?', from.id)) {
      // cap welcome gifts per day so mass-created accounts can't run up the storage bill
      const cap = Number(this.setting('welcome_daily')) || 50;
      const today = this.one('SELECT COUNT(*) AS c FROM welcomed WHERE gifted=1 AND at > ?', now - DAY).c;
      const gift = today < cap;
      this.sql.exec('INSERT INTO welcomed(id, at, gifted) VALUES (?,?,?)', from.id, now, gift ? 1 : 0);
      if (gift) {
        this.activatePlan(from.id, WELCOME.plan, WELCOME.days);
        welcomed = true;
      } else if (this.meta('welcome_cap_day') !== String(Math.floor(now / DAY))) {
        this.meta('welcome_cap_day', String(Math.floor(now / DAY)));
        this._capHit = true;
      }
    }
    const u = this.user(from.id);
    u._new = isNew;
    u._welcomed = welcomed;
    return u;
  }

  // ================================================================ Arvan S3
  s3() {
    this.sub = (this.sub || 0) + 1;
    this._s3 ||= new AwsClient({
      accessKeyId: this.env.ARVAN_ACCESS_KEY, secretAccessKey: this.env.ARVAN_SECRET_KEY,
      service: 's3', region: this.env.ARVAN_REGION, retries: 0,
    });
    return this._s3;
  }
  objUrl(key) { return `${this.env.ARVAN_ENDPOINT}/${this.env.ARVAN_BUCKET}/${encodeKey(key)}`; }
  publicUrl(key) { return `${this.env.ARVAN_PUBLIC_URL}/${encodeKey(key)}`; }

  async s3put(key, body, { type = 'application/octet-stream', acl = 'public-read', cache, disposition } = {}) {
    const headers = { 'content-type': type, 'x-amz-content-sha256': 'UNSIGNED-PAYLOAD' };
    if (acl) headers['x-amz-acl'] = acl;
    if (cache) headers['cache-control'] = cache;
    if (disposition) headers['content-disposition'] = disposition;
    const r = await this.s3().fetch(this.objUrl(key), { method: 'PUT', headers, body });
    if (!r.ok) throw new Error(`Arvan PUT ${r.status}: ${(await r.text()).slice(0, 200)}`);
  }
  // S3 multipart upload; getPart(n) returns the bytes of part n (1-based).
  async s3multipart(key, partCount, getPart, { type = 'application/octet-stream', disposition } = {}) {
    const sig = { 'x-amz-content-sha256': 'UNSIGNED-PAYLOAD' };
    const init = { ...sig, 'content-type': type, 'x-amz-acl': 'public-read' };
    if (disposition) init['content-disposition'] = disposition;
    let r = await this.s3().fetch(`${this.objUrl(key)}?uploads`, { method: 'POST', headers: init });
    if (!r.ok) throw new Error(`Arvan multipart init ${r.status}: ${(await r.text()).slice(0, 200)}`);
    const uploadId = /<UploadId>([^<]+)<\/UploadId>/.exec(await r.text())?.[1];
    if (!uploadId) throw new Error('Arvan multipart: no UploadId');
    const q = (n) => `${this.objUrl(key)}?partNumber=${n}&uploadId=${encodeURIComponent(uploadId)}`;
    try {
      const etags = [];
      for (let n = 1; n <= partCount; n++) {
        const body = getPart(n);
        for (let attempt = 1; ; attempt++) {
          r = await this.s3().fetch(q(n), { method: 'PUT', headers: sig, body });
          if (r.ok) break;
          if (attempt >= 4) throw new Error(`Arvan part ${n}: ${r.status} ${(await r.text()).slice(0, 200)}`);
          await new Promise((res) => setTimeout(res, 1000 * attempt));
        }
        etags.push(r.headers.get('etag'));
      }
      const xml = `<CompleteMultipartUpload>${etags.map((e, i) => `<Part><PartNumber>${i + 1}</PartNumber><ETag>${e}</ETag></Part>`).join('')}</CompleteMultipartUpload>`;
      r = await this.s3().fetch(`${this.objUrl(key)}?uploadId=${encodeURIComponent(uploadId)}`, {
        method: 'POST', headers: { ...sig, 'content-type': 'application/xml' }, body: xml,
      });
      const text = await r.text();
      if (!r.ok || /<Error>/.test(text)) throw new Error(`Arvan multipart complete ${r.status}: ${text.slice(0, 200)}`);
    } catch (e) {
      await this.s3().fetch(`${this.objUrl(key)}?uploadId=${encodeURIComponent(uploadId)}`, { method: 'DELETE', headers: sig }).catch(() => {});
      throw e;
    }
  }

  async s3get(key) {
    const r = await this.s3().fetch(this.objUrl(key), { headers: { 'x-amz-content-sha256': 'UNSIGNED-PAYLOAD' } });
    if (r.status === 404) return null;
    if (!r.ok) throw new Error(`Arvan GET ${r.status}`);
    return r;
  }
  // Size of an object; retries because a just-completed upload can take a moment to show up.
  async s3head(key, tries = 6) {
    for (let i = 1; ; i++) {
      const r = await this.s3().fetch(this.objUrl(key), { method: 'HEAD', headers: { 'x-amz-content-sha256': 'UNSIGNED-PAYLOAD' } });
      if (r.ok) return Number(r.headers.get('content-length'));
      if (i >= tries) return null;
      await new Promise((res) => setTimeout(res, 1500 * i));
    }
  }
  async s3del(key) {
    if (!key) return;
    const r = await this.s3().fetch(this.objUrl(key), { method: 'DELETE', headers: { 'x-amz-content-sha256': 'UNSIGNED-PAYLOAD' } });
    if (!r.ok && r.status !== 404) console.log('Arvan DELETE failed', key, r.status);
  }
  async presignPut(key, seconds = 7 * 86400) {
    const signed = await this.s3().sign(`${this.objUrl(key)}?X-Amz-Expires=${seconds}`, { method: 'PUT', aws: { signQuery: true } });
    return signed.url;
  }

  async putJson(key, obj, acl = 'public-read') {
    return this.s3put(key, JSON.stringify(obj), { type: 'application/json; charset=utf-8', acl, cache: 'no-cache, max-age=0' });
  }

  fileKey(f) { return `f/${f.id}/${cleanName(f.name)}`; }
  disposition(name) {
    const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/"/g, '');
    return `inline; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
  }

  async deleteFile(id) {
    const f = this.one('SELECT owner, obj_key, thumb_key, storage FROM files WHERE id=?', id);
    if (f?.storage === 'vps') this.sql.exec('INSERT OR IGNORE INTO vps_del(id, at) VALUES (?,?)', id, Date.now());
    this.sql.exec('DELETE FROM chunks WHERE file_id=?', id);
    this.sql.exec('DELETE FROM files WHERE id=?', id);
    if (f) {
      await this.s3del(f.obj_key);
      await this.s3del(f.thumb_key);
      await this.writeManifest(f.owner);
      await this.promoteTurn(f.owner);
    }
  }

  // ================================================================ Telegram
  token(bot) { return bot === 'admin' ? this.env.ADMIN_BOT_TOKEN : this.env.BOT_TOKEN; }
  tgBase() { return this.env.TG_API || 'https://api.telegram.org'; } // TG_API is only set for offline local tests

  async tg(method, body, bot = 'main') {
    this.sub = (this.sub || 0) + 1;
    let r;
    try {
      r = await fetch(`${this.tgBase()}/bot${this.token(bot)}/${method}`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
        signal: AbortSignal.timeout(20_000),
      });
    } catch (e) {
      console.log('tg network error', bot, method, String(e));
      return { ok: false, description: 'network error' };
    }
    const j = await r.json().catch(() => ({ ok: false, description: `HTTP ${r.status}` }));
    if (!j.ok && !/not modified/.test(j.description || '')) console.log('tg error', bot, method, j.description);
    return j;
  }

  // Every inner screen of the main bot gets a "main menu" button, except the main menu itself
  // and messages about a transfer in progress (those already have their own cancel button).
  withHome(keyboard, bot) {
    if (bot !== 'main') return keyboard;
    const datas = (keyboard || []).flat().map((k) => k.callback_data || '');
    if (datas.includes('inv') || datas.includes('home') || datas.some((d) => d.startsWith('c:'))) return keyboard;
    return [...(keyboard || []), [{ text: '🏠 منوی اصلی', callback_data: 'home' }]];
  }

  edit(chatId, msgId, text, keyboard, bot = 'main') {
    const kb = this.withHome(keyboard, bot);
    return this.tg('editMessageText', {
      chat_id: chatId, message_id: msgId, text, parse_mode: 'HTML',
      link_preview_options: { is_disabled: true },
      reply_markup: kb ? { inline_keyboard: kb } : undefined,
    }, bot);
  }

  send(chatId, text, keyboard, replyTo, bot = 'main') {
    const kb = this.withHome(keyboard, bot);
    return this.tg('sendMessage', {
      chat_id: chatId, text, parse_mode: 'HTML',
      link_preview_options: { is_disabled: true },
      reply_parameters: replyTo ? { message_id: replyTo, allow_sending_without_reply: true } : undefined,
      reply_markup: kb ? { inline_keyboard: kb } : undefined,
    }, bot);
  }

  notifyAdmin(text, keyboard) { return this.send(Number(this.env.OWNER_ID), text, keyboard, null, 'admin'); }

  async tgFile(fileId) {
    const gf = await this.tg('getFile', { file_id: fileId });
    if (!gf.ok) throw new Error(gf.description || 'getFile failed');
    const r = await fetch(`${this.tgBase()}/file/bot${this.env.BOT_TOKEN}/${gf.result.file_path}`);
    if (!r.ok || !r.body) throw new Error(`download failed: HTTP ${r.status}`);
    return { res: r, size: gf.result.file_size };
  }

  // ================================================================ HTTP entry
  async fetch(req) {
    const url = new URL(req.url);
    const p = url.pathname;
    this.sub = 0;
    try {
      await this.ensureAlarm();
      if (p === '/tg') { await this.onUpdate(await req.json()); return new Response('ok'); }
      if (p === '/tga') { await this.onAdminUpdate(await req.json()); return new Response('ok'); }
      let m;
      if ((m = /^\/f\/([A-Za-z0-9]{16})(?:\/.*)?$/.exec(p))) return this.serveFile(req, m[1]);
      if ((m = /^\/t\/([A-Za-z0-9]{16})$/.exec(p))) return this.serveThumb(m[1]);
      if (p.startsWith('/api/')) return this.api(req, url, p);
      if (p.startsWith('/helper/')) {
        if (p === '/helper/jobs') return this.helperJobs(req);
        if ((m = /^\/helper\/claim\/([A-Za-z0-9]{16})$/.exec(p)) && req.method === 'POST') return this.helperClaim(req, m[1]);
        if (p === '/helper/vpsdel' && req.method === 'POST') {
          const { ids = [] } = await req.json().catch(() => ({}));
          for (const x of ids.slice(0, 200)) this.sql.exec('DELETE FROM vps_del WHERE id=?', String(x));
          return Response.json({ ok: true });
        }
        if (p === '/helper/tg') return Response.json({ api_id: Number(this.env.TG_API_ID) || null, api_hash: this.env.TG_API_HASH || null, bot_token: this.env.BOT_TOKEN });
        if ((m = /^\/helper\/(finish|fail)\/([A-Za-z0-9]{16})$/.exec(p))) return this.helperDone(req, m[1], m[2]);
        if ((m = /^\/helper\/progress\/([A-Za-z0-9]{16})$/.exec(p))) return this.helperProgress(req, m[1]);
        if ((m = /^\/helper\/formats\/([A-Za-z0-9]{16})$/.exec(p))) return this.helperFormats(req, m[1]);
        if ((m = /^\/helper\/upload\/([A-Za-z0-9]{16})$/.exec(p)) && req.method === 'PUT') return this.helperUpload(req, url, m[1]);
        if ((m = /^\/helper\/thumb\/([A-Za-z0-9]{16})$/.exec(p)) && req.method === 'PUT') return this.helperThumb(req, m[1]);
      }
      return new Response('Not found', { status: 404 });
    } catch (e) {
      console.log('error', p, e.stack || e);
      return new Response('Internal error', { status: 500 });
    }
  }

  seenOnce(id) {
    if (this.one('SELECT 1 AS x FROM seen2 WHERE id=?', id)) return false;
    this.sql.exec('INSERT INTO seen2(id, at) VALUES (?,?)', id, Date.now());
    return true;
  }

  // ================================================================ main bot
  async onUpdate(u) {
    if (u.update_id != null && !this.seenOnce('m' + u.update_id)) return;
    if (u.callback_query) return this.onCallback(u.callback_query);
    const m = u.message;
    if (!m || m.chat?.type !== 'private' || !m.from) return;
    const rl = this.rateLimited(m.from.id);
    if (rl) {
      if (!rl.warned) { rl.warned = 1; await this.send(m.chat.id, '⏳ پیام‌های شما خیلی زیاد است. لطفاً چند دقیقه صبر کنید.'); }
      return;
    }
    const user = this.touchUser(m.from);
    if (this._capHit) { this._capHit = false; await this.notifyAdmin(`⚠️ سقف هدیه عضویت امروز (${faNum(Number(this.setting('welcome_daily')) || 50)} نفر) پر شد. عضوهای جدید تا فردا فقط پلن رایگان می‌گیرند. اگر عادی است، سقف را از تنظیمات بالا ببرید.`); }
    if (user._new) await this.notifyAdmin(`👤 کاربر جدید: ${esc(user.first_name)}${user.username ? ` @${esc(user.username)}` : ''} — <code>${user.id}</code>`);
    if (user.banned) return this.send(m.chat.id, '⛔️ حساب شما مسدود شده است.');

    const text = (m.text || '').trim();
    const cmd = /^\/(\w+)(?:@\w+)?\s*(.*)$/s.exec(text);
    if (cmd) {
      if (user.state) this.setState(user.id, null);
      return this.onCommand(m, user, cmd[1].toLowerCase(), cmd[2].trim());
    }
    if (user.state === 'support') return this.onSupportMessage(m, user);
    if (user.state?.startsWith('receipt:') && (m.photo || m.document)) return this.onReceipt(m, user, user.state.slice(8));
    if (user.state === 'gift' && text) { this.setState(user.id, null); return this.redeem(m.chat.id, user, text); }
    if (user.state === 'tv' && text) { this.setState(user.id, null); return this.linkTv(m.chat.id, user, text); }

    const media = extractMedia(m);
    const link = !media && this.linksFor(user.id) && (text.match(/https?:\/\/\S+/) || [])[0];
    if (link) {
      if (user.state) this.setState(user.id, null);
      if (await this.needsTerms(m, user)) return;
      return this.addLink(m, user, link);
    }
    if (!media) return this.sendMenu(m.chat.id, user);
    if (user.state) this.setState(user.id, null);
    if (await this.needsTerms(m, user)) return;
    return this.addFile(m, user, media);
  }

  setState(uid, state) { this.sql.exec('UPDATE users SET state=? WHERE id=?', state, uid); }

  async onCommand(m, user, name, arg) {
    const chat = m.chat.id;
    if (name === 'start') {
      if (arg.startsWith('tv_')) return this.linkTv(chat, user, arg.slice(3));
      if (arg.startsWith('gift_')) return this.redeem(chat, user, arg.slice(5));
      if (arg.startsWith('ref_')) this.noteReferral(user, arg.slice(4));
      return this.sendMenu(chat, user, true);
    }
    if (name === 'list' || name === 'files') return this.sendList(chat, user.id, 0);
    if (name === 'account' || name === 'usage') return this.send(chat, this.accountText(user), this.menuKeyboard());
    if (name === 'buy' || name === 'plans') return this.send(chat, this.plansText(user), this.plansKeyboard(user));
    if (name === 'code' || name === 'gift') {
      if (arg) return this.redeem(chat, user, arg);
      this.setState(user.id, 'gift');
      return this.send(chat, '🎁 کد هدیه را بفرستید:');
    }
    if (name === 'tv') return arg ? this.linkTv(chat, user, arg) : this.sendTvStatus(chat, user);
    if (name === 'app' || name === 'install') return this.sendApp(chat);
    if (name === 'support') return this.supportStart(chat, user);
    if (name === 'rules' || name === 'terms') return this.sendTerms(chat, user, true);
    if (name === 'invite' || name === 'ref') { const v = this.inviteView(user); return this.send(chat, v.text, v.kb); }
    if (name === 'help' || name === 'guide') return this.sendTutorial(chat);
    return this.sendMenu(chat, user);
  }

  menuKeyboard() {
    return [
      [{ text: '📦 خرید یا تمدید اشتراک', callback_data: 'b' }],
      [{ text: '📂 فایل‌های من', callback_data: 'l:0' }, { text: '👤 حساب من', callback_data: 'a' }],
      [{ text: '🎁 کد هدیه', callback_data: 'g' }, { text: '📺 تلویزیون', callback_data: 't' }],
      [{ text: '👥 دعوت دوستان (۵۰۰ مگ هدیه)', callback_data: 'inv' }],
      [{ text: '📲 دریافت اپ تلویزیون', callback_data: 'app' }, { text: '📖 آموزش', callback_data: 'help' }],
      [{ text: '💬 پشتیبانی', callback_data: 'sup' }, { text: '📜 قوانین', callback_data: 'tr' }],
    ];
  }

  sendMenu(chat, user, welcome = false) {
    let head = '';
    if (welcome) {
      head = `👋 سلام ${esc(user.first_name || '')}! به <b>TeleTVShare</b> خوش آمدید.\nهر فایلی (ویدیو، عکس، صوت، سند) اینجا بفرستید، روی تلویزیون شما نمایش داده می‌شود.\n\n`;
      if (user._welcomed) head += `🎁 هدیه عضویت: <b>${PLANS[WELCOME.plan].title} رایگان برای ${faNum(WELCOME.days)} روز</b>!\n\n`;
      head += '📺 اپ TeleTVShare را از دکمه «📲 دریافت اپ تلویزیون» بگیرید، روی تلویزیون نصب کنید و QR روی صفحه را با گوشی اسکن کنید.\n\n';
      if (!user.terms_at && !this.isAdmin(user.id)) head += '📜 قبل از شروع، «قوانین» را بخوانید و بپذیرید.\n\n';
    }
    return this.send(chat, head + this.accountText(user), this.menuKeyboard());
  }

  accountText(user) {
    user = this.user(user.id) || user;
    const lim = this.limits(user);
    const used = this.userUsed(user.id);
    const mu = this.monthUsage(user);
    const lines = [`👤 پلن: <b>${lim.title}</b>`];
    if (user.expires_at && user.plan !== 'free') lines.push(`⏳ اعتبار تا ${fmtDate(user.expires_at, false)}`);
    const bonus = this.isAdmin(user.id) ? 0 : this.bonusBytes(user.id);
    if (bonus) {
      const next = this.one('SELECT MIN(expires_at) AS e FROM bonuses WHERE user_id=? AND expires_at > ?', user.id, Date.now()).e;
      lines.push(`🎁 فضای هدیه دعوت: ${fmtSize(bonus)} (اولین انقضا ${fmtDate(next, false)})`);
    }
    lines.push(`💾 فضا: ${bar(pctOf(used, lim.quota))} ${fmtSize(used)} از ${fmtSize(lim.quota)}`);
    const tv = this.one('SELECT name FROM devices WHERE user_id=?', user.id);
    lines.push(`📺 تلویزیون: ${tv ? 'وصل است' : 'وصل نیست'}`);
    if (user.grace_until) lines.push(`\n⚠️ اشتراک شما تمام شده؛ فایل‌های بیش از ${fmtSize(lim.quota)} تا ${fmtDate(user.grace_until)} پاک می‌شوند مگر اینکه تمدید کنید.`);
    return lines.join('\n');
  }

  usageLine(uid) {
    const u = this.user(uid);
    return `💾 ${fmtSize(this.userUsed(uid))} از ${fmtSize(this.limits(u).quota)}`;
  }

  // ---- plans & payment
  plansText(user) {
    const lines = ['📦 <b>اشتراک‌های TeleTVShare</b>', ''];
    for (const k of SALE) {
      const perGb = Math.round(this.price(k) / (PLANS[k].quota / 1e9) / 100) * 100;
      lines.push(`• <b>${PLANS[k].title}</b> — ${faNum(this.price(k))} تومان در ماه${PLANS[k].badge ? `  ${PLANS[k].badge}` : ''}\n   ↳ هر گیگ فقط ${faNum(perGb)} تومان`);
    }
    lines.push('', '🎁 خرید ۳، ۶ و ۱۲ ماهه تخفیف بیشتری دارد؛ بعد از انتخاب پلن، قیمت هر دوره را می‌بینید.',
      `پلن فعلی شما: ${this.limits(user).title}`);
    return lines.join('\n');
  }

  plansKeyboard(user) {
    const cur = PLAN_ORDER.indexOf(user.plan);
    const active = user.plan !== 'free' && user.expires_at > Date.now();
    const rows = SALE
      .filter((k) => !active || PLAN_ORDER.indexOf(k) >= cur)
      .map((k) => [{
        text: `${k === user.plan && active ? '🔄 تمدید' : PLANS[k].badge ? PLANS[k].badge.split(' ')[0] : '🛒'} ${PLANS[k].title} — ${faNum(this.price(k))} تومان/ماه`,
        callback_data: `B:${k}`,
      }]);
    rows.push([{ text: '🎁 کد هدیه دارم', callback_data: 'g' }]);
    return rows;
  }

  periodText(plan) {
    return [`🛒 اشتراک <b>${PLANS[plan].title}</b>${PLANS[plan].badge ? ` — ${PLANS[plan].badge}` : ''}`, '', 'مدت اشتراک را انتخاب کنید (دوره‌های طولانی‌تر ارزان‌ترند):'].join('\n');
  }

  periodKeyboard(plan) {
    return [
      ...PERIODS.map((n) => {
        const d = this.savedPct(plan, n);
        const total = this.priceFor(plan, n);
        const monthly = n > 1 ? ` (ماهی ${faNum(Math.round(total / n / 100) * 100)})` : '';
        return [{ text: `${PERIOD_TITLE[n]} — ${faNum(total)} تومان${d ? ` · ${faNum(d)}٪ تخفیف` : ''}${monthly}`, callback_data: `BD:${plan}:${n}` }];
      }),
      [{ text: '↩️ پلن‌های دیگر', callback_data: 'b' }],
    ];
  }

  paymentText(plan, months = 1) {
    const full = this.price(plan) * months;
    const total = this.priceFor(plan, months);
    return [
      `🛒 اشتراک <b>${PLANS[plan].title}</b> — ${PERIOD_TITLE[months]}`,
      `💳 مبلغ قابل پرداخت: <b>${faNum(total)} تومان</b>`,
      ...(full > total ? [`<s>${faNum(full)} تومان</s> — ${faNum(full - total)} تومان صرفه‌جویی`] : []),
      '',
      `شماره کارت: <code>${esc(this.setting('card_number'))}</code>`,
      `به نام: ${esc(this.setting('card_name'))} — ${esc(this.setting('card_bank'))}`,
      '',
      '✅ بعد از واریز، <b>عکس رسید</b> را همین‌جا بفرستید.',
      'پس از بررسی (معمولاً چند دقیقه) اشتراک شما فعال می‌شود.',
    ].join('\n');
  }

  async onReceipt(m, user, spec) {
    const [plan, mStr] = spec.split(':');
    const months = PERIODS.includes(Number(mStr)) ? Number(mStr) : 1;
    if (!SALE.includes(plan)) return;
    this.setState(user.id, null);
    const isPhoto = !!m.photo;
    const fileId = isPhoto ? m.photo[m.photo.length - 1].file_id : m.document.file_id;
    this.sql.exec(`INSERT INTO payments(user_id, plan, amount, status, file_id, is_photo, created_at, months)
      VALUES (?,?,?,?,?,?,?,?)`, user.id, plan, this.priceFor(plan, months), 'pending', fileId, isPhoto ? 1 : 0, Date.now(), months);
    const pay = this.one('SELECT * FROM payments WHERE id=last_insert_rowid()');
    await this.sendReceiptToAdmin(pay, user);
    return this.send(m.chat.id, '🧾 رسید دریافت شد. پس از بررسی (معمولاً چند دقیقه) اشتراک شما فعال می‌شود و همین‌جا خبرتان می‌کنم.', null, m.message_id);
  }

  // File ids belong to one bot, so the receipt is downloaded and re-uploaded through the admin bot.
  async sendReceiptToAdmin(pay, user) {
    const caption = this.paymentCaption(pay, user) + '\n\n⏳ در انتظار تأیید';
    const kb = JSON.stringify({ inline_keyboard: [[{ text: '✅ تأیید', callback_data: `pa:${pay.id}` }, { text: '❌ رد', callback_data: `pr:${pay.id}` }]] });
    const form = new FormData();
    form.set('chat_id', String(this.env.OWNER_ID));
    form.set('caption', caption);
    form.set('parse_mode', 'HTML');
    form.set('reply_markup', kb);
    let method = 'sendMessage';
    try {
      const { res } = await this.tgFile(pay.file_id);
      const blob = await res.blob();
      method = pay.is_photo ? 'sendPhoto' : 'sendDocument';
      form.set(pay.is_photo ? 'photo' : 'document', blob, pay.is_photo ? 'receipt.jpg' : 'receipt');
    } catch (e) {
      form.set('text', caption + '\n(دریافت تصویر رسید ممکن نشد)');
    }
    const r = await fetch(`${this.tgBase()}/bot${this.env.ADMIN_BOT_TOKEN}/${method}`, { method: 'POST', body: form });
    const j = await r.json().catch(() => ({}));
    if (j.ok) this.sql.exec('UPDATE payments SET admin_msg_id=? WHERE id=?', j.result.message_id, pay.id);
    else console.log('receipt to admin failed', j.description);
  }

  paymentCaption(pay, user) {
    const who = `${esc(user.first_name || '')}${user.username ? ` (@${esc(user.username)})` : ''}`;
    return [
      `🧾 <b>رسید پرداخت #${pay.id}</b>`,
      `👤 ${who} — <code>${user.id}</code>`,
      `📦 پلن: ${PLANS[pay.plan].title} — ${PERIOD_TITLE[pay.months || 1]}`,
      `💳 مبلغ: ${faNum(pay.amount)} تومان`,
      `🕓 ${fmtDate(pay.created_at)}`,
    ].join('\n');
  }

  // Activate or extend a plan. Returns the new expiry, or false if it would downgrade an active plan.
  activatePlan(uid, plan, days) {
    const u = this.user(uid);
    const now = Date.now();
    const active = u.plan !== 'free' && u.expires_at > now;
    if (active && PLAN_ORDER.indexOf(plan) < PLAN_ORDER.indexOf(u.plan)) return false;
    const base = active && u.plan === plan ? u.expires_at : now;
    const expires = base + days * DAY;
    this.sql.exec('UPDATE users SET plan=?, expires_at=?, grace_until=NULL, reminded=0 WHERE id=?', plan, expires, uid);
    return expires;
  }

  // ---- gift codes
  async redeem(chat, user, raw) {
    const code = String(raw).trim().toUpperCase().replace(/\s+/g, '');
    const g = this.one('SELECT * FROM gift_codes WHERE code=?', code);
    if (!g) return this.send(chat, '❌ این کد هدیه معتبر نیست.', this.menuKeyboard());
    if (g.used >= g.max_uses) return this.send(chat, '❌ ظرفیت استفاده از این کد تمام شده است.', this.menuKeyboard());
    if (this.one('SELECT 1 AS x FROM gift_uses WHERE code=? AND user_id=?', code, user.id)) {
      return this.send(chat, '❌ شما قبلاً از این کد استفاده کرده‌اید.', this.menuKeyboard());
    }
    const exp = this.activatePlan(user.id, g.plan, g.days);
    if (!exp) return this.send(chat, '❌ اشتراک فعلی شما از پلن این کد بزرگ‌تر است. بعد از پایان اشتراک فعلی از کد استفاده کنید.', this.menuKeyboard());
    this.sql.exec('UPDATE gift_codes SET used=used+1 WHERE code=?', code);
    this.sql.exec('INSERT INTO gift_uses(code, user_id, at) VALUES (?,?,?)', code, user.id, Date.now());
    await this.writeManifest(user.id);
    await this.notifyAdmin(`🎁 کد <code>${code}</code> توسط ${esc(user.first_name)} (<code>${user.id}</code>) استفاده شد — ${g.used + 1}/${g.max_uses}`);
    return this.send(chat, `🎉 کد هدیه فعال شد!\nپلن <b>${PLANS[g.plan].title}</b> تا ${fmtDate(exp, false)}\n\n${this.accountText(this.user(user.id))}`, this.menuKeyboard());
  }

  // ---- TV pairing (the TV makes the code and waits for p/<CODE>.json on Arvan)
  async linkTv(chat, user, raw) {
    const code = String(raw).toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (!/^[A-Z0-9]{8}$/.test(code) || [...code].some((c) => !CODE_ABC.includes(c))) {
      return this.send(chat, '❌ کد تلویزیون درست نیست. کد ۸ حرفی روی صفحه تلویزیون را دقیق وارد کنید.', this.menuKeyboard());
    }
    if (this.one('SELECT 1 AS x FROM tv_pairs WHERE code=?', code)) {
      return this.send(chat, '❌ این کد قبلاً استفاده شده. اپ تلویزیون را دوباره باز کنید تا کد جدید بدهد.', this.menuKeyboard());
    }
    const old = this.one('SELECT * FROM devices WHERE user_id=?', user.id);
    if (old) await this.removeDevice(old);
    const token = randomId(40);
    this.sql.exec('INSERT INTO devices(token, user_id, name, created_at) VALUES (?,?,?,?)', token, user.id, 'Android TV', Date.now());
    await this.writeManifest(user.id);
    this.sql.exec('INSERT INTO tv_pairs(code, created_at, user_id) VALUES (?,?,?)', code, Date.now(), user.id);
    await this.putJson(`p/${code}.json`, { manifest: this.publicUrl(`m/${token}.json`), user: user.first_name || '' });
    return this.send(chat, `📺 تلویزیون به حساب شما وصل شد.${old ? '\nتلویزیون قبلی قطع شد.' : ''}\nفایل‌هایی که اینجا می‌فرستید روی تلویزیون نمایش داده می‌شوند.`, this.menuKeyboard());
  }

  async removeDevice(d) {
    this.sql.exec('DELETE FROM devices WHERE token=?', d.token);
    await this.s3del(`m/${d.token}.json`);
    await this.s3del(`r/${d.token}.json`);
    await this.s3del(`d/${d.token}.json`);
  }

  // ---- TV app distribution: the APK lives on Arvan (app/TeleTVShare.apk), sent in Telegram on request
  appInfo() {
    const key = this.meta('app_key');
    return key ? { key, url: this.publicUrl(key), size: Number(this.meta('app_size') || 0), version: this.meta('app_version') || '', at: Number(this.meta('app_at') || 0) } : null;
  }

  installGuide(app) {
    return [
      '📺 <b>نصب اپ TeleTVShare روی تلویزیون اندروید</b>',
      '',
      '<b>روش ۱ — با گوشی (ساده‌ترین)</b>',
      '۱. فایل APK پیام بالا را در تلگرام گوشی دانلود کنید.',
      '۲. برنامه <b>Send Files to TV</b> را روی گوشی و تلویزیون نصب کنید (از Google Play).',
      '۳. فایل را از گوشی به تلویزیون بفرستید.',
      '۴. روی تلویزیون فایل را باز کنید و <b>Install</b> را بزنید.',
      '',
      '<b>روش ۲ — با فلش</b>',
      'فایل APK را روی فلش بریزید، فلش را به تلویزیون بزنید و با یک فایل‌منیجر (مثل File Commander) فایل را باز و نصب کنید.',
      '',
      '<b>اگر خطای نصب داد:</b> در تنظیمات تلویزیون Settings ← Device Preferences ← Security &amp; restrictions ← <b>Unknown sources</b> را برای برنامه‌ای که فایل را با آن باز می‌کنید روشن کنید.',
      '',
      '<b>بعد از نصب:</b> اپ را باز کنید؛ یک QR و کد نشان می‌دهد. QR را با دوربین گوشی اسکن کنید یا کد را در همین بات از «📺 تلویزیون» بفرستید.',
      '',
      'تماشا روی تلویزیون در ایران بدون VPN کار می‌کند.',
    ].join('\n');
  }

  // The APK can be replaced directly on Arvan (e.g. by CI); notice a new version by its ETag.
  async refreshAppInfo() {
    const key = this.meta('app_key') || 'app/TeleTVShare.apk';
    const r = await this.s3().fetch(this.objUrl(key), { method: 'HEAD', headers: { 'x-amz-content-sha256': 'UNSIGNED-PAYLOAD' } }).catch(() => null);
    if (!r?.ok) return;
    const etag = r.headers.get('etag');
    if (etag && etag !== this.meta('app_etag')) {
      this.meta('app_key', key);
      this.meta('app_etag', etag);
      this.meta('app_size', Number(r.headers.get('content-length')) || 0);
      this.meta('app_version', r.headers.get('x-amz-meta-version') || this.meta('app_version'));
      this.meta('app_at', Date.now());
      this.meta('app_file_id', null);
    }
  }

  async sendApp(chat) {
    await this.refreshAppInfo();
    const app = this.appInfo();
    if (!app) return this.send(chat, '📲 اپ تلویزیون TeleTVShare به‌زودی منتشر می‌شود. همین‌جا خبرتان می‌کنیم.', this.menuKeyboard());
    const caption = `📲 <b>TeleTVShare برای تلویزیون اندروید</b>${app.version ? ` — نسخه ${esc(app.version)}` : ''}\n${fmtSize(app.size)} — راهنمای نصب در پیام بعدی 👇`;
    const cached = this.meta('app_file_id');
    let r = await this.tg('sendDocument', { chat_id: chat, document: cached || app.url, caption, parse_mode: 'HTML' });
    if (!r.ok && cached) {
      this.meta('app_file_id', null);
      r = await this.tg('sendDocument', { chat_id: chat, document: app.url, caption, parse_mode: 'HTML' });
    }
    if (!r.ok) {
      // Telegram could not fetch it by URL: upload the file itself.
      const res = await this.s3get(app.key);
      if (res) {
        const form = new FormData();
        form.set('chat_id', String(chat));
        form.set('caption', caption);
        form.set('parse_mode', 'HTML');
        form.set('document', await res.blob(), 'TeleTVShare.apk');
        this.sub = (this.sub || 0) + 1;
        r = await fetch(`${this.tgBase()}/bot${this.env.BOT_TOKEN}/sendDocument`, { method: 'POST', body: form }).then((x) => x.json()).catch(() => ({ ok: false }));
      }
    }
    if (r.ok && r.result?.document?.file_id) this.meta('app_file_id', r.result.document.file_id);
    if (!r.ok) return this.send(chat, '⚠️ ارسال فایل اپ الان ممکن نشد. چند دقیقه بعد دوباره «📲 دریافت اپ تلویزیون» را بزنید.');
    return this.send(chat, this.installGuide(app), [[{ text: '📺 اتصال تلویزیون', callback_data: 't' }]]);
  }

  // Admin sends an .apk to the admin bot -> stored on Arvan and offered to users.
  async publishApp(chat, doc, caption) {
    const A = (t) => this.send(chat, t, null, null, 'admin');
    if (doc.file_size > TG_BOT_MAX) return A('❌ فایل APK باید کمتر از ۲۰ مگابایت باشد.');
    const gf = await this.tg('getFile', { file_id: doc.file_id }, 'admin');
    if (!gf.ok) return A(`❌ دریافت فایل ناموفق بود: ${esc(gf.description)}`);
    const res = await fetch(`${this.tgBase()}/file/bot${this.env.ADMIN_BOT_TOKEN}/${gf.result.file_path}`);
    const buf = await res.arrayBuffer();
    const key = 'app/TeleTVShare.apk';
    await this.s3put(key, buf, {
      type: 'application/vnd.android.package-archive', cache: 'no-cache, max-age=0',
      disposition: 'attachment; filename="TeleTVShare.apk"',
    });
    const version = String(caption || '').trim().slice(0, 20);
    this.meta('app_key', key);
    this.meta('app_size', buf.byteLength);
    this.meta('app_version', version || null);
    this.meta('app_at', Date.now());
    this.meta('app_file_id', null);
    return A(`✅ اپ تلویزیون منتشر شد${version ? ` (نسخه ${esc(version)})` : ''} — ${fmtSize(buf.byteLength)}\nکاربران از دکمه «📲 دریافت اپ تلویزیون» در @${this.env.BOT_USERNAME} آن را می‌گیرند.\nلینک مستقیم: ${esc(this.publicUrl(key))}`);
  }

  // ---- support: user messages go to the admin bot; the admin's reply goes back through the main bot
  async supportStart(chat, user) {
    this.setState(user.id, 'support');
    return this.send(chat, '💬 <b>پشتیبانی TeleTVShare</b>\nسؤال یا مشکل خود را بنویسید (می‌توانید عکس هم بفرستید). پاسخ همین‌جا برایتان می‌آید.',
      [[{ text: '✅ پایان گفتگو', callback_data: 'se_end' }]]);
  }

  // Copy a file sent to one bot into a chat of the other bot (file ids are per bot).
  async relayMedia(fromBot, toBot, chatId, fileId, isPhoto, caption, keyboard) {
    const gf = await this.tg('getFile', { file_id: fileId }, fromBot);
    const form = new FormData();
    form.set('chat_id', String(chatId));
    form.set('caption', caption.slice(0, 1000));
    form.set('parse_mode', 'HTML');
    if (keyboard) form.set('reply_markup', JSON.stringify({ inline_keyboard: keyboard }));
    let method = 'sendMessage';
    if (gf.ok && (gf.result.file_size || 0) <= TG_BOT_MAX) {
      const res = await fetch(`${this.tgBase()}/file/bot${this.token(fromBot)}/${gf.result.file_path}`);
      method = isPhoto ? 'sendPhoto' : 'sendDocument';
      form.set(isPhoto ? 'photo' : 'document', await res.blob(), isPhoto ? 'photo.jpg' : (gf.result.file_path.split('/').pop() || 'file'));
    } else {
      form.set('text', caption + '\n(فایل پیوست قابل انتقال نبود)');
    }
    this.sub = (this.sub || 0) + 1;
    const r = await fetch(`${this.tgBase()}/bot${this.token(toBot)}/${method}`, { method: 'POST', body: form });
    return r.json().catch(() => ({ ok: false }));
  }

  async onSupportMessage(m, user) {
    const who = `${esc(user.first_name || '')}${user.username ? ` @${esc(user.username)}` : ''} — <code>${user.id}</code>`;
    const lim = this.limits(user);
    const head = `💬 <b>پیام پشتیبانی</b>\n👤 ${who}\n📦 ${lim.title}\n\n`;
    const kb = [[{ text: '👤 پروفایل کاربر', callback_data: `uv:${user.id}` }]];
    const body = esc(m.text || m.caption || '');
    let sent;
    if (m.photo || m.document) {
      const fileId = m.photo ? m.photo[m.photo.length - 1].file_id : m.document.file_id;
      sent = await this.relayMedia('main', 'admin', this.env.OWNER_ID, fileId, !!m.photo, head + body, kb);
    } else if (m.text) {
      sent = await this.send(Number(this.env.OWNER_ID), head + body + '\n\n↩️ برای پاسخ، روی همین پیام Reply بزنید.', kb, null, 'admin');
    } else {
      return this.send(m.chat.id, 'فقط متن، عکس یا فایل قابل ارسال است.');
    }
    if (sent?.ok) {
      this.sql.exec('INSERT OR REPLACE INTO support(admin_msg_id, user_id, created_at) VALUES (?,?,?)', sent.result.message_id, user.id, Date.now());
    }
    return this.send(m.chat.id, sent?.ok ? '✅ پیام شما به پشتیبانی رسید. پاسخ همین‌جا می‌آید.' : '❌ ارسال پیام ناموفق بود؛ کمی بعد دوباره امتحان کنید.',
      [[{ text: '✅ پایان گفتگو', callback_data: 'se_end' }]], m.message_id);
  }

  // Admin replied (Telegram "Reply") to a support message in the admin bot.
  async onSupportReply(m) {
    const row = this.one('SELECT * FROM support WHERE admin_msg_id=?', m.reply_to_message.message_id);
    if (!row) return false;
    const head = '💬 <b>پاسخ پشتیبانی</b>\n\n';
    const kb = [[{ text: '💬 ادامه گفتگو', callback_data: 'sup' }]];
    let r;
    if (m.photo || m.document) {
      const fileId = m.photo ? m.photo[m.photo.length - 1].file_id : m.document.file_id;
      r = await this.relayMedia('admin', 'main', row.user_id, fileId, !!m.photo, head + esc(m.caption || ''), kb);
    } else {
      r = await this.send(row.user_id, head + esc(m.text || ''), kb);
    }
    if (r?.ok) this.sql.exec('UPDATE support SET answered_at=? WHERE admin_msg_id=?', Date.now(), row.admin_msg_id);
    await this.send(m.chat.id, r?.ok ? '✅ پاسخ برای کاربر فرستاده شد.' : `❌ ارسال نشد: ${esc(r?.description || 'خطا')}`, null, m.message_id, 'admin');
    return true;
  }

  // ================================================================ downloads from links (video sites)
  // Flow: user sends a URL -> status link_probe -> helper lists qualities (POST /helper/formats)
  // -> link_choose: user picks a quality -> link_download -> helper downloads + uploads to Arvan.
  blockedSite(host) {
    const h = host.toLowerCase().replace(/^www\./, '');
    return BLOCKED_SITES.some((d) => h === d || h.endsWith('.' + d) || h.includes(d.split('.')[0] + '.'));
  }

  async addLink(m, user, raw) {
    let url;
    try { url = new URL(raw); } catch { return this.send(m.chat.id, '❌ این لینک معتبر نیست.', null, m.message_id); }
    if (!/^https?:$/.test(url.protocol)) return this.send(m.chat.id, '❌ این لینک معتبر نیست.', null, m.message_id);
    // The owner has no site restrictions (his own choice); other users can't send links at all.
    const owner = this.isAdmin(user.id);
    if (!owner && /(^|\.)(youtube\.com|youtu\.be|youtube-nocookie\.com)$/i.test(url.hostname)) {
      return this.send(m.chat.id, '⚠️ دانلود از یوتیوب فعلاً پشتیبانی نمی‌شود. می‌توانید خود فایل ویدیو را در تلگرام بفرستید.', null, m.message_id);
    }
    if (!owner && this.blockedSite(url.hostname)) {
      return this.send(m.chat.id, '⛔️ دانلود از این سایت پشتیبانی نمی‌شود.', null, m.message_id);
    }
    const lim = this.limits(user);
    if (!owner && (this.freeFor(user) < 1e6 || this.monthUsage(user).up >= lim.upCap)) {
      return this.send(m.chat.id, '⚠️ فضای کافی ندارید. فایل‌های قدیمی را از «📂 فایل‌های من» پاک کنید یا اشتراک بگیرید.',
        [[{ text: '📦 خرید فضای بیشتر', callback_data: 'b' }]], m.message_id);
    }
    const id = randomId();
    const uniq = this.normUrl(url.href);
    const old = this.findSaved(user.id, uniq);
    if (owner) {
      this.sql.exec(`INSERT INTO files(id,name,mime,size,kind,status,chat_id,created_at,owner,storage,source_url,uniq)
        VALUES (?,?,?,?,?,?,?,?,?,'arvan',?,?)`, id, url.hostname, 'video/mp4', 0, 'video', old ? 'dup_pending' : 'store_pending', m.chat.id, Date.now(), user.id, url.href, uniq);
      if (old) return this.warnDuplicate(m.chat.id, m.message_id, id, old);
      const s = await this.send(m.chat.id, `🔗 <code>${esc(short(url.href, 60))}</code>\nکجا ذخیره شود؟\n${this.freeLine(user)}`,
        this.storeKb(id), m.message_id);
      if (s.ok) this.sql.exec('UPDATE files SET msg_id=? WHERE id=?', s.result.message_id, id);
      return;
    }
    this.sql.exec(`INSERT INTO files(id,name,mime,size,kind,status,chat_id,created_at,owner,storage,source_url)
      VALUES (?,?,?,?,?,?,?,?,?,'arvan',?)`, id, url.hostname, 'video/mp4', 0, 'video', 'link_probe', m.chat.id, Date.now(), user.id, url.href);
    const sent = await this.send(m.chat.id, `🔎 در حال بررسی لینک…\n<code>${esc(short(url.href, 60))}</code>\nکیفیت‌های موجود تا حدود یک دقیقه دیگر نمایش داده می‌شود.`,
      [[{ text: '❌ لغو', callback_data: `c:${id}` }]], m.message_id);
    if (sent.ok) this.sql.exec('UPDATE files SET msg_id=? WHERE id=?', sent.result.message_id, id);
    await this.wakeHelper();
  }

  // Helper reports the qualities of a link.
  async helperFormats(req, id) {
    const f = this.one(`SELECT * FROM files WHERE id=? AND status='link_probe'`, id);
    if (!f) return new Response('no such job', { status: 404 });
    if (!this.holdLease(req, id)) return new Response('taken by another helper', { status: 409 });
    this.sql.exec('UPDATE files SET lease_by=NULL, lease_until=NULL WHERE id=?', id);
    const info = await req.json();
    const formats = (info.formats || []).slice(0, 8);
    if (!formats.length) {
      this.sql.exec(`UPDATE files SET status='failed', error=? WHERE id=?`, 'no formats', id);
      await this.edit(f.chat_id, f.msg_id, '❌ ویدیویی در این لینک پیدا نشد یا قابل دانلود نیست.');
      return Response.json({ ok: true });
    }
    const title = cleanName(info.title || f.name).slice(0, 120);
    this.sql.exec(`UPDATE files SET status='link_choose', name=?, duration=?, formats=? WHERE id=?`,
      title, Math.round(info.duration || 0) || null, JSON.stringify({ thumbnail: info.thumbnail || null, formats }), id);
    await this.showQualities(this.one('SELECT * FROM files WHERE id=?', id));
    return Response.json({ ok: true });
  }

  async showQualities(f) {
    const user = this.user(f.owner);
    const free = f.storage === 'cf' ? this.cfFree() : f.storage === 'vps' ? this.vpsFree() : this.freeFor(user);
    const { formats } = JSON.parse(f.formats || '{"formats":[]}');
    const kb = formats.map((q, i) => {
      const fits = !q.size || q.size <= free;
      return [{ text: `${q.audio ? '🎵' : '🎬'} ${q.label}${q.size ? ` — ${fmtSize(q.size)}` : ''}${fits ? '' : ' ⚠️'}`, callback_data: `lq:${f.id}:${i}` }];
    });
    kb.push([{ text: '❌ لغو', callback_data: `c:${f.id}` }]);
    const dur = f.duration ? `⏱ ${Math.floor(f.duration / 60)}:${String(f.duration % 60).padStart(2, '0')}\n` : '';
    await this.edit(f.chat_id, f.msg_id, `🎬 <b>${esc(f.name)}</b>\n${dur}\nکیفیت دانلود را انتخاب کنید:\n<i>فضای آزاد شما: ${fmtSize(free)}</i>`, kb);
  }

  async chooseQuality(cb, user, id, idx) {
    const answer = (text, alert = false) => this.tg('answerCallbackQuery', { callback_query_id: cb.id, text, show_alert: alert });
    const f = this.one(`SELECT * FROM files WHERE id=? AND status='link_choose' AND owner=?`, id, user.id);
    if (!f) return answer('این درخواست منقضی شده است');
    const q = JSON.parse(f.formats).formats[Number(idx)];
    if (!q) return answer();
    const size = q.size || 0;
    if (f.storage === 'cf') {
      if (size > this.cfFree()) return answer(`فضای Cloudflare کافی نیست (${fmtSize(size)} لازم است، آزاد: ${fmtSize(this.cfFree())}).`, true);
    } else if (f.storage === 'vps') {
      if (size > this.vpsFree()) return answer(`فضای VPS کافی نیست (${fmtSize(size)} لازم است، آزاد: ${fmtSize(this.vpsFree())}).`, true);
    } else {
      if (size > this.freeFor(user)) return answer(`فضای کافی ندارید (${fmtSize(size)} لازم است). فایل‌های قدیمی را پاک کنید یا اشتراک بگیرید.`, true);
      if (this.monthUsage(user).up + size > this.limits(user).upCap) return answer('به سقف مصرف منصفانه آپلود این ماه رسیده‌اید.', true);
    }
    const ext = q.audio ? 'm4a' : 'mp4';
    this.sql.exec(`UPDATE files SET status='link_download', fmt=?, size=?, kind=?, mime=?, obj_key=? WHERE id=?`,
      JSON.stringify(q), size, q.audio ? 'audio' : 'video', q.audio ? 'audio/mp4' : 'video/mp4', `f/${id}/${cleanName(f.name)}.${ext}`, id);
    await this.edit(f.chat_id, f.msg_id, `⏳ <b>${esc(f.name)}</b> — ${esc(q.label)}${f.storage === 'cf' ? ' · ☁️ Cloudflare' : ''}\nدر حال دانلود و انتقال به تلویزیون…`, [[{ text: '❌ لغو', callback_data: `c:${id}` }]]);
    await this.wakeHelper();
    return answer('دانلود شروع شد');
  }

  tutorialText() {
    const links = this.setting('links') === '1';
    return [
      '📖 <b>آموزش TeleTVShare</b>',
      '',
      '<b>۱. نصب اپ روی تلویزیون</b>',
      'دکمه «📲 دریافت اپ تلویزیون» را بزنید و طبق راهنما نصب کنید. اپ در ایران بدون VPN کار می‌کند.',
      '',
      '<b>۲. اتصال تلویزیون به حساب</b>',
      'اپ را باز کنید؛ یک QR و یک کد ۸ حرفی نشان می‌دهد. QR را با دوربین گوشی اسکن کنید و Start را بزنید، یا کد را از «📺 تلویزیون» همین‌جا بفرستید. هر حساب روی یک تلویزیون فعال است.',
      '',
      '<b>۳. فرستادن فایل</b>',
      `هر ویدیو، عکس، آهنگ یا فایلی را اینجا بفرستید یا Forward کنید؛ چند ثانیه بعد روی تلویزیون است. فایل‌های بزرگ (تا ۲ گیگابایت) کمی بیشتر طول می‌کشند.`,
      '',
      ...(links ? ['<b>۴. دانلود از سایت‌های ویدیو 🔗</b>',
      'کافی است لینک ویدیو را بفرستید؛ کیفیت‌های موجود با حجمشان نمایش داده می‌شود، یکی را انتخاب کنید تا دانلود شود و روی تلویزیون بدون VPN ببینید.',
      'سایت‌های پشتیبانی‌شده: اینستاگرام، پست‌های عمومی تلگرام، پینترست، دیلی‌موشن، توییچ، ساندکلاد، TED، بیلی‌بیلی، VK، OK.ru، Kick، Coub، Imgur، Streamable، آرشیو اینترنت و لینک مستقیم فایل‌های ویدیو و صوت.',
      ''] : []),
      `<b>${links ? '۵' : '۴'}. مدیریت فایل‌ها</b>`,
      'از «📂 فایل‌های من» فایل‌ها را ببینید و پاک کنید. با پاک کردن، از تلویزیون هم حذف می‌شوند.',
      '',
      `<b>${links ? '۶' : '۵'}. اشتراک</b>`,
      'از «📦 خرید یا تمدید اشتراک» پلن و مدت را انتخاب کنید، مبلغ را کارت‌به‌کارت کنید و عکس رسید را بفرستید. اگر کد هدیه دارید، از «🎁 کد هدیه» وارد کنید.',
      '',
      `<b>🎁 دعوت دوستان:</b> از «👥 دعوت دوستان» لینک خودتان را بگیرید؛ هر دوستی که عضو شود ${fmtSize(REF_BONUS)} فضا برای ${faNum(REF_DAYS)} روز هدیه می‌گیرید.`,
      '',
      'قوانین استفاده را از «📜 قوانین» ببینید. سؤالی بود؟ «💬 پشتیبانی» را بزنید.',
    ].join('\n');
  }

  sendTutorial(chat) {
    return this.send(chat, this.tutorialText(), [
      [{ text: '📲 دریافت اپ تلویزیون', callback_data: 'app' }, { text: '📺 اتصال تلویزیون', callback_data: 't' }],
      [{ text: '💬 پشتیبانی', callback_data: 'sup' }],
    ]);
  }

  // ---- terms of use (must be accepted before the first upload)
  termsText() {
    return [
      '📜 <b>قوانین استفاده از TeleTVShare</b>',
      '',
      '۱. این سرویس برای نگهداری و تماشای <b>فایل‌های شخصی</b> شما روی تلویزیون خودتان است.',
      '۲. ارسال یا دانلود محتوایی که <b>حق نشر</b> آن متعلق به دیگران است (فیلم، سریال، موسیقی، کتاب و…) بدون اجازه صاحب اثر ممنوع است.',
      '۳. ارسال محتوای مستهجن، غیراخلاقی، خشونت‌آمیز، توهین‌آمیز یا هر محتوای خلاف قوانین جمهوری اسلامی ایران ممنوع است.',
      '۴. مسئولیت همه فایل‌ها و لینک‌هایی که ارسال می‌کنید با خود شماست.',
      '۵. در صورت تخلف، فایل‌ها بدون اطلاع قبلی حذف و حساب مسدود می‌شود و مبلغ اشتراک بازگردانده نمی‌شود.',
      '۶. هر حساب فقط روی یک تلویزیون فعال است و واگذاری یا فروش حساب به دیگران مجاز نیست.',
      '۷. پس از پایان اشتراک، فایل‌های بیشتر از فضای رایگان ۲۴ ساعت بعد پاک می‌شوند.',
      '۸. حداکثر حجم هر فایل ارسالی در تلگرام ۲ گیگابایت است و مصرف منصفانه برای همه پلن‌ها برقرار است.',
      '۹. TeleTVShare می‌تواند این قوانین را به‌روز کند؛ ادامه استفاده یعنی پذیرش قوانین جدید.',
    ].join('\n');
  }

  sendTerms(chat, user, askAccept) {
    const kb = askAccept && !user.terms_at ? [[{ text: '✅ قوانین را می‌پذیرم', callback_data: 'ta' }]] : null;
    return this.send(chat, this.termsText() + (kb ? '\n\nبرای استفاده از سرویس، قوانین را بپذیرید.' : ''), kb);
  }

  // Returns true if the user still has to accept the terms (and asks them to).
  async needsTerms(m, user) {
    if (user.terms_at || this.isAdmin(user.id)) return false;
    await this.send(m.chat.id, this.termsText() + '\n\n⚠️ قبل از ارسال اولین فایل، لطفاً قوانین را بپذیرید و دوباره فایل یا لینک را بفرستید.',
      [[{ text: '✅ قوانین را می‌پذیرم', callback_data: 'ta' }]], m.message_id);
    return true;
  }

  // ================================================================ referrals
  // A new user who joins through someone's link and accepts the rules earns the inviter
  // REF_BONUS of extra space for REF_DAYS. Bonuses stack; each one expires on its own.
  refCode(uid) {
    let u = this.user(uid);
    if (!u.ref_code) {
      let code;
      do code = randomId(8, 'abcdefghjkmnpqrstuvwxyz23456789'); while (this.one('SELECT 1 AS x FROM users WHERE ref_code=?', code));
      this.sql.exec('UPDATE users SET ref_code=? WHERE id=?', code, uid);
      u = this.user(uid);
    }
    return u.ref_code;
  }

  refLink(uid) { return `https://t.me/${this.env.BOT_USERNAME}?start=ref_${this.refCode(uid)}`; }

  bonusBytes(uid) {
    return this.one('SELECT COALESCE(SUM(bytes),0) AS s FROM bonuses WHERE user_id=? AND expires_at > ?', uid, Date.now()).s;
  }

  // Called from /start ref_<code> for brand-new users only.
  noteReferral(user, code) {
    const inviter = this.one('SELECT id FROM users WHERE ref_code=?', String(code).toLowerCase());
    if (!inviter || inviter.id === user.id || !user._welcomed) return;
    this.sql.exec('UPDATE users SET referred_by=? WHERE id=? AND referred_by IS NULL', inviter.id, user.id);
  }

  // Called when the invited user accepts the rules.
  async rewardReferral(user) {
    const u = this.user(user.id);
    if (!u.referred_by || u.ref_rewarded) return;
    this.sql.exec('UPDATE users SET ref_rewarded=1 WHERE id=?', u.id);
    const inviter = this.user(u.referred_by);
    if (!inviter || inviter.banned) return;
    const monthAgo = Date.now() - 30 * DAY;
    const recent = this.one('SELECT COUNT(*) AS c FROM bonuses WHERE user_id=? AND created_at > ?', inviter.id, monthAgo).c;
    if (recent >= REF_MAX_PER_MONTH) {
      await this.send(inviter.id, `👥 ${esc(u.first_name || 'یک دوست')} با لینک شما عضو شد. سقف هدیه دعوت این ماه (${faNum(REF_MAX_PER_MONTH)} نفر) پر شده است.`);
      return;
    }
    const exp = Date.now() + REF_DAYS * DAY;
    this.sql.exec('INSERT INTO bonuses(user_id, bytes, expires_at, created_at, from_user) VALUES (?,?,?,?,?)', inviter.id, REF_BONUS, exp, Date.now(), u.id);
    if (inviter.grace_until && this.userUsed(inviter.id) <= this.limits(this.user(inviter.id)).quota) {
      this.sql.exec('UPDATE users SET grace_until=NULL WHERE id=?', inviter.id);
    }
    await this.writeManifest(inviter.id);
    await this.send(inviter.id, `🎉 ${esc(u.first_name || 'یک دوست')} با لینک دعوت شما عضو شد!\n<b>${fmtSize(REF_BONUS)} فضای هدیه</b> تا ${fmtDate(exp, false)} به حساب شما اضافه شد.\n\n${this.accountText(this.user(inviter.id))}`, this.menuKeyboard());
  }

  inviteView(user) {
    const link = this.refLink(user.id);
    const invited = this.one('SELECT COUNT(*) AS c FROM users WHERE referred_by=? AND ref_rewarded=1', user.id).c;
    const bonus = this.bonusBytes(user.id);
    const text = [
      '👥 <b>دعوت دوستان</b>',
      '',
      `هر دوستی که با لینک شما عضو شود و قوانین را بپذیرد، <b>${fmtSize(REF_BONUS)} فضای اضافه برای ${faNum(REF_DAYS)} روز</b> هدیه می‌گیرید. هدیه‌ها روی هم جمع می‌شوند.`,
      '',
      `🔗 لینک دعوت شما:\n<code>${esc(link)}</code>`,
      '',
      `👤 دعوت‌های موفق: ${faNum(invited)}`,
      `🎁 فضای هدیه فعال: ${fmtSize(bonus)}`,
      `(حداکثر ${faNum(REF_MAX_PER_MONTH)} هدیه در ماه)`,
    ].join('\n');
    const share = `https://t.me/share/url?url=${encodeURIComponent(link)}&text=${encodeURIComponent('فایل‌هات رو از تلگرام بفرست، روی تلویزیون ببین! با این لینک عضو شو و ۵۰۰ مگ هدیه بگیر 🎁')}`;
    return { text, kb: [[{ text: '📤 ارسال لینک برای دوستان', url: share }]] };
  }

  // Expired bonuses can leave a user over quota: give them the usual 24h grace.
  async expireBonuses() {
    const now = Date.now();
    for (const b of this.q('SELECT DISTINCT user_id FROM bonuses WHERE expires_at <= ? AND done=0 LIMIT 20', now)) {
      if (this.budget() < 8) return true;
      this.sql.exec('UPDATE bonuses SET done=1 WHERE user_id=? AND expires_at <= ?', b.user_id, now);
      const u = this.user(b.user_id);
      if (!u) continue;
      await this.writeManifest(u.id);
      const quota = this.limits(u).quota;
      if (this.userUsed(u.id) > quota && !u.grace_until) {
        this.sql.exec('UPDATE users SET grace_until=? WHERE id=?', now + GRACE_MS, u.id);
        await this.send(u.id, `⏳ فضای هدیه دعوت شما تمام شد. فایل‌های بیشتر از ${fmtSize(quota)} <b>۲۴ ساعت دیگر</b> (از قدیمی‌ترین) پاک می‌شوند؛ برای جلوگیری، دوستان بیشتری دعوت کنید یا اشتراک بگیرید.`,
          [[{ text: '👥 دعوت دوستان', callback_data: 'inv' }], [{ text: '📦 خرید اشتراک', callback_data: 'b' }]]);
      }
    }
    return false;
  }

  // ---- per-user rate limit (in memory; the admin is exempt)
  rateLimited(uid) {
    if (this.isAdmin(uid)) return false;
    this.rl ||= new Map();
    const now = Date.now(), min = Math.floor(now / 60_000), day = Math.floor(now / DAY);
    let r = this.rl.get(uid);
    if (!r || r.day !== day) r = { min, m: 0, day, d: 0, warned: 0 };
    if (r.min !== min) { r.min = min; r.m = 0; }
    r.m++; r.d++;
    this.rl.set(uid, r);
    if (this.rl.size > 5000) this.rl.clear();
    return r.m > RATE_PER_MIN || r.d > RATE_PER_DAY ? r : false;
  }

  // ---- daily private backup of the database to Arvan (backup/db-YYYY-MM-DD.json, kept 14 days)
  async dailyBackup() {
    const day = new Date(Date.now() + 3.5 * 3600e3).toISOString().slice(0, 10);
    if (this.meta('last_backup') === day) return;
    const dump = {
      at: Date.now(),
      users: this.q('SELECT * FROM users'),
      payments: this.q('SELECT * FROM payments'),
      gift_codes: this.q('SELECT * FROM gift_codes'),
      gift_uses: this.q('SELECT * FROM gift_uses'),
      bonuses: this.q('SELECT * FROM bonuses'),
      devices: this.q('SELECT * FROM devices'),
      welcomed: this.q('SELECT * FROM welcomed'),
      files: this.q('SELECT id,name,mime,size,kind,status,owner,created_at,obj_key,thumb_key,duration,width,height,source_url FROM files'),
      meta: this.q("SELECT * FROM meta WHERE key LIKE 'set_%' OR key LIKE 'app_%'"),
    };
    await this.s3put(`backup/db-${day}.json`, JSON.stringify(dump), { type: 'application/json', acl: null });
    const old = new Date(Date.now() + 3.5 * 3600e3 - 14 * DAY).toISOString().slice(0, 10);
    await this.s3del(`backup/db-${old}.json`);
    this.meta('last_backup', day);
  }

  // ---- the bucket must never be publicly listable (files are public one by one)
  // ---- deleting from the TV. The TV can only reach Arvan, so it PUTs {"ids":[...]} to a presigned
  // d/<token>.json (link in its manifest). Each alarm tick lists d/ (one request) and handles them.
  async tvDeletes() {
    const r = await this.s3().fetch(`${this.env.ARVAN_ENDPOINT}/${this.env.ARVAN_BUCKET}?list-type=2&prefix=d/&max-keys=20`,
      { headers: { 'x-amz-content-sha256': 'UNSIGNED-PAYLOAD' } }).catch(() => null);
    if (!r || !r.ok) return;
    const keys = [...(await r.text()).matchAll(/<Key>(d\/[A-Za-z0-9]+\.json)<\/Key>/g)].map((m) => m[1]);
    for (const key of keys) {
      if (this.budget() < 12) return;
      const token = key.slice(2, -5);
      const d = this.one('SELECT * FROM devices WHERE token=?', token);
      let ids = [];
      if (d) {
        try { ids = ((await (await this.s3get(key))?.json())?.ids || []).filter((x) => /^[A-Za-z0-9]{16}$/.test(x)); } catch { ids = []; }
      }
      const files = d && ids.length
        ? this.q(`SELECT id,name,obj_key,thumb_key,storage FROM files WHERE owner=? AND id IN (${ids.slice(0, 50).map(() => '?').join(',')})`, d.user_id, ...ids.slice(0, 50))
        : [];
      const now = files.slice(0, 8);   // 2 Arvan requests per file; the rest next minute
      for (const f of now) {
        if (f.storage === 'vps') this.sql.exec('INSERT OR IGNORE INTO vps_del(id, at) VALUES (?,?)', f.id, Date.now());
        this.sql.exec('DELETE FROM chunks WHERE file_id=?', f.id);
        this.sql.exec('DELETE FROM files WHERE id=?', f.id);
        await this.s3del(f.obj_key);
        await this.s3del(f.thumb_key);
      }
      const rest = files.slice(8).map((f) => f.id);
      if (rest.length) await this.putJson(key, { ids: rest }, 'private');
      else await this.s3del(key);
      if (now.length) {
        await this.writeManifest(d.user_id);
        const names = now.map((f) => `• ${esc(short(f.name, 40))}`).join('\n');
        const u = this.user(d.user_id);
        if (u) await this.send(d.user_id, `🗑 از روی تلویزیون پاک شد:\n${names}\n\n${this.usageLine(d.user_id)}`);
      }
    }
  }

  // ---- owner only: third storage on the VPS disk (5 GB). The VPS has no open port: it reaches the
  // internet through a Cloudflare quick tunnel (outbound only) and tells us the tunnel name when it
  // checks in. The TV asks this Worker; we redirect it to the tunnel with a link that expires.
  vpsUsed() { return this.one(`SELECT COALESCE(SUM(size),0) AS s FROM files WHERE storage='vps' AND status IN ${ACTIVE}`).s; }
  vpsFree() { return Math.max(0, VPS_CAP - this.vpsUsed()); }

  async vpsSig(id, exp) {
    const key = await crypto.subtle.importKey('raw', enc.encode(this.env.HELPER_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(`${id}:${exp}`)));
    return [...mac].map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 32);
  }

  // Permanent link signatures for the owner's own domain (kind: v = VPS file, c = Cloudflare file, t = thumbnail).
  async linkSig(kind, id) { return this.vpsSig(kind, id); }
  ownDomain() { return /^https:\/\/[a-z0-9.-]+$/i.test(this.env.VPS_PUBLIC || '') ? this.env.VPS_PUBLIC : null; }
  async ownLink(f, kind) {
    const name = encodeURIComponent(cleanName(f.name));
    const path = kind === 't' ? `/t/${f.id}` : `/${kind}/${f.id}/${name}`;
    return `${this.ownDomain()}${path}?sig=${await this.linkSig(kind, f.id)}`;
  }

  async serveVps(f) {
    if (this.ownDomain()) return Response.redirect(await this.ownLink(f, 'v'), 302);
    const host = this.meta('vps_tunnel');
    if (!host || !this.vpsAlive()) return new Response('VPS is offline', { status: 503, headers: { 'retry-after': '60' } });
    const exp = Math.floor(Date.now() / 1000) + 6 * 3600;
    const sig = await this.vpsSig(f.id, exp);
    return Response.redirect(`https://${host}/v/${f.id}/${encodeURIComponent(cleanName(f.name))}?exp=${exp}&sig=${sig}`, 302);
  }

  async bucketWatchdog() {
    const r = await fetch(`${this.env.ARVAN_PUBLIC_URL}/?max-keys=1`, { headers: { 'user-agent': 'teletvshare-watchdog' } }).catch(() => null);
    if (!r || r.status !== 200) return;
    const fix = await this.s3().fetch(`${this.env.ARVAN_ENDPOINT}/${this.env.ARVAN_BUCKET}?acl`, {
      method: 'PUT', headers: { 'x-amz-acl': 'private', 'x-amz-content-sha256': 'UNSIGNED-PAYLOAD' },
    }).catch(() => null);
    await this.notifyAdmin(`🚨 سطل آروان عمومی شده بود (فهرست همه فایل‌ها برای همه قابل دیدن بود). ${fix?.ok ? 'خودکار دوباره خصوصی شد ✅' : 'خصوصی کردن خودکار ناموفق بود ❌ لطفاً در پنل آروان آن را «خصوصی» کنید.'}\nفایل‌ها برای پخش لازم نیست سطل عمومی باشد.`);
  }

  // ---- owner only: put a link on the TV without downloading it ("stream from the site")

  // ---- owner only: two storages. Every save asks: Cloudflare (chunks in this Durable Object) or Arvan.
  cfFree() { return Math.max(0, CF_CAP - this.ctx.storage.sql.databaseSize); }
  cfUrl(f) { return `${this.env.PUBLIC_URL}/f/${f.id}/${encodeURIComponent(cleanName(f.name))}`; }
  storeKb(id) {
    return [
      [{ text: '☁️ Cloudflare', callback_data: `sc:${id}:cf` }, { text: '🖥 VPS', callback_data: `sc:${id}:vps` }, { text: '🇮🇷 آروان', callback_data: `sc:${id}:ar` }],
      [{ text: '❌ لغو', callback_data: `c:${id}` }],
    ];
  }

  async storeChoice(cb, user, id, target) {
    const answer = (text, alert = false) => this.tg('answerCallbackQuery', { callback_query_id: cb.id, text, show_alert: alert });
    const f = this.one(`SELECT * FROM files WHERE id=? AND status='store_pending' AND owner=?`, id, user.id);
    if (!f) return answer('این درخواست منقضی شده است');
    const cf = target === 'cf';
    const vps = target === 'vps';
    const storage = cf ? 'cf' : vps ? 'vps' : 'arvan';
    const label = cf ? '☁️ Cloudflare' : vps ? '🖥 VPS' : '🇮🇷 آروان';
    if (cf && f.size > this.cfFree()) return answer(`فضای Cloudflare کافی نیست (آزاد: ${fmtSize(this.cfFree())}).`, true);
    if (vps && f.size > this.vpsFree()) return answer(`فضای VPS کافی نیست (آزاد: ${fmtSize(this.vpsFree())}).`, true);
    if (vps && !this.vpsAlive()) return answer('VPS الان در دسترس نیست. Cloudflare یا آروان را انتخاب کنید.', true);
    if (vps && !this.ownDomain() && !this.meta('vps_tunnel')) return answer('فضای VPS هنوز راه‌اندازی نشده (تونل روی سرور نصب نیست). Cloudflare یا آروان را انتخاب کنید.', true);
    if (f.source_url) {
      this.sql.exec(`UPDATE files SET status='link_probe', storage=? WHERE id=?`, storage, id);
      await this.edit(f.chat_id, f.msg_id, `🔎 در حال بررسی لینک… (${label})\nکیفیت‌های موجود تا حدود یک دقیقه دیگر نمایش داده می‌شود.`, [[{ text: '❌ لغو', callback_data: `c:${id}` }]]);
      await this.wakeHelper();
      return answer();
    }
    // VPS files always go through the VPS helper (it writes them to its own disk)
    const st = vps ? 'waiting_helper' : !cf && f.size > this.freeFor(user) ? 'waiting_space' : f.size > TG_BOT_MAX ? 'waiting_helper' : 'queued';
    this.sql.exec(`UPDATE files SET status=?, storage=?, obj_key=? WHERE id=?`, st, storage, storage === 'arvan' ? this.fileKey(f) : null, id);
    await this.afterStatus(id);
    return answer(label);
  }

  // Write a whole buffer into chunks (Telegram files, max 20 MB).
  writeChunks(id, buf, first = 0) {
    const bytes = new Uint8Array(buf);
    let idx = first;
    for (let o = 0; o < bytes.length; o += CHUNK) {
      this.sql.exec('INSERT OR REPLACE INTO chunks(file_id, idx, data) VALUES (?,?,?)', id, idx++, bytes.slice(o, o + CHUNK).buffer);
    }
    return idx;
  }

  // Helper uploads a downloaded file in parts: PUT /helper/upload/<id>?offset=N (N a multiple of CHUNK).
  async helperUpload(req, url, id) {
    const f = this.one(`SELECT * FROM files WHERE id=? AND storage='cf' AND status IN ('link_download','helper_uploading','waiting_helper')`, id);
    if (!f) return new Response('no such job', { status: 404 });
    if (!this.holdLease(req, id)) return new Response('taken by another helper', { status: 409 });
    const offset = Number(url.searchParams.get('offset') || 0);
    if (!Number.isInteger(offset) || offset < 0 || offset % CHUNK) return new Response('bad offset', { status: 400 });
    const len = Number(req.headers.get('content-length') || 0);
    if (len > this.cfFree()) return new Response('Cloudflare storage full', { status: 507 });
    let idx = offset / CHUNK;
    this.sql.exec('DELETE FROM chunks WHERE file_id=? AND idx>=?', id, idx);
    const reader = req.body.getReader();
    let buf = new Uint8Array(CHUNK), fill = 0, total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      let o = 0;
      while (o < value.length) {
        const n = Math.min(CHUNK - fill, value.length - o);
        buf.set(value.subarray(o, o + n), fill);
        fill += n; o += n; total += n;
        if (fill === CHUNK) {
          this.sql.exec('INSERT INTO chunks(file_id, idx, data) VALUES (?,?,?)', id, idx++, buf.buffer);
          buf = new Uint8Array(CHUNK); fill = 0;
        }
      }
    }
    if (fill) this.sql.exec('INSERT INTO chunks(file_id, idx, data) VALUES (?,?,?)', id, idx++, buf.slice(0, fill).buffer);
    this.sql.exec(`UPDATE files SET status='helper_uploading' WHERE id=?`, id);
    return Response.json({ ok: true, received: total });
  }

  async helperThumb(req, id) {
    const f = this.one(`SELECT id FROM files WHERE id=? AND storage IN ('cf','vps') AND status IN ('link_download','helper_uploading','waiting_helper')`, id);
    if (!f) return new Response('no such job', { status: 404 });
    if (!this.holdLease(req, id)) return new Response('taken by another helper', { status: 409 });
    const buf = await req.arrayBuffer();
    if (!buf.byteLength || buf.byteLength > 1_000_000) return new Response('bad thumb', { status: 400 });
    this.sql.exec('UPDATE files SET thumb=? WHERE id=?', buf, id);
    return Response.json({ ok: true });
  }

  cfSize(id) { return this.one('SELECT COALESCE(SUM(length(data)),0) AS s FROM chunks WHERE file_id=?', id).s; }

  serveThumb(id) {
    const f = this.one(`SELECT thumb FROM files WHERE id=? AND status='ready'`, id);
    if (!f || !f.thumb) return new Response('Not found', { status: 404 });
    return new Response(f.thumb, { headers: { 'content-type': 'image/jpeg', 'cache-control': 'public, max-age=604800' } });
  }

  // Files kept in this Durable Object (Cloudflare storage, and the old single-user ones), with Range support.
  async serveFile(req, id) {
    const f = this.one(`SELECT id,name,mime,size,status,storage,obj_key FROM files WHERE id=?`, id);
    if (!f || f.status !== 'ready') return new Response('File not found', { status: 404 });
    if (f.storage === 'arvan') return Response.redirect(this.publicUrl(f.obj_key), 302);
    if (f.storage === 'vps') return this.serveVps(f);
    if (f.storage !== 'cf' && f.storage !== 'do') return new Response('Not available', { status: 404 });
    const size = f.size;
    let start = 0, end = size - 1, status = 200;
    const range = req.headers.get('range');
    const m = range && /^bytes=(\d*)-(\d*)$/.exec(range.trim());
    if (m && (m[1] || m[2])) {
      if (m[1]) { start = Number(m[1]); if (m[2]) end = Math.min(Number(m[2]), size - 1); }
      else { start = Math.max(0, size - Number(m[2])); }
      if (start > end || start >= size) {
        return new Response(null, { status: 416, headers: { 'content-range': `bytes */${size}` } });
      }
      status = 206;
    }
    const headers = {
      'content-type': f.mime || guessMime(f.name), 'accept-ranges': 'bytes', 'content-length': String(end - start + 1),
      'content-disposition': this.disposition(f.name), 'cache-control': 'private, max-age=3600',
    };
    if (status === 206) headers['content-range'] = `bytes ${start}-${end}/${size}`;
    if (req.method === 'HEAD') return new Response(null, { status, headers });
    const sql = this.sql;
    let idx = Math.floor(start / CHUNK), pos = start;
    const stream = new ReadableStream({
      pull(ctrl) {
        if (pos > end) return ctrl.close();
        const row = sql.exec('SELECT data FROM chunks WHERE file_id=? AND idx=?', id, idx).toArray()[0];
        if (!row) return ctrl.error(new Error('missing chunk'));
        const data = new Uint8Array(row.data);
        const base = idx * CHUNK;
        const from = pos - base, to = Math.min(data.length, end - base + 1);
        ctrl.enqueue(data.slice(from, to));
        pos = base + to; idx++;
      },
    }, { highWaterMark: 0 });
    return new Response(stream, { status, headers });
  }

  // ---- helpers: the always-on VPS ("vps") does the heavy jobs; GitHub Actions ("gh") is the fallback.
  // A helper claims a job before working on it (lease); progress keeps the lease alive. A job whose
  // lease runs out (helper died) can be claimed again by any helper.
  // Timings; T_<NAME> vars exist only in local tests (.dev.vars), production uses the constants.
  tm(name) { return Number(this.env['T_' + name]) || { VPS_ALIVE, VPS_DOWN_ALERT, LEASE, HANDOFF }[name]; }
  helperName(req) { return (req.headers.get('x-helper') || 'gh').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 10) || 'gh'; }
  vpsAlive() { return Date.now() - Number(this.meta('vps_seen') || 0) < this.tm('VPS_ALIVE'); }

  async vpsSeen() {
    this.meta('vps_seen', Date.now());
    if (this.meta('vps_down')) {
      this.meta('vps_down', null);
      await this.notifyAdmin('✅ VPS دوباره وصل شد و کارهای سنگین را خودش انجام می‌دهد.');
    }
  }

  // The caller holds (or may take) this job's lease. Extends it.
  holdLease(req, id) {
    const who = this.helperName(req);
    const f = this.one('SELECT lease_by, lease_until FROM files WHERE id=?', id);
    if (!f) return false;
    if (f.lease_by && f.lease_by !== who && Number(f.lease_until) > Date.now()) return false;
    this.sql.exec('UPDATE files SET lease_by=?, lease_until=? WHERE id=?', who, Date.now() + this.tm('LEASE'), id);
    return true;
  }

  helperClaim(req, id) {
    const f = this.one(`SELECT id FROM files WHERE id=? AND status IN ${HELPER_ST}`, id);
    if (!f) return new Response('no such job', { status: 404 });
    if (!this.holdLease(req, id)) return new Response('taken by another helper', { status: 409 });
    return Response.json({ ok: true, lease_ms: this.tm('LEASE') });
  }

  async soonAlarm(ms) {
    const a = await this.ctx.storage.getAlarm();
    if (!a || a > Date.now() + ms) await this.ctx.storage.setAlarm(Date.now() + ms);
  }

  // Runs from the alarm: hands unclaimed jobs to GitHub when the VPS doesn't take them, and tells the
  // owner when the VPS stops or starts checking in.
  async helperWatch() {
    const now = Date.now();
    const seen = Number(this.meta('vps_seen') || 0);
    if (seen && now - seen > this.tm('VPS_DOWN_ALERT') && !this.meta('vps_down')) {
      this.meta('vps_down', 1);
      await this.notifyAdmin('⚠️ VPS بیش از ۳ دقیقه است جواب نمی‌دهد. فایل‌های بزرگ خودکار با GitHub منتقل می‌شوند تا VPS برگردد.');
    }
    const open = this.one(`SELECT COUNT(*) AS c FROM files WHERE status IN ${HELPER_ST} AND storage <> 'vps' AND (lease_until IS NULL OR lease_until < ?)`, now).c;
    if (!open) { this.meta('open_since', null); return; }
    const since = Number(this.meta('open_since') || 0) || now;
    this.meta('open_since', since);
    const wait = this.vpsAlive() ? 15 * 60_000 : this.tm('HANDOFF');
    if (now - since >= wait && now - Number(this.meta('gh_woke') || 0) > 4 * 60_000) await this.wakeHelper(true);
  }

  helperStatus() {
    return {
      vps_seen: Number(this.meta('vps_seen') || 0) || null, vps_alive: this.vpsAlive(), vps_down: !!this.meta('vps_down'),
      gh_woke: Number(this.meta('gh_woke') || 0) || null, open_since: Number(this.meta('open_since') || 0) || null,
      vps_tunnel: !!this.meta('vps_tunnel'), vps_used: this.vpsUsed(), vps_free: this.vpsFree(),
      jobs: this.q(`SELECT id,status,lease_by,lease_until FROM files WHERE status IN ${HELPER_ST}`),
    };
  }

  tvStatus(user) {
    const d = this.one('SELECT * FROM devices WHERE user_id=?', user.id);
    if (!d) {
      return {
        text: '📺 هیچ تلویزیونی به حساب شما وصل نیست.\n\nاپ TeleTVShare را روی تلویزیون باز کنید؛ یک کد ۸ حرفی و QR نشان می‌دهد. QR را با دوربین گوشی اسکن کنید یا کد را همین‌جا بفرستید.\n\nهر حساب فقط روی یک تلویزیون کار می‌کند.',
        kb: [[{ text: '🔢 وارد کردن کد تلویزیون', callback_data: 'tc' }], [{ text: '📲 دریافت اپ و راهنمای نصب', callback_data: 'app' }]],
      };
    }
    return {
      text: `📺 یک تلویزیون از ${fmtDate(d.created_at)} به حساب شما وصل است.\nبا وصل کردن تلویزیون دیگر، این یکی خودکار قطع می‌شود.`,
      kb: [[{ text: '🔌 قطع این تلویزیون', callback_data: 'tu' }], [{ text: '🔢 وصل کردن تلویزیون دیگر', callback_data: 'tc' }]],
    };
  }

  sendTvStatus(chat, user) {
    const v = this.tvStatus(user);
    return this.send(chat, v.text, v.kb);
  }

  // Rewrite the paired TV's manifest (file list, plan, viewing cap, report URL).
  async writeManifest(uid) {
    const d = this.one('SELECT * FROM devices WHERE user_id=?', uid);
    if (!d) return;
    const u = this.user(uid);
    const lim = this.limits(u);
    const mu = this.monthUsage(u);
    const files = this.q(`SELECT id,name,mime,size,kind,width,height,duration,created_at,obj_key,thumb_key,storage,source_url,thumb IS NOT NULL AS has_thumb
      FROM files WHERE owner=? AND status='ready' AND storage IN ('arvan','remote','cf','vps') ORDER BY created_at DESC`, uid);
    const manifest = {
      v: 1,
      updated_at: Date.now(),
      user: { name: u.first_name || '', plan: lim.title, expires_at: u.plan !== 'free' ? u.expires_at : null },
      used: this.userUsed(uid),
      quota: Number.isFinite(lim.quota) ? lim.quota : null,
      // the owner's three storages, for the usage chart on his TV
      stores: this.isAdmin(uid) ? [
        { key: 'arvan', used: this.userUsed(uid), cap: null },
        { key: 'cf', used: Math.max(0, CF_CAP - this.cfFree()), cap: CF_CAP },
        { key: 'vps', used: this.vpsUsed(), cap: VPS_CAP },
      ] : undefined,
      watch: {
        month: monthKey(), used: mu.watch,
        cap: Number.isFinite(lim.watchCap) ? lim.watchCap : null,
        blocked: Number.isFinite(lim.watchCap) && mu.watch >= lim.watchCap,
      },
      report_url: await this.presignPut(`r/${d.token}.json`),
      delete_url: await this.presignPut(`d/${d.token}.json`),
      files: [],
    };
    // The owner's Cloudflare and VPS files go through the owner's own domain on the VPS (not filtered in
    // Iran, so no VPN needed); without that domain they use the Worker address.
    const own = this.isAdmin(uid) && this.ownDomain();
    for (const f of files) {
      const mine = f.storage === 'cf' || f.storage === 'vps';
      manifest.files.push({
        id: f.id, name: f.name, mime: f.mime, size: f.size, kind: f.kind,
        width: f.width, height: f.height, duration: f.duration, created_at: f.created_at,
        url: f.storage === 'remote' ? f.source_url
          : mine ? (own ? await this.ownLink(f, f.storage === 'vps' ? 'v' : 'c') : this.cfUrl(f))
          : this.publicUrl(f.obj_key),
        thumb: mine ? (f.has_thumb ? (own ? await this.ownLink(f, 't') : `${this.env.PUBLIC_URL}/t/${f.id}`) : null)
          : f.thumb_key ? this.publicUrl(f.thumb_key) : null,
      });
    }
    await this.putJson(`m/${d.token}.json`, manifest);
    this.sql.exec('UPDATE devices SET manifest_at=? WHERE token=?', Date.now(), d.token);
  }

  // ---- files
  async addFile(m, user, media) {
    const lim = this.limits(user);
    const kb = [[{ text: '📦 ارتقای اشتراک', callback_data: 'b' }]];
    if (media.size > TG_MAX) {
      return this.send(m.chat.id, `⚠️ حداکثر حجم هر فایل <b>۲ گیگابایت</b> است و این فایل ${fmtSize(media.size)} است.`, null, m.message_id);
    }
    if (media.size > lim.quota) {
      return this.send(m.chat.id, `❌ این فایل (${fmtSize(media.size)}) از کل فضای پلن شما (${fmtSize(lim.quota)}) بزرگ‌تر است.`, kb, m.message_id);
    }
    const mu = this.monthUsage(user);
    if (mu.up + media.size > lim.upCap) {
      return this.send(m.chat.id, '⚠️ به سقف <b>مصرف منصفانه</b> آپلود این ماه رسیده‌اید. از اول ماه بعد یا با ارتقای اشتراک می‌توانید دوباره فایل بفرستید.', kb, m.message_id);
    }
    const id = randomId();
    const owner = this.isAdmin(user.id);
    // Users' files are saved one at a time: while one is being saved, the next ones wait their turn.
    // (Decided right before the insert, with no await in between, so files arriving together queue up.)
    const waiting = !owner && (this.userBusy(user.id) || this.one(`SELECT 1 AS x FROM files WHERE owner=? AND status='turn_wait' LIMIT 1`, user.id));
    const uniq = media.uniqueId ? `tg:${media.uniqueId}` : null;
    const old = this.findSaved(user.id, uniq);
    const status = old ? 'dup_pending' : owner ? 'store_pending' : waiting ? 'turn_wait' : this.saveStatus(user, media.size);
    this.sql.exec(`INSERT INTO files(id,name,mime,size,kind,status,tg_file_id,thumb_file_id,width,height,duration,chat_id,created_at,owner,storage)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,'arvan')`,
      id, media.name, media.mime, media.size, media.kind, status, media.fileId, media.thumbId,
      media.width, media.height, media.duration, m.chat.id, Date.now(), user.id);
    this.sql.exec('UPDATE files SET obj_key=?, uniq=? WHERE id=?', this.fileKey({ id, name: media.name }), uniq, id);
    if (old) {
      this.sql.exec('UPDATE files SET src_msg_id=? WHERE id=?', m.message_id, id);
      return this.warnDuplicate(m.chat.id, m.message_id, id, old);
    }
    const sent = owner
      ? await this.send(m.chat.id, `📥 <b>${esc(media.name)}</b> (${fmtSize(media.size)})\nکجا ذخیره شود؟\n${this.freeLine(user)}`, this.storeKb(id), m.message_id)
      : await this.send(m.chat.id, `⏳ <b>${esc(media.name)}</b> (${fmtSize(media.size)})`, null, m.message_id);
    if (sent.ok) this.sql.exec('UPDATE files SET msg_id=? WHERE id=?', sent.result.message_id, id);
    this.sql.exec('UPDATE files SET src_msg_id=? WHERE id=?', m.message_id, id);
    await this.afterStatus(id);
  }

  // ---- users' files are saved one at a time: extra files wait their turn ('turn_wait'); the owner has no queue.
  userBusy(uid) {
    return this.one(`SELECT id FROM files WHERE owner=? AND status IN ${BUSY_ST} LIMIT 1`, uid);
  }

  saveStatus(u, size) {
    return size > this.freeFor(u) ? 'waiting_space' : size > TG_BOT_MAX ? 'waiting_helper' : 'queued';
  }

  // Start the user's next waiting file once nothing of theirs is being saved.
  async promoteTurn(uid) {
    if (!uid || this.isAdmin(uid) || this.userBusy(uid)) return;
    const next = this.one(`SELECT id,size FROM files WHERE owner=? AND status='turn_wait' ORDER BY created_at LIMIT 1`, uid);
    if (!next) return;
    this.sql.exec('UPDATE files SET status=? WHERE id=?', this.saveStatus(this.user(uid), next.size), next.id);
    await this.afterStatus(next.id);
  }

  // ---- repeats: every file keeps a fingerprint (Telegram's unique file id, or the normalized link).
  // Sending the same file/link again warns that it's already there; "save again" is still possible.
  normUrl(href) {
    try {
      const u = new URL(href);
      u.hash = '';
      for (const k of [...u.searchParams.keys()]) if (/^(utm_|fbclid|gclid|si$|feature$)/i.test(k)) u.searchParams.delete(k);
      return `url:${u.hostname.toLowerCase().replace(/^www\./, '')}${u.pathname.replace(/\/+$/, '')}${u.search}`;
    } catch { return null; }
  }

  findSaved(uid, uniq) {
    if (!uniq) return null;
    const live = `status NOT IN ('failed','dup_pending')`;
    const f = this.one(`SELECT * FROM files WHERE owner=? AND uniq=? AND ${live} ORDER BY created_at LIMIT 1`, uid, uniq);
    if (f || !uniq.startsWith('url:')) return f;
    // links saved before fingerprints existed
    return this.q(`SELECT * FROM files WHERE owner=? AND uniq IS NULL AND source_url IS NOT NULL AND ${live}`, uid)
      .find((x) => this.normUrl(x.source_url) === uniq) || null;
  }

  storageLabel(s) { return s === 'cf' ? '☁️ Cloudflare' : s === 'vps' ? '🖥 VPS' : '🇮🇷 آروان'; }

  async warnDuplicate(chat, replyTo, id, old) {
    const where = old.status === 'ready'
      ? `ذخیره شده در ${this.storageLabel(old.storage)} — ${fmtDate(old.created_at)}`
      : 'همین الان در حال ذخیره است';
    const link = old.source_url ? `\n🔗 <code>${esc(short(old.source_url, 70))}</code>` : '';
    const s = await this.send(chat, `⚠️ این ${old.source_url ? 'لینک' : 'فایل'} قبلاً ذخیره شده و موجود است:\n<b>${esc(short(old.name, 60))}</b> (${fmtSize(old.size)})\n${where}${link}`,
      [[{ text: '💾 دوباره ذخیره کن', callback_data: `dy:${id}` }, { text: '❌ نه، لازم نیست', callback_data: `c:${id}` }]], replyTo);
    if (s.ok) this.sql.exec('UPDATE files SET msg_id=? WHERE id=?', s.result.message_id, id);
  }

  // "Save again": continue exactly as if it had been new.
  async dupProceed(cb, user, id) {
    const answer = (text) => this.tg('answerCallbackQuery', { callback_query_id: cb.id, text });
    const f = this.one(`SELECT * FROM files WHERE id=? AND status='dup_pending' AND owner=?`, id, user.id);
    if (!f) return answer('این درخواست منقضی شده است');
    const owner = this.isAdmin(user.id);
    if (owner || f.source_url) {
      this.sql.exec(`UPDATE files SET status='store_pending', created_at=? WHERE id=?`, Date.now(), id);
      await this.edit(f.chat_id, f.msg_id, `${f.source_url ? `🔗 <code>${esc(short(f.source_url, 60))}</code>` : `📥 <b>${esc(f.name)}</b> (${fmtSize(f.size)})`}\nکجا ذخیره شود؟\n${this.freeLine(user)}`, this.storeKb(id));
      return answer();
    }
    const waiting = this.userBusy(user.id) || this.one(`SELECT 1 AS x FROM files WHERE owner=? AND status='turn_wait' LIMIT 1`, user.id);
    this.sql.exec('UPDATE files SET status=?, created_at=? WHERE id=?', waiting ? 'turn_wait' : this.saveStatus(user, f.size), Date.now(), id);
    await this.afterStatus(id);
    return answer();
  }

  freeLine(user) {
    return `<i>☁️ Cloudflare آزاد: ${fmtSize(this.cfFree())} — 🖥 VPS آزاد: ${fmtSize(this.vpsFree())} — 🇮🇷 آروان آزاد: ${fmtSize(this.freeFor(user))}</i>`;
  }

  async afterStatus(id) {
    const f = this.one('SELECT * FROM files WHERE id=?', id);
    if (!f) return;
    const title = `<b>${esc(f.name)}</b> (${fmtSize(f.size)})`;
    if (f.status === 'turn_wait') {
      const ahead = this.one(`SELECT COUNT(*) AS c FROM files WHERE owner=? AND status='turn_wait' AND created_at < ?`, f.owner, f.created_at).c;
      await this.edit(f.chat_id, f.msg_id, `🕓 ${title}\nدر نوبت${ahead ? ` (${faNum(ahead)} فایل جلوتر)` : ''}: بعد از فایل قبلی شما خودکار ذخیره می‌شود.`,
        [[{ text: '❌ لغو', callback_data: `c:${id}` }]]);
    } else if (f.status === 'queued') {
      await this.edit(f.chat_id, f.msg_id, `⏳ ${title}\nدر حال ذخیره…`);
      await this.ctx.storage.setAlarm(Date.now() + 50);
    } else if (f.status === 'waiting_helper') {
      const vps = this.vpsAlive();
      const woke = await this.wakeHelper();
      await this.edit(f.chat_id, f.msg_id, vps
        ? `⏳ ${title}\nفایل بزرگ است؛ انتقال آن تا چند ثانیه دیگر شروع می‌شود.`
        : woke
        ? `⏳ ${title}\nفایل بزرگ است؛ انتقال آن تا حدود یک دقیقه دیگر شروع می‌شود.`
        : `🕓 ${title}\nفایل در صف انتقال است و به‌زودی ذخیره می‌شود.`,
        [[{ text: '❌ لغو', callback_data: `c:${id}` }]]);
    } else if (f.status === 'waiting_space') {
      await this.showSpacePicker(f, 0);
    }
  }

  async wakeHelper(force = false) {
    await this.soonAlarm(60_000);
    if (!force && this.vpsAlive()) return true;
    this.meta('gh_woke', Date.now());
    if (!this.env.GITHUB_TOKEN || !this.env.GITHUB_REPO) return false;
    const r = await fetch(`https://api.github.com/repos/${this.env.GITHUB_REPO}/dispatches`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.env.GITHUB_TOKEN}`, accept: 'application/vnd.github+json',
        'user-agent': 'teletvshare-worker', 'content-type': 'application/json',
      },
      body: JSON.stringify({ event_type: 'large-file' }),
    }).catch((e) => ({ ok: false, status: String(e) }));
    if (!r.ok) console.log('github dispatch failed', r.status);
    return r.ok;
  }

  async showSpacePicker(pending, page) {
    const user = this.user(pending.owner);
    const lim = this.limits(user);
    const free = this.freeFor(user);
    const rows = this.q(`SELECT id,name,size,created_at FROM files WHERE status='ready' AND owner=?
      ORDER BY created_at ASC LIMIT ? OFFSET ?`, pending.owner, PAGE + 1, page * PAGE);
    const kb = rows.slice(0, PAGE).map((f) => [{
      text: `🗑 ${short(f.name, 22)} · ${fmtSize(f.size)} · ${fmtDate(f.created_at, false)}`,
      callback_data: `x:${f.id}:${pending.id}`,
    }]);
    const nav = [];
    if (page > 0) nav.push({ text: '« قدیمی‌تر', callback_data: `q:${pending.id}:${page - 1}` });
    if (rows.length > PAGE) nav.push({ text: 'جدیدتر »', callback_data: `q:${pending.id}:${page + 1}` });
    if (nav.length) kb.push(nav);
    kb.push([{ text: '📦 خرید فضای بیشتر', callback_data: 'b' }]);
    kb.push([{ text: '❌ لغو این فایل', callback_data: `c:${pending.id}` }]);
    const text = [
      '⚠️ <b>فضا کافی نیست</b>',
      `فایل: <b>${esc(pending.name)}</b> (${fmtSize(pending.size)})`,
      `فضای آزاد: ${fmtSize(free)} از ${fmtSize(lim.quota)} — باید ${fmtSize(pending.size - free)} دیگر آزاد شود.`,
      '',
      rows.length ? 'فایل‌های قدیمی شما (قدیمی‌ترین اول). روی هر کدام بزنید تا پاک شود:' : 'برای ذخیره این فایل، فضای بیشتری بخرید.',
    ].join('\n');
    await this.edit(pending.chat_id, pending.msg_id, text, kb);
  }

  listView(uid, page) {
    const total = this.one(`SELECT COUNT(*) AS c FROM files WHERE status='ready' AND owner=?`, uid).c;
    const rows = this.q(`SELECT id,name,size,created_at,CASE WHEN storage='remote' THEN 'remote' ELSE kind END AS kind, storage FROM files WHERE status='ready' AND owner=?
      ORDER BY created_at DESC LIMIT ? OFFSET ?`, uid, PAGE, page * PAGE);
    if (!total) return { text: `📭 هنوز فایلی ندارید. هر فایلی بفرستید اینجا و روی تلویزیون نمایش داده می‌شود.\n\n${this.usageLine(uid)}`, kb: null };
    const icon = { video: '🎬', image: '🖼', audio: '🎵', file: '📄', remote: '🌐' };
    const lines = rows.map((f, i) =>
      `${page * PAGE + i + 1}. ${icon[f.kind] || '📄'}${f.storage === 'cf' ? '☁️' : f.storage === 'vps' ? '🖥' : ''} ${esc(short(f.name, 40))}\n     ${fmtSize(f.size)} · ${fmtDate(f.created_at)}`);
    const kb = [];
    for (let i = 0; i < rows.length; i += 4) {
      kb.push(rows.slice(i, i + 4).map((f, j) => ({ text: `🗑 ${page * PAGE + i + j + 1}`, callback_data: `d:${f.id}:${page}` })));
    }
    const pages = Math.ceil(total / PAGE);
    const nav = [];
    if (page > 0) nav.push({ text: '« جدیدتر', callback_data: `L:${page - 1}` });
    if (page < pages - 1) nav.push({ text: 'قدیمی‌تر »', callback_data: `L:${page + 1}` });
    if (nav.length) kb.push(nav);
    return { text: `📂 <b>فایل‌های شما</b> (صفحه ${page + 1} از ${pages})\n\n${lines.join('\n')}\n\n${this.usageLine(uid)}`, kb };
  }

  sendList(chat, uid, page) {
    const v = this.listView(uid, page);
    return this.send(chat, v.text, v.kb);
  }

  canTouch(uid, fileId) {
    const f = this.one('SELECT owner FROM files WHERE id=?', fileId);
    return f && String(f.owner) === String(uid);
  }

  async onCallback(cb) {
    const chatId = cb.message?.chat?.id, msgId = cb.message?.message_id;
    const answer = (text, alert = false) => this.tg('answerCallbackQuery', { callback_query_id: cb.id, text, show_alert: alert });
    if (this.rateLimited(cb.from?.id)) return answer('⏳ کمی صبر کنید', false);
    const user = this.touchUser(cb.from);
    if (user.banned) return answer('⛔️ حساب شما مسدود است', true);
    const [op, a, b] = String(cb.data || '').split(':');

    switch (op) {
      case 'home': {
        if (user.state) this.setState(user.id, null);
        await this.edit(chatId, msgId, this.accountText(user), this.menuKeyboard());
        return answer();
      }
      case 'a': await this.send(chatId, this.accountText(user), this.menuKeyboard()); return answer();
      case 'b': await this.send(chatId, this.plansText(user), this.plansKeyboard(user)); return answer();
      case 'B': {
        if (!SALE.includes(a)) return answer();
        await this.send(chatId, this.periodText(a), this.periodKeyboard(a));
        return answer();
      }
      case 'BD': {
        const months = Number(b);
        if (!SALE.includes(a) || !PERIODS.includes(months)) return answer();
        this.setState(user.id, `receipt:${a}:${months}`);
        await this.edit(chatId, msgId, this.paymentText(a, months), [[{ text: '❌ انصراف', callback_data: 'bc' }]]);
        return answer();
      }
      case 'bc': this.setState(user.id, null); await this.edit(chatId, msgId, 'خرید لغو شد.', this.menuKeyboard()); return answer();
      case 'g': this.setState(user.id, 'gift'); await this.send(chatId, '🎁 کد هدیه را بفرستید:'); return answer();
      case 't': { const v = this.tvStatus(user); await this.send(chatId, v.text, v.kb); return answer(); }
      case 'app': await this.sendApp(chatId); return answer();
      case 'help': await this.sendTutorial(chatId); return answer();
      case 'tr': await this.sendTerms(chatId, user, true); return answer();
      case 'inv': { const v = this.inviteView(user); await this.send(chatId, v.text, v.kb); return answer(); }
      case 'ta': {
        if (!user.terms_at) {
          this.sql.exec('UPDATE users SET terms_at=? WHERE id=?', Date.now(), user.id);
          await this.rewardReferral(user);
        }
        await this.edit(chatId, msgId, '✅ قوانین پذیرفته شد. حالا می‌توانید فایل یا لینک ویدیو بفرستید.', this.menuKeyboard());
        return answer('پذیرفته شد');
      }
      case 'lq': return this.chooseQuality(cb, user, a, b);
      case 'dy': return this.dupProceed(cb, user, a);
      case 'sc': return this.isAdmin(user.id) && (b === 'cf' || b === 'ar' || b === 'vps') ? this.storeChoice(cb, user, a, b) : answer();
      case 'sup': await this.supportStart(chatId, user); return answer();
      case 'se_end': this.setState(user.id, null); await this.send(chatId, 'گفتگو با پشتیبانی بسته شد. هر وقت سؤالی داشتید، دوباره «💬 پشتیبانی» را بزنید.', this.menuKeyboard()); return answer();
      case 'tc': this.setState(user.id, 'tv'); await this.send(chatId, '🔢 کد ۸ حرفی که روی صفحه تلویزیون است را بفرستید:'); return answer();
      case 'tu': {
        const d = this.one('SELECT * FROM devices WHERE user_id=?', user.id);
        if (d) await this.removeDevice(d);
        const v = this.tvStatus(user);
        await this.edit(chatId, msgId, v.text, v.kb);
        return answer('تلویزیون قطع شد');
      }
      case 'l': { const v = this.listView(user.id, Number(a) || 0); await this.send(chatId, v.text, v.kb); return answer(); }
      case 'L': { const v = this.listView(user.id, Number(a) || 0); await this.edit(chatId, msgId, v.text, v.kb); return answer(); }
      case 'd': {
        if (!this.canTouch(user.id, a)) return answer('این فایل دیگر وجود ندارد');
        const f = this.one('SELECT id,name,size FROM files WHERE id=?', a);
        await this.edit(chatId, msgId, `🗑 این فایل پاک شود؟\n<b>${esc(f.name)}</b> (${fmtSize(f.size)})\n\nاز تلویزیون هم حذف می‌شود.`, [[
          { text: '✅ بله، پاک کن', callback_data: `D:${a}:${b}` }, { text: '↩️ برگشت', callback_data: `L:${b}` },
        ]]);
        return answer();
      }
      case 'D': {
        if (this.canTouch(user.id, a)) await this.deleteFile(a);
        const v = this.listView(user.id, Number(b) || 0);
        await this.edit(chatId, msgId, v.text, v.kb);
        return answer('پاک شد');
      }
      case 'q': {
        const p = this.one(`SELECT * FROM files WHERE id=? AND status='waiting_space'`, a);
        if (p && this.canTouch(user.id, a)) await this.showSpacePicker(p, Number(b) || 0);
        return answer();
      }
      case 'x': {
        if (!this.canTouch(user.id, a)) return answer('این فایل دیگر وجود ندارد');
        const f = this.one('SELECT id,name,size,created_at FROM files WHERE id=?', a);
        await this.edit(chatId, msgId, `🗑 این فایل پاک شود؟\n<b>${esc(f.name)}</b> (${fmtSize(f.size)})\nآپلود: ${fmtDate(f.created_at)}`, [[
          { text: '✅ بله، پاک کن', callback_data: `X:${a}:${b}` }, { text: '↩️ برگشت', callback_data: `q:${b}:0` },
        ]]);
        return answer();
      }
      case 'X': {
        if (this.canTouch(user.id, a)) await this.deleteFile(a);
        const p = this.one(`SELECT * FROM files WHERE id=? AND status='waiting_space'`, b);
        if (!p) return answer('پاک شد');
        if (p.size <= this.freeFor(this.user(p.owner))) {
          this.sql.exec('UPDATE files SET status=? WHERE id=?', p.size > TG_BOT_MAX ? 'waiting_helper' : 'queued', p.id);
          await answer('پاک شد — فضا کافی است');
          return this.afterStatus(p.id);
        }
        await this.showSpacePicker(p, 0);
        return answer('پاک شد');
      }
      case 'c': {
        const p = this.one('SELECT * FROM files WHERE id=?', a);
        if (p && p.status !== 'ready' && this.canTouch(user.id, a)) {
          await this.deleteFile(a);
          await this.edit(chatId, msgId, `❌ <b>${esc(p.name)}</b> لغو شد.`);
        }
        return answer('لغو شد');
      }
      case 'r': {
        const p = this.one(`SELECT * FROM files WHERE id=? AND status='failed'`, a);
        if (p && this.canTouch(user.id, a)) {
          const st = !this.isAdmin(p.owner) && this.userBusy(p.owner) ? 'turn_wait' : this.saveStatus(this.user(p.owner), p.size);
          this.sql.exec('UPDATE files SET status=?, error=NULL WHERE id=?', st, a);
          await this.afterStatus(a);
        }
        return answer();
      }
    }
    return answer();
  }

  // ================================================================ admin bot
  async onAdminUpdate(u) {
    if (u.update_id != null && !this.seenOnce('a' + u.update_id)) return;
    const from = u.message?.from || u.callback_query?.from;
    if (!from || !this.isAdmin(from.id)) return; // silent for everyone else
    if (u.callback_query) return this.onAdminCallback(u.callback_query);
    const m = u.message;
    const chat = m.chat.id;
    if (m.reply_to_message && await this.onSupportReply(m)) return;
    if (m.document && /\.apk$/i.test(m.document.file_name || '')) return this.publishApp(chat, m.document, m.caption);
    const text = (m.text || '').trim();
    const cmd = /^\/(\w+)(?:@\w+)?\s*(.*)$/s.exec(text);
    const state = this.meta('admin_state');
    if (!cmd && state) {
      this.meta('admin_state', null);
      if (state.startsWith('gift:')) return this.giftCustom(chat, state.slice(5), text);
      return this.applySetting(chat, state, text);
    }
    if (cmd) this.meta('admin_state', null);
    const [name, arg] = cmd ? [cmd[1].toLowerCase(), cmd[2].trim()] : ['start', ''];
    const A = (t, kb) => this.send(chat, t, kb, null, 'admin');

    if (name === 'start' || name === 'menu' || name === 'stats' || name === 'admin') return A(this.adminStats(), this.adminMenu());
    if (name === 'users') { const v = this.adminUsersView(0); return A(v.text, v.kb); }
    if (name === 'user') {
      const id = Number(arg.replace('@', '')) || this.one('SELECT id FROM users WHERE username=?', arg.replace('@', ''))?.id;
      if (!id || !this.user(id)) return A('کاربر پیدا نشد. مثال: <code>/user 123456789</code> یا <code>/user @username</code>');
      const v = this.adminUserView(id);
      return A(v.text, v.kb);
    }
    if (name === 'gift' || name === 'newgift') { this.giftWiz({}); return this.giftStep(chat); }
    if (name === 'giftcmd') {
      const [planArg, daysArg, usesArg] = arg.split(/\s+/);
      const plan = PLAN_ALIAS[String(planArg || '').toLowerCase()];
      if (!plan) return A(this.giftHelp());
      const days = Math.max(1, Math.min(365, Number(daysArg) || 30));
      const uses = Math.max(1, Math.min(10000, Number(usesArg) || 1));
      const code = giftCode();
      this.sql.exec('INSERT INTO gift_codes(code, plan, days, max_uses, created_at) VALUES (?,?,?,?,?)', code, plan, days, uses, Date.now());
      return A([
        `🎁 کد هدیه ساخته شد: <code>${code}</code>`,
        `${PLANS[plan].title} — ${faNum(days)} روز — ${faNum(uses)} بار استفاده`,
        '', 'لینک فعال‌سازی مستقیم:', `https://t.me/${this.env.BOT_USERNAME}?start=gift_${code}`,
      ].join('\n'));
    }
    if (name === 'gifts') return A(this.giftsText(), [[{ text: '➕ کد جدید', callback_data: 'gh' }]]);
    if (name === 'delgift') { this.sql.exec('DELETE FROM gift_codes WHERE code=?', arg.toUpperCase()); return A('کد حذف شد.'); }
    if (name === 'payments' || name === 'receipts') return A(this.paymentsText(), this.pendingKeyboard());
    if (name === 'settings') return A(this.settingsText(), this.settingsKeyboard());
    if (name === 'unpublishapp') {
      const app = this.appInfo();
      if (app) await this.s3del(app.key);
      for (const k of ['app_key', 'app_size', 'app_version', 'app_at', 'app_file_id']) this.meta(k, null);
      return A('اپ تلویزیون از دسترس خارج شد.');
    }
    return A(this.adminHelp(), this.adminMenu());
  }

  adminMenu() {
    return [
      [{ text: '🧾 رسیدها', callback_data: 'ap' }, { text: '👥 کاربران', callback_data: 'U:0' }],
      [{ text: '➕ ساخت کد هدیه', callback_data: 'gw' }, { text: '🎁 کدهای هدیه', callback_data: 'ag' }],
      [{ text: '⚙️ تنظیمات', callback_data: 'as' }],
      [{ text: '📊 آمار', callback_data: 'am' }],
    ];
  }

  adminHelp() {
    return [
      '🛠 <b>بات مدیریت TeleTVShare</b>',
      '/stats — آمار', '/users — کاربران', '/user شناسه یا @username — مدیریت کاربر',
      '/payments — رسیدها', '/gift — ساخت کد هدیه (مرحله‌به‌مرحله)', '/gifts — کدها', '/delgift کد — حذف کد',
      '/settings — شماره کارت، قیمت‌ها و سقف‌ها',
    ].join('\n');
  }

  // ---- gift code wizard (admin bot): plan -> days -> uses per code -> number of codes -> confirm
  giftWiz(v) {
    if (v === undefined) {
      try { return JSON.parse(this.meta('gift_wiz') || '{}'); } catch { return {}; }
    }
    this.meta('gift_wiz', v ? JSON.stringify(v) : null);
  }

  async giftStep(chat, msgId) {
    const w = this.giftWiz();
    const cancel = [{ text: '❌ لغو', callback_data: 'gn' }];
    const nums = (prefix, list, unit) => [
      list.map((n) => ({ text: `${faNum(n)}${unit}`, callback_data: `${prefix}:${n}` })),
      [{ text: '✏️ عدد دلخواه', callback_data: `${prefix}:x` }],
      cancel,
    ];
    let text, kb;
    if (!w.plan) {
      text = '🎁 <b>ساخت کد هدیه</b>\n\n۱ از ۴ — <b>پلن</b> کد هدیه را انتخاب کنید:';
      kb = [...SALE.map((k) => [{ text: `${PLANS[k].title}`, callback_data: `gp:${k}` }]), cancel];
    } else if (!w.days) {
      text = `🎁 پلن: <b>${PLANS[w.plan].title}</b>\n\n۲ از ۴ — <b>مدت اعتبار</b> اشتراک چند روز باشد؟`;
      kb = nums('gd', [7, 30, 90, 180], ' روز');
    } else if (!w.uses) {
      text = `🎁 ${PLANS[w.plan].title} — ${faNum(w.days)} روز\n\n۳ از ۴ — <b>هر کد چند بار</b> قابل استفاده باشد؟ (هر کاربر فقط یک بار)`;
      kb = nums('gu', [1, 5, 10, 50], ' بار');
    } else if (!w.count) {
      text = `🎁 ${PLANS[w.plan].title} — ${faNum(w.days)} روز — هر کد ${faNum(w.uses)} بار\n\n۴ از ۴ — <b>چند کد</b> با این مشخصات ساخته شود؟`;
      kb = nums('gc', [1, 5, 10, 20, 50], ' کد');
    } else {
      text = [
        '🎁 <b>تأیید ساخت کد هدیه</b>', '',
        `📦 پلن: ${PLANS[w.plan].title}`,
        `⏳ مدت: ${faNum(w.days)} روز`,
        `🔁 هر کد: ${faNum(w.uses)} بار استفاده`,
        `🔢 تعداد کد: ${faNum(w.count)}`,
        '', `در مجموع ${faNum(w.uses * w.count)} نفر می‌توانند اشتراک هدیه بگیرند.`,
      ].join('\n');
      kb = [[{ text: '✅ بساز', callback_data: 'gy' }], cancel];
    }
    return msgId ? this.edit(chat, msgId, text, kb, 'admin') : this.send(chat, text, kb, null, 'admin');
  }

  async giftCustom(chat, field, raw) {
    const n = Number(String(raw).trim().replace(/[۰-۹]/g, (d) => '۰۱۲۳۴۵۶۷۸۹'.indexOf(d)).replace(/[,\s٬]/g, ''));
    const [min, max, label] = { days: [1, 365, 'روز'], uses: [1, 10000, 'تعداد استفاده'], count: [1, 200, 'تعداد کد'] }[field];
    if (!Number.isInteger(n) || n < min || n > max) {
      this.meta('admin_state', `gift:${field}`);
      return this.send(chat, `❌ ${label} باید عددی بین ${faNum(min)} و ${faNum(max)} باشد. دوباره بفرستید:`, null, null, 'admin');
    }
    const w = this.giftWiz();
    w[field] = n;
    this.giftWiz(w);
    return this.giftStep(chat);
  }

  async giftCreate(chat, msgId) {
    const w = this.giftWiz();
    if (!w.plan || !w.days || !w.uses || !w.count) return this.giftStep(chat, msgId);
    this.giftWiz(null);
    const codes = [];
    while (codes.length < w.count) {
      const c = giftCode();
      if (this.one('SELECT 1 AS x FROM gift_codes WHERE code=?', c)) continue;
      this.sql.exec('INSERT INTO gift_codes(code, plan, days, max_uses, created_at) VALUES (?,?,?,?,?)', c, w.plan, w.days, w.uses, Date.now());
      codes.push(c);
    }
    const head = `✅ <b>${faNum(codes.length)} کد هدیه ساخته شد</b>\n📦 ${PLANS[w.plan].title} — ⏳ ${faNum(w.days)} روز — 🔁 هر کد ${faNum(w.uses)} بار`;
    const howto = `کاربر در @${this.env.BOT_USERNAME} روی «🎁 کد هدیه» می‌زند و کد را می‌فرستد.`;
    await this.edit(chat, msgId, head, null, 'admin');
    if (codes.length <= 40) {
      return this.send(chat, `${head}\n\n${codes.map((c) => `<code>${c}</code>`).join('\n')}\n\n${howto}`, [[{ text: '➕ کد جدید', callback_data: 'gw' }]], null, 'admin');
    }
    // long batches: one text file with every code and its one-click link
    const lines = [`TeleTVShare gift codes — ${w.plan} — ${w.days} days — ${w.uses} use(s) each`, '',
      ...codes.map((c) => `${c}\thttps://t.me/${this.env.BOT_USERNAME}?start=gift_${c}`)];
    const form = new FormData();
    form.set('chat_id', String(this.env.OWNER_ID));
    form.set('caption', `${head}\n\n${howto}`);
    form.set('parse_mode', 'HTML');
    form.set('document', new Blob([lines.join('\n')], { type: 'text/plain' }), `gift-codes-${codes.length}.txt`);
    this.sub = (this.sub || 0) + 1;
    await fetch(`${this.tgBase()}/bot${this.env.ADMIN_BOT_TOKEN}/sendDocument`, { method: 'POST', body: form });
  }

  giftHelp() {
    return [
      '🎁 <b>ساخت کد هدیه</b>',
      '<code>/gift پلن [روز] [تعداد استفاده]</code>',
      '', 'پلن: <code>1g</code> یا <code>5g</code> یا <code>20g</code> یا <code>50g</code>',
      'مثال: <code>/gift 5g 30 1</code> ← یک کد ۵ گیگ، ۳۰ روزه، یک‌بار مصرف',
      'مثال: <code>/gift 1g 7 20</code> ← کد ۱ گیگ، ۷ روزه، برای ۲۰ نفر',
    ].join('\n');
  }

  giftsText() {
    const rows = this.q('SELECT * FROM gift_codes ORDER BY created_at DESC LIMIT 30');
    return rows.length
      ? '🎁 <b>کدهای هدیه</b>\n\n' + rows.map((g) => `<code>${g.code}</code> — ${PLANS[g.plan].title}، ${faNum(g.days)} روز — ${faNum(g.used)}/${faNum(g.max_uses)}`).join('\n')
      : 'هنوز کدی ساخته نشده.';
  }

  paymentsText() {
    const rows = this.q(`SELECT p.*, u.first_name FROM payments p LEFT JOIN users u ON u.id=p.user_id ORDER BY p.created_at DESC LIMIT 20`);
    return rows.length
      ? '🧾 <b>آخرین پرداخت‌ها</b>\n\n' + rows.map((p) => `#${p.id} ${({ pending: '⏳', approved: '✅', rejected: '❌' })[p.status]} ${esc(p.first_name)} — ${PLANS[p.plan].title} ${PERIOD_TITLE[p.months || 1]} — ${faNum(p.amount)} — ${fmtDate(p.created_at)}`).join('\n')
      : 'هنوز پرداختی ثبت نشده.';
  }

  pendingKeyboard() {
    const rows = this.q(`SELECT id FROM payments WHERE status='pending' ORDER BY id LIMIT 10`);
    return rows.length ? rows.map((p) => [{ text: `🧾 نمایش دوباره رسید #${p.id}`, callback_data: `ar:${p.id}` }]) : null;
  }

  settingsText() {
    return [
      '⚙️ <b>تنظیمات</b>',
      `💳 شماره کارت: <code>${esc(this.setting('card_number'))}</code>`,
      `👤 به نام: ${esc(this.setting('card_name'))}`,
      `🏦 بانک: ${esc(this.setting('card_bank'))}`,
      '',
      ...SALE.map((k) => `📦 ${PLANS[k].title}: ${faNum(this.price(k))} تومان — هزینه تخمینی آروان ${faNum(Math.round(this.estCost(k) / 100) * 100)} — سود ${faNum(Math.round((this.price(k) - this.estCost(k)) / 100) * 100)}${this.price(k) < this.floorMonthly(k) ? ' ⚠️ ضررده!' : ' ✅'}`),
      '',
      `🏷 تخفیف خرید چندماهه: ۳ ماهه ${faNum(this.discount(3))}٪ — ۶ ماهه ${faNum(this.discount(6))}٪ — یک ساله ${faNum(this.discount(12))}٪`,
      `🔗 دانلود از لینک: ${this.setting('links') === '1' ? 'فعال برای همه' : 'فقط برای مدیر'}`,
      `🎁 سقف هدیه عضویت: ${faNum(Number(this.setting('welcome_daily')) || 50)} نفر در روز`,
      `⬆️ مصرف منصفانه آپلود: ${faNum(Number(this.setting('mult_up')))} برابر فضای پلن (برای شما هزینه‌ای ندارد)`,
      `📺 مصرف منصفانه تماشا (به کاربر نشان داده نمی‌شود): ${SALE.map((k) => `${PLANS[k].title.split(' ')[0]} گیگ ${faNum(this.fairWatch(k))}×`).join('، ')}`,
      '',
      this.appInfo() ? `📲 اپ تلویزیون: منتشر شده ${this.meta('app_version') ? `(نسخه ${esc(this.meta('app_version'))}) ` : ''}— ${fmtDate(Number(this.meta('app_at')))}` : '📲 اپ تلویزیون: هنوز منتشر نشده',
      'برای انتشار نسخه جدید، فایل APK را همین‌جا بفرستید (در کپشن می‌توانید شماره نسخه بنویسید).',
    ].join('\n');
  }

  settingsKeyboard() {
    return [
      [{ text: '💳 شماره کارت', callback_data: 'se:card_number' }, { text: '👤 نام صاحب کارت', callback_data: 'se:card_name' }],
      [{ text: '🏦 بانک', callback_data: 'se:card_bank' }],
      [{ text: '🎁 سقف هدیه عضویت در روز', callback_data: 'se:welcome_daily' }],
      [{ text: '⬆️ منصفانه آپلود', callback_data: 'se:mult_up' }, { text: this.setting('links') === '1' ? '🔗 خاموش کردن لینک برای کاربران' : '🔗 روشن کردن لینک برای کاربران', callback_data: 'lt' }],
      SALE.map((k) => ({ text: `📺 منصفانه ${PLANS[k].title.split(' ')[0]}G`, callback_data: `se:fw_${k}` })),
      SALE.slice(0, 2).map((k) => ({ text: `قیمت ${PLANS[k].title}`, callback_data: `se:price_${k}` })),
      SALE.slice(2).map((k) => ({ text: `قیمت ${PLANS[k].title}`, callback_data: `se:price_${k}` })),
      [3, 6, 12].map((n) => ({ text: `تخفیف ${PERIOD_TITLE[n]}`, callback_data: `se:disc_${n}` })),
    ];
  }

  settingPrompt(key) {
    return ({
      card_number: 'شماره کارت جدید را بفرستید (۱۶ رقم):',
      card_name: 'نام صاحب کارت را بفرستید:',
      card_bank: 'نام بانک را بفرستید:',
      mult_up: 'ضریب مصرف منصفانه آپلود ماهانه را بفرستید (مثلاً ۱۰ یعنی ۱۰ برابر فضای پلن):',
      welcome_daily: 'حداکثر تعداد هدیه عضویت (۵۰۰ مگ) در هر ۲۴ ساعت را بفرستید (مثلاً ۵۰):',
      ...Object.fromEntries(SALE.map((k) => ['fw_' + k, `ضریب مصرف منصفانه تماشای ماهانه پلن ${PLANS[k].title} را بفرستید (مثلاً ۲ یعنی ۲ برابر فضای پلن). کمتر = قیمت‌گذاری امن‌تر:`])),
      disc_3: 'درصد تخفیف خرید ۳ ماهه را بفرستید (۰ تا ۹۰):',
      disc_6: 'درصد تخفیف خرید ۶ ماهه را بفرستید (۰ تا ۹۰):',
      disc_12: 'درصد تخفیف خرید یک ساله را بفرستید (۰ تا ۹۰):',
    })[key] || `قیمت جدید ${PLANS[key.replace('price_', '')]?.title || ''} را به تومان بفرستید:`;
  }

  async applySetting(chat, key, raw) {
    const A = (t, kb) => this.send(chat, t, kb, null, 'admin');
    let v = String(raw).trim().replace(/[۰-۹]/g, (d) => '۰۱۲۳۴۵۶۷۸۹'.indexOf(d)).replace(/[٠-٩]/g, (d) => '٠١٢٣٤٥٦٧٨٩'.indexOf(d));
    if (key === 'card_number') {
      v = v.replace(/[\s-]/g, '');
      if (!/^\d{16}$/.test(v)) return A('❌ شماره کارت باید ۱۶ رقم باشد. دوباره از تنظیمات امتحان کنید.', this.settingsKeyboard());
    } else if (key.startsWith('disc_')) {
      v = v.replace(/[٪%\s]/g, '');
      if (!/^\d+$/.test(v) || Number(v) > 90) return A('❌ یک عدد بین ۰ تا ۹۰ بفرستید.', this.settingsKeyboard());
    } else if (key.startsWith('mult') || key.startsWith('price_') || key.startsWith('fw_') || key === 'welcome_daily') {
      v = v.replace(/[,\s٬]/g, '');
      if (!/^\d+$/.test(v) || Number(v) <= 0) return A('❌ یک عدد مثبت بفرستید.', this.settingsKeyboard());
    } else if (!v || v.length > 60) {
      return A('❌ مقدار نامعتبر است.', this.settingsKeyboard());
    }
    this.meta('set_' + key, v);
    return A('✅ ذخیره شد.\n\n' + this.settingsText(), this.settingsKeyboard());
  }

  async onAdminCallback(cb) {
    const chatId = cb.message?.chat?.id, msgId = cb.message?.message_id;
    const answer = (text, alert = false) => this.tg('answerCallbackQuery', { callback_query_id: cb.id, text, show_alert: alert }, 'admin');
    const A = (t, kb) => this.send(chatId, t, kb, null, 'admin');
    const E = (t, kb) => this.edit(chatId, msgId, t, kb, 'admin');
    const [op, a, b] = String(cb.data || '').split(':');

    if (op === 'am') { await A(this.adminStats(), this.adminMenu()); return answer(); }
    if (op === 'ap') { await A(this.paymentsText(), this.pendingKeyboard()); return answer(); }
    if (op === 'ar') {
      const pay = this.one('SELECT * FROM payments WHERE id=?', Number(a));
      if (pay) await this.sendReceiptToAdmin(pay, this.user(pay.user_id) || { id: pay.user_id });
      return answer();
    }
    if (op === 'ag') { await A(this.giftsText(), [[{ text: '➕ کد جدید', callback_data: 'gh' }]]); return answer(); }
    if (op === 'gh' || op === 'gw') { this.giftWiz({}); await this.giftStep(chatId); return answer(); }
    if (op === 'gn') { this.giftWiz(null); this.meta('admin_state', null); await E('❌ ساخت کد هدیه لغو شد.'); return answer(); }
    if (op === 'gy') { await this.giftCreate(chatId, msgId); return answer('ساخته شد'); }
    if (op === 'gp' || op === 'gd' || op === 'gu' || op === 'gc') {
      const field = { gp: 'plan', gd: 'days', gu: 'uses', gc: 'count' }[op];
      if (a === 'x') {
        this.meta('admin_state', `gift:${field}`);
        await A(`✏️ ${{ days: 'تعداد روز اعتبار', uses: 'تعداد دفعات استفاده از هر کد', count: 'تعداد کدها' }[field]} را به عدد بفرستید:`);
        return answer();
      }
      const w = this.giftWiz();
      if (op === 'gp') { if (!SALE.includes(a)) return answer(); w.plan = a; } else w[field] = Number(a);
      this.giftWiz(w);
      await this.giftStep(chatId, msgId);
      return answer();
    }
    if (op === 'as') { await A(this.settingsText(), this.settingsKeyboard()); return answer(); }
    if (op === 'lt') {
      this.meta('set_links', this.setting('links') === '1' ? '0' : '1');
      await E(this.settingsText(), this.settingsKeyboard());
      return answer(this.setting('links') === '1' ? 'دانلود از لینک برای همه فعال شد' : 'فقط برای مدیر');
    }
    if (op === 'se') {
      this.meta('admin_state', a);
      await A(`✏️ ${this.settingPrompt(a)}\n(برای انصراف /settings را بزنید)`);
      return answer();
    }
    if (op === 'pa' || op === 'pr') return this.decidePayment(cb, Number(a), op === 'pa');
    if (op === 'U') { const v = this.adminUsersView(Number(a) || 0); await E(v.text, v.kb); return answer(); }
    if (op === 'uv') { const v = this.adminUserView(Number(a)); await A(v.text, v.kb); return answer(); }
    if (op === 'u') {
      const target = this.user(Number(a));
      if (!target) return answer('کاربر پیدا نشد');
      let note = '';
      if (b === 'ext') {
        if (target.plan === 'free') return answer('کاربر پلن رایگان دارد؛ یک پلن انتخاب کنید', true);
        this.activatePlan(target.id, target.plan, 30); note = 'تمدید شد';
      } else if (PLANS[b]) {
        if (b === 'free') this.sql.exec(`UPDATE users SET plan='free', expires_at=NULL, grace_until=NULL WHERE id=?`, target.id);
        else this.sql.exec('UPDATE users SET plan=?, expires_at=?, grace_until=NULL, reminded=0 WHERE id=?', b, Date.now() + 30 * DAY, target.id);
        note = 'پلن تغییر کرد';
        await this.send(target.id, `ℹ️ اشتراک شما توسط پشتیبانی به‌روز شد.\n\n${this.accountText(this.user(target.id))}`, this.menuKeyboard());
      } else if (b === 'ban' || b === 'unban') {
        this.sql.exec('UPDATE users SET banned=? WHERE id=?', b === 'ban' ? 1 : 0, target.id);
        note = b === 'ban' ? 'مسدود شد' : 'آزاد شد';
      } else if (b === 'tvoff') {
        const d = this.one('SELECT * FROM devices WHERE user_id=?', target.id);
        if (d) await this.removeDevice(d);
        note = 'تلویزیون قطع شد';
      }
      await this.writeManifest(target.id);
      const v = this.adminUserView(target.id);
      await E(v.text, v.kb);
      return answer(note);
    }
    return answer();
  }

  async decidePayment(cb, id, approve) {
    const answer = (text, alert = false) => this.tg('answerCallbackQuery', { callback_query_id: cb.id, text, show_alert: alert }, 'admin');
    const pay = this.one('SELECT * FROM payments WHERE id=?', id);
    if (!pay) return answer('پیدا نشد');
    if (pay.status !== 'pending') return answer('قبلاً بررسی شده');
    const user = this.user(pay.user_id) || { id: pay.user_id };
    let result;
    if (approve) {
      const exp = this.activatePlan(pay.user_id, pay.plan, 30 * (pay.months || 1));
      if (!exp) return answer('کاربر الان پلن بزرگ‌تری دارد. اول پلنش را از /user عوض کنید.', true);
      this.sql.exec(`UPDATE payments SET status='approved', decided_at=? WHERE id=?`, Date.now(), id);
      result = `✅ تأیید شد — اعتبار تا ${fmtDate(exp, false)}`;
      await this.writeManifest(pay.user_id);
      await this.send(pay.user_id, `🎉 پرداخت شما تأیید شد!\nاشتراک <b>${PLANS[pay.plan].title}</b> تا ${fmtDate(exp, false)} فعال است.\n\n${this.accountText(this.user(pay.user_id))}`, this.menuKeyboard());
    } else {
      this.sql.exec(`UPDATE payments SET status='rejected', decided_at=? WHERE id=?`, Date.now(), id);
      result = '❌ رد شد';
      await this.send(pay.user_id, '❌ رسید شما تأیید نشد. اگر فکر می‌کنید اشتباهی رخ داده، از «💬 پشتیبانی» با ما در تماس باشید یا دوباره رسید درست را بفرستید.', this.menuKeyboard());
    }
    const caption = `${this.paymentCaption(pay, user)}\n\n${result}`;
    if (cb.message?.photo || cb.message?.document) {
      await this.tg('editMessageCaption', { chat_id: cb.message.chat.id, message_id: cb.message.message_id, parse_mode: 'HTML', caption }, 'admin');
    } else {
      await this.edit(cb.message.chat.id, cb.message.message_id, caption, null, 'admin');
    }
    return answer(approve ? 'تأیید شد' : 'رد شد');
  }

  adminStats() {
    const now = Date.now();
    const users = this.one('SELECT COUNT(*) AS c FROM users').c;
    const paid = this.one(`SELECT COUNT(*) AS c FROM users u WHERE plan!='free' AND expires_at > ? AND NOT EXISTS
      (SELECT 1 FROM welcomed w WHERE w.id=u.id AND u.expires_at <= w.at + ?)`, now, WELCOME.days * DAY + 60_000).c;
    const tvs = this.one('SELECT COUNT(*) AS c FROM devices').c;
    const files = this.one(`SELECT COUNT(*) AS c FROM files WHERE status='ready'`).c;
    const pending = this.one(`SELECT COUNT(*) AS c FROM payments WHERE status='pending'`).c;
    const income = this.one(`SELECT COALESCE(SUM(amount),0) AS s FROM payments WHERE status='approved' AND decided_at > ?`, now - 30 * DAY).s;
    const mk = monthKey();
    const up = this.one('SELECT COALESCE(SUM(up_used),0) AS s FROM users WHERE up_month=?', mk).s;
    const watch = this.one('SELECT COALESCE(SUM(watch_used),0) AS s FROM users WHERE watch_month=?', mk).s;
    const stored = this.totalUsed();
    const storeCost = Math.max(0, stored / 1e9 - 5) * 3600;
    const trafficCost = Math.max(0, watch / 1e9 - 20) * 965;
    return [
      '📊 <b>آمار TeleTVShare</b>',
      `👥 کاربران: ${faNum(users)} — پولی فعال: ${faNum(paid)} — تلویزیون وصل: ${faNum(tvs)}`,
      `📂 فایل‌ها: ${faNum(files)} — حجم کل در آروان: ${fmtSize(stored)}`,
      `⬆️ آپلود این ماه: ${fmtSize(up)} — 📺 تماشای این ماه (تقریبی): ${fmtSize(watch)}`,
      `💰 درآمد ۳۰ روز اخیر: ${faNum(income)} تومان`,
      `💸 هزینه تقریبی آروان این ماه: ${faNum(Math.round(storeCost + trafficCost))} تومان`,
      `🧾 رسیدهای در انتظار: ${faNum(pending)}`,
      this.meta('vps_seen') ? `🖥 VPS: ${this.vpsAlive() ? '🟢 آنلاین' : '🔴 قطع — کارها با GitHub انجام می‌شود'}` : '🖥 VPS: هنوز وصل نشده',
    ].join('\n');
  }

  adminUsersView(page) {
    const total = this.one('SELECT COUNT(*) AS c FROM users').c;
    const rows = this.q('SELECT * FROM users ORDER BY last_seen DESC LIMIT ? OFFSET ?', 10, page * 10);
    const kb = rows.map((u) => [{
      text: `${u.banned ? '⛔️ ' : ''}${short(u.first_name || u.id, 16)} · ${this.limits(u).title} · ${fmtSize(this.userUsed(u.id))}`,
      callback_data: `uv:${u.id}`,
    }]);
    const nav = [];
    if (page > 0) nav.push({ text: '« قبلی', callback_data: `U:${page - 1}` });
    if ((page + 1) * 10 < total) nav.push({ text: 'بعدی »', callback_data: `U:${page + 1}` });
    if (nav.length) kb.push(nav);
    return { text: `👥 <b>کاربران</b> (${faNum(total)} نفر) — برای مدیریت روی هر کدام بزنید:`, kb };
  }

  adminUserView(uid) {
    const u = this.user(uid);
    const lim = this.limits(u);
    const mu = this.monthUsage(u);
    const files = this.one(`SELECT COUNT(*) AS c FROM files WHERE owner=? AND status='ready'`, uid).c;
    const tv = this.one('SELECT * FROM devices WHERE user_id=?', uid);
    const paid = this.one(`SELECT COALESCE(SUM(amount),0) AS s FROM payments WHERE user_id=? AND status='approved'`, uid).s;
    const text = [
      `👤 <b>${esc(u.first_name)}</b>${u.username ? ` @${esc(u.username)}` : ''} — <code>${u.id}</code>`,
      `پلن: ${lim.title}${u.expires_at && u.plan !== 'free' ? ` تا ${fmtDate(u.expires_at, false)}` : ''}${u.banned ? ' — ⛔️ مسدود' : ''}`,
      `فضا: ${fmtSize(this.userUsed(uid))} از ${fmtSize(lim.quota)} — ${faNum(files)} فایل`,
      `مصرف منصفانه این ماه: آپلود ${fmtSize(mu.up)} از ${fmtSize(lim.upCap)} — تماشا ${fmtSize(mu.watch)} از ${fmtSize(lim.watchCap)}`,
      `تلویزیون: ${tv ? `وصل از ${fmtDate(tv.created_at, false)}` : '—'}`,
      `مجموع پرداخت: ${faNum(paid)} تومان`,
      `عضویت: ${fmtDate(u.created_at, false)} — آخرین فعالیت: ${fmtDate(u.last_seen || u.created_at)}`,
      `قوانین: ${u.terms_at ? `پذیرفته در ${fmtDate(u.terms_at, false)}` : 'هنوز نپذیرفته'}`,
      `دعوت‌های موفق: ${faNum(this.one('SELECT COUNT(*) AS c FROM users WHERE referred_by=? AND ref_rewarded=1', uid).c)} — فضای هدیه فعال: ${fmtSize(this.bonusBytes(uid))}${u.referred_by ? ` — دعوت‌شده توسط <code>${u.referred_by}</code>` : ''}`,
    ].join('\n');
    const kb = [
      [{ text: '➕ تمدید ۳۰ روز', callback_data: `u:${uid}:ext` }],
      [{ text: '۱ گیگ', callback_data: `u:${uid}:p1g` }, { text: '۵ گیگ', callback_data: `u:${uid}:p5g` }, { text: '۲۰ گیگ', callback_data: `u:${uid}:p20g` }, { text: '۵۰ گیگ', callback_data: `u:${uid}:p50g` }],
      [{ text: 'رایگان', callback_data: `u:${uid}:free` }],
      [u.banned ? { text: '✅ رفع مسدودی', callback_data: `u:${uid}:unban` } : { text: '⛔️ مسدود کردن', callback_data: `u:${uid}:ban` }, { text: '🔌 قطع تلویزیون', callback_data: `u:${uid}:tvoff` }],
    ];
    return { text, kb };
  }

  // ================================================================ background work
  async ensureAlarm() {
    if (!(await this.ctx.storage.getAlarm())) await this.ctx.storage.setAlarm(Date.now() + 60_000);
  }

  async alarm() {
    this.sub = 0;
    try {
      if (Date.now() >= Number(this.meta('next_maint') || 0)) {
        const more = await this.maintenance();
        this.meta('next_maint', Date.now() + (more ? 60_000 : MAINT_EVERY));
      }
    } catch (e) {
      console.log('maintenance failed', e.stack || e);
    }
    if (this.budget() > 8) await this.processQueue();
    try { if (this.budget() > 4) await this.helperWatch(); } catch (e) { console.log('helper watch failed', e.stack || e); }
    try {
      // the owner's own domain was set or changed: rewrite his TV list right away
      const dom = (this.ownDomain() || '') + '|stores'; // bump the suffix to force one rewrite of the owner's TV list
      if ((this.meta('own_domain') || '') !== dom && this.budget() > 6) {
        await this.writeManifest(Number(this.env.OWNER_ID));
        this.meta('own_domain', dom);
      }
    } catch (e) { console.log('own domain refresh failed', e.stack || e); }
    try { if (this.budget() > 14 && this.one('SELECT 1 AS x FROM devices LIMIT 1')) await this.tvDeletes(); } catch (e) { console.log('tv deletes failed', e.stack || e); }
    const queued = this.one(`SELECT 1 AS x FROM files WHERE status='queued' LIMIT 1`);
    const helperWait = this.one(`SELECT 1 AS x FROM files WHERE status IN ${HELPER_ST} LIMIT 1`);
    const vpsWatch = (this.meta('vps_seen') && !this.meta('vps_down')) || this.one('SELECT 1 AS x FROM devices LIMIT 1');
    await this.ctx.storage.setAlarm(Date.now() + (queued ? 50 : helperWait || vpsWatch ? 60_000 : 10 * 60_000));
  }

  // Files up to 20 MB: Telegram -> Arvan, streamed.
  async processQueue() {
    for (const s of this.q(`SELECT id FROM files WHERE status='uploading'`)) this.sql.exec(`UPDATE files SET status='queued' WHERE id=?`, s.id);
    const f = this.one(`SELECT * FROM files WHERE status='queued' ORDER BY created_at LIMIT 1`);
    if (!f) return;
    if (f.storage === 'vps') { this.sql.exec(`UPDATE files SET status='waiting_helper' WHERE id=?`, f.id); return; }
    this.sql.exec(`UPDATE files SET status='uploading' WHERE id=?`, f.id);
    try {
      const { res, size } = await this.tgFile(f.tg_file_id);
      if (f.storage === 'cf') {
        const buf = await res.arrayBuffer();
        this.sql.exec('DELETE FROM chunks WHERE file_id=?', f.id);
        this.writeChunks(f.id, buf);
        await this.finishFile(f, buf.byteLength);
        return;
      }
      const { readable, writable } = new FixedLengthStream(size);
      res.body.pipeTo(writable).catch(() => {});
      await this.s3put(f.obj_key, readable, { type: f.mime || guessMime(f.name), disposition: this.disposition(f.name) });
      await this.finishFile(f, size);
    } catch (e) {
      console.log('upload failed', f.id, e.stack || e);
      this.sql.exec(`UPDATE files SET status='failed', error=? WHERE id=?`, String(e.message || e), f.id);
      await this.promoteTurn(f.owner);
      await this.edit(f.chat_id, f.msg_id, `❌ ذخیره <b>${esc(f.name)}</b> ناموفق بود:\n<code>${esc(e.message || e)}</code>`,
        [[{ text: '🔁 دوباره', callback_data: `r:${f.id}` }, { text: '❌ لغو', callback_data: `c:${f.id}` }]]);
    }
  }

  async finishFile(f, size) {
    await this.storeThumb(f);
    this.sql.exec(`UPDATE files SET status='ready', size=? WHERE id=?`, size, f.id);
    const mk = monthKey();
    this.sql.exec(`UPDATE users SET up_used=CASE WHEN up_month=? THEN up_used ELSE 0 END + ?, up_month=? WHERE id=?`, mk, size, mk, f.owner);
    await this.writeManifest(f.owner);
    // The file is safe on Arvan now: remove the user's original message from the chat (bots may delete
    // incoming messages in private chats for 48 hours).
    if (f.src_msg_id) await this.tg('deleteMessage', { chat_id: f.chat_id, message_id: f.src_msg_id });
    await this.promoteTurn(f.owner);
    const hasTv = this.one('SELECT 1 AS x FROM devices WHERE user_id=?', f.owner);
    await this.edit(f.chat_id, f.msg_id,
      `✅ <b>${esc(f.name)}</b> (${fmtSize(size)}) ذخیره شد${hasTv ? ' و روی تلویزیون نمایش داده می‌شود.' : '.\n📺 برای دیدن روی تلویزیون، تلویزیون را وصل کنید.'}${/\.(srt|vtt|ass|ssa)$/i.test(f.name) ? '\n\n📝 این فایل زیرنویس است و جدا نمایش داده نمی‌شود: موقع پخش ویدیو از دکمه زیرنویس (CC) انتخابش کنید. اگر اسمش با اسم ویدیو یکی باشد (مثل movie.mp4 و movie.srt)، خودکار روشن می‌شود.' : ''}\n\n${this.usageLine(f.owner)}`,
      hasTv ? [[{ text: '🗑 پاک کردن', callback_data: `d:${f.id}:0` }]]
        : [[{ text: '📺 اتصال تلویزیون', callback_data: 't' }], [{ text: '🗑 پاک کردن', callback_data: `d:${f.id}:0` }]]);
  }

  async storeThumb(f) {
    if (!f.thumb_file_id) return;
    try {
      const { res } = await this.tgFile(f.thumb_file_id);
      const buf = await res.arrayBuffer();
      if (buf.byteLength > 1_000_000) return;
      if (f.storage === 'cf' || f.storage === 'vps') { this.sql.exec('UPDATE files SET thumb=? WHERE id=?', buf, f.id); return; }
      const key = `t/${f.id}.jpg`;
      await this.s3put(key, buf, { type: 'image/jpeg', cache: 'public, max-age=604800' });
      this.sql.exec('UPDATE files SET thumb_key=? WHERE id=?', key, f.id);
    } catch (e) {
      console.log('thumb failed', f.id, e.message);
    }
  }

  // Subrequest budget: the free plan allows 50 outbound requests per invocation.
  budget() { return 45 - (this.sub || 0); }

  // Reminders, expiry, grace cleanup, viewing reports, manifest refresh, pairing cleanup.
  // Works in batches within the request budget; returns true if work is left for the next run.
  async maintenance() {
    const now = Date.now();
    const low = () => this.budget() < 8;
    try { await this.bucketWatchdog(); } catch (e) { console.log('watchdog failed', String(e)); }
    try { await this.dailyBackup(); } catch (e) { console.log('backup failed', String(e)); }
    this.sql.exec('DELETE FROM seen2 WHERE at < ?', now - 3 * DAY);
    this.sql.exec(`DELETE FROM files WHERE status IN ('link_choose','link_probe','link_pending','store_pending','dup_pending') AND created_at < ?`, now - 6 * 3600e3);
    this.sql.exec('DELETE FROM seen');
    this.sql.exec('DELETE FROM pairs');
    for (const p of this.q('SELECT code FROM tv_pairs WHERE created_at < ? LIMIT 10', now - PAIR_TTL)) {
      if (low()) return true;
      await this.s3del(`p/${p.code}.json`);
      this.sql.exec('DELETE FROM tv_pairs WHERE code=?', p.code);
    }

    for (const u of this.q(`SELECT * FROM users WHERE plan!='free' AND reminded=0 AND expires_at BETWEEN ? AND ? LIMIT 20`, now, now + REMIND_BEFORE)) {
      if (low()) return true;
      this.sql.exec('UPDATE users SET reminded=1 WHERE id=?', u.id);
      await this.send(u.id, `⏰ اشتراک <b>${PLANS[u.plan].title}</b> شما ${fmtDate(u.expires_at)} تمام می‌شود.\nبرای اینکه فایل‌هایتان پاک نشوند، اشتراک را تمدید کنید.`,
        [[{ text: '📦 خرید یا تمدید اشتراک', callback_data: 'b' }]]);
    }

    for (const u of this.q(`SELECT * FROM users WHERE plan!='free' AND expires_at < ? LIMIT 10`, now)) {
      if (low()) return true;
      const old = PLANS[u.plan].title;
      const over = this.userUsed(u.id) > PLANS.free.quota;
      this.sql.exec(`UPDATE users SET plan='free', expires_at=NULL, reminded=0, grace_until=? WHERE id=?`, over ? now + GRACE_MS : null, u.id);
      await this.writeManifest(u.id);
      await this.send(u.id, over
        ? `⚠️ اشتراک <b>${old}</b> شما تمام شد و حساب به پلن رایگان (${fmtSize(PLANS.free.quota)}) برگشت.\nفایل‌های بیشتر از این مقدار <b>۲۴ ساعت دیگر</b> (از قدیمی‌ترین) پاک می‌شوند، مگر اینکه اشتراک بخرید.`
        : `ℹ️ اشتراک <b>${old}</b> شما تمام شد و حساب به پلن رایگان برگشت.`,
        [[{ text: '📦 خرید اشتراک', callback_data: 'b' }]]);
    }

    for (const u of this.q(`SELECT * FROM users WHERE grace_until IS NOT NULL AND grace_until < ? LIMIT 5`, now)) {
      const quota = this.limits(u).quota;
      let used = this.userUsed(u.id);
      const removed = [];
      for (const f of this.q(`SELECT id,name,size FROM files WHERE owner=? AND status IN ${ACTIVE} ORDER BY created_at ASC`, u.id)) {
        if (used <= quota || low()) break;
        await this.deleteFile(f.id);
        used -= f.size;
        removed.push(f.name);
      }
      if (used <= quota) this.sql.exec('UPDATE users SET grace_until=NULL WHERE id=?', u.id);
      if (removed.length) {
        await this.send(u.id, `🗑 به دلیل پایان اشتراک، ${faNum(removed.length)} فایل قدیمی پاک شد:\n${removed.slice(0, 15).map((n) => '• ' + esc(short(n, 40))).join('\n')}`,
          [[{ text: '📦 خرید اشتراک', callback_data: 'b' }]]);
      }
      if (low()) return true;
    }

    if (await this.expireBonuses()) return true;
    if (await this.collectViewingReports()) return true;

    for (const d of this.q('SELECT user_id FROM devices WHERE manifest_at IS NULL OR manifest_at < ? LIMIT 20', now - MANIFEST_REFRESH)) {
      if (low()) return true;
      await this.writeManifest(d.user_id);
    }
    return false;
  }

  // Each TV writes {"month":"YYYY-MM","bytes":N} (bytes watched this month) to r/<token>.json.
  // Devices are read round-robin, a batch per run. Returns true if the batch was cut short.
  async collectViewingReports() {
    const mk = monthKey();
    const cursor = this.meta('rep_cursor') || '';
    let rows = this.q('SELECT * FROM devices WHERE token > ? ORDER BY token LIMIT 15', cursor);
    if (!rows.length && cursor) {
      this.meta('rep_cursor', '');
      rows = this.q('SELECT * FROM devices ORDER BY token LIMIT 15');
    }
    for (const d of rows) {
      if (this.budget() < 8) return true;
      this.meta('rep_cursor', d.token);
      let rep;
      try {
        const r = await this.s3get(`r/${d.token}.json`);
        if (!r) continue;
        rep = await r.json();
      } catch { continue; }
      if (rep?.month !== mk || !Number.isFinite(rep.bytes)) continue;
      const prev = d.rep_month === mk ? d.rep_bytes : 0;
      const delta = Math.max(0, Math.round(rep.bytes) - prev);
      if (!delta) continue;
      this.sql.exec('UPDATE devices SET rep_month=?, rep_bytes=? WHERE token=?', mk, Math.round(rep.bytes), d.token);
      const u = this.user(d.user_id);
      const watch = (u.watch_month === mk ? u.watch_used : 0) + delta;
      this.sql.exec(`UPDATE users SET watch_used=?, watch_warned=CASE WHEN watch_month=? THEN watch_warned ELSE 0 END, watch_month=? WHERE id=?`, watch, mk, mk, u.id);
      const lim = this.limits(u);
      if (watch >= lim.watchCap) {
        if (!this.user(u.id).watch_warned) {
          this.sql.exec('UPDATE users SET watch_warned=1 WHERE id=?', u.id);
          await this.send(u.id, '📺 به سقف <b>مصرف منصفانه</b> تماشای این ماه رسیده‌اید. از اول ماه بعد یا با ارتقای اشتراک دوباره فعال می‌شود.',
            [[{ text: '📦 ارتقای اشتراک', callback_data: 'b' }]]);
        }
        await this.writeManifest(u.id);
      }
    }
    return false;
  }

  // ================================================================ legacy + migration

  // Move one in-DO file (from the single-user version) to Arvan. Returns what happened.
  async migrateOne() {
    const f = this.one(`SELECT * FROM files WHERE storage='do' AND status='ready' ORDER BY size LIMIT 1`);
    if (!f) return { done: true };
    const key = this.fileKey(f);
    const total = f.size;
    const PER_PART = 25; // 25 chunks = 47.5 MB per part (free plan: 50 subrequests per run)
    const count = Math.ceil(total / CHUNK);
    const sql = this.sql;
    await this.s3multipart(key, Math.ceil(count / PER_PART), (n) => {
      const parts = [];
      for (let i = (n - 1) * PER_PART; i < Math.min(count, n * PER_PART); i++) {
        const row = sql.exec('SELECT data FROM chunks WHERE file_id=? AND idx=?', f.id, i).toArray()[0];
        if (!row) throw new Error(`missing chunk ${i}`);
        parts.push(new Uint8Array(row.data));
      }
      const buf = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
      let o = 0;
      for (const p of parts) { buf.set(p, o); o += p.length; }
      return buf;
    }, { type: f.mime || guessMime(f.name), disposition: this.disposition(f.name) });
    const got = await this.s3head(key);
    if (got !== total) throw new Error(`size mismatch ${got} != ${total}`);
    if (f.thumb) {
      await this.s3put(`t/${f.id}.jpg`, f.thumb, { type: 'image/jpeg', cache: 'public, max-age=604800' });
      this.sql.exec(`UPDATE files SET thumb_key=? WHERE id=?`, `t/${f.id}.jpg`, f.id);
    }
    this.sql.exec(`UPDATE files SET storage='arvan', obj_key=?, thumb=NULL WHERE id=?`, key, f.id);
    this.sql.exec('DELETE FROM chunks WHERE file_id=?', f.id);
    await this.writeManifest(f.owner);
    return { moved: f.name, size: total, left: this.one(`SELECT COUNT(*) AS c FROM files WHERE storage='do' AND status='ready'`).c };
  }

  // ================================================================ admin JSON API (tests and future cPanel)
  // Read-only admin API (for a future web panel). Anything that changes money, plans, users or the
  // published app is done only in the admin bot, so a leaked API key cannot redirect payments or ship an APK.
  async api(req, url, p) {
    const h = req.headers.get('authorization') || '';
    const token = h.startsWith('Bearer ') ? h.slice(7) : '';
    if (!this.env.API_KEY || !timingSafeEqual(token, this.env.API_KEY)) return Response.json({ error: 'unauthorized' }, { status: 401 });
    if (req.method !== 'GET') return Response.json({ error: 'read-only' }, { status: 405 });
    if (p === '/api/admin/users') {
      return Response.json(this.q('SELECT * FROM users ORDER BY created_at').map((u) => ({
        ...u, used: this.userUsed(u.id), tv: !!this.one('SELECT 1 AS x FROM devices WHERE user_id=?', u.id),
      })));
    }
    if (p === '/api/admin/helper') return Response.json(this.helperStatus());
    if (p === '/api/admin/files') {
      const owner = url.searchParams.get('owner');
      const cols = 'id,name,size,status,kind,owner,created_at,storage,error,lease_by';
      return Response.json(owner
        ? this.q(`SELECT ${cols} FROM files WHERE owner=? ORDER BY created_at`, Number(owner))
        : this.q(`SELECT ${cols} FROM files ORDER BY created_at`));
    }
    if (p === '/api/admin/payments') return Response.json(this.q('SELECT id,user_id,plan,months,amount,status,created_at,decided_at FROM payments ORDER BY id'));
    if (p === '/api/admin/bonuses') return Response.json(this.q('SELECT * FROM bonuses ORDER BY id'));
    if (p === '/api/admin/support') return Response.json(this.q('SELECT * FROM support ORDER BY created_at'));
    if (p === '/api/admin/gifts') return Response.json(this.q('SELECT * FROM gift_codes ORDER BY created_at'));
    if (p === '/api/admin/settings') return Response.json(Object.fromEntries(
      ['card_number', 'card_name', 'card_bank', 'mult_up', 'links', 'welcome_daily', ...SALE.map((k) => 'fw_' + k), 'disc_3', 'disc_6', 'disc_12', ...SALE.map((k) => 'price_' + k)].map((k) => [k, this.setting(k)])));
    return Response.json({ error: 'not found' }, { status: 404 });
  }

  // ================================================================ large-file helper (GitHub Actions)
  async helperJobs(req) {
    const who = this.helperName(req);
    if (who === 'vps') {
      await this.vpsSeen();
      const q = new URL(req.url).searchParams;
      if (q.has('tunnel')) {
        const tunnel = q.get('tunnel') || '';
        this.meta('vps_tunnel', /^[a-z0-9-]{3,80}\.trycloudflare\.com$/.test(tunnel) ? tunnel : null);
      }
    }
    const jobs = this.q(`SELECT id,name,size,mime,tg_file_id,obj_key,status,source_url,fmt,storage FROM files
        WHERE status IN ('waiting_helper','helper_uploading','link_probe','link_download')
          AND (lease_until IS NULL OR lease_until < ? OR lease_by = ?) AND (storage <> 'vps' OR ? = 'vps') ORDER BY created_at`, Date.now(), who, who)
      .map((j) => ({
        id: j.id, name: j.name, size: j.size, mime: j.mime, tg_file_id: j.tg_file_id, obj_key: j.obj_key, storage: j.storage, chunk: CHUNK,
        type: j.status === 'link_probe' ? 'probe' : j.source_url ? 'link' : 'tg',
        url: j.source_url, fmt: j.fmt ? JSON.parse(j.fmt) : null, disposition: this.disposition(j.name),
      }));
    const waiting = this.one(`SELECT COUNT(*) AS c FROM files WHERE status='link_choose' AND created_at > ?`, Date.now() - 10 * 60_000).c;
    const vps_delete = who === 'vps' ? this.q('SELECT id FROM vps_del LIMIT 200').map((r) => r.id) : undefined;
    return Response.json({ jobs, waiting, vps_delete });
  }

  async helperProgress(req, id) {
    const f = this.one(`SELECT * FROM files WHERE id=? AND status IN ('waiting_helper','helper_uploading','link_download')`, id);
    if (!f) return new Response('no such job', { status: 404 });
    if (!this.holdLease(req, id)) return new Response('taken by another helper', { status: 409 });
    this.sql.exec(`UPDATE files SET status='helper_uploading' WHERE id=?`, id);
    const { done = 0, total = f.size, speed = 0 } = await req.json().catch(() => ({}));
    const pct = pctOf(done, total);
    await this.edit(f.chat_id, f.msg_id,
      `⏳ <b>${esc(f.name)}</b> (${fmtSize(f.size)})\nدر حال انتقال…\n${bar(pct)} ${pct}%\n${fmtSize(done)} از ${fmtSize(total)}${speed ? ` · ${fmtSize(speed)}/s` : ''}`,
      [[{ text: '❌ لغو', callback_data: `c:${id}` }]]);
    return Response.json({ ok: true });
  }

  async helperDone(req, kind, id) {
    const f = this.one(`SELECT * FROM files WHERE id=? AND status IN ('waiting_helper','helper_uploading','link_probe','link_download')`, id);
    if (!f) return new Response('no such job', { status: 404 });
    if (!this.holdLease(req, id)) return new Response('taken by another helper', { status: 409 });
    this.sql.exec('UPDATE files SET lease_by=NULL, lease_until=NULL WHERE id=?', id);
    if (kind === 'fail') {
      const why = (await req.text()).slice(0, 500) || 'helper error';
      this.sql.exec(`UPDATE files SET status='failed', error=? WHERE id=?`, why, id);
      await this.promoteTurn(f.owner);
      if (f.source_url) {
        const blocked = /not a bot|sign in|login|logged-in|cookies/i.test(why);
        await this.edit(f.chat_id, f.msg_id, blocked
          ? '❌ این سایت فعلاً اجازه دانلود از سرور ما را نمی‌دهد. لطفاً بعداً دوباره امتحان کنید یا خود فایل ویدیو را در تلگرام بفرستید.'
          : '❌ دانلود از این لینک ممکن نشد. ممکن است ویدیو خصوصی یا حذف شده باشد، یا این سایت پشتیبانی نشود.',
          [[{ text: '❌ بستن', callback_data: `c:${id}` }]]);
        return Response.json({ ok: true });
      }
      await this.edit(f.chat_id, f.msg_id, `❌ ذخیره <b>${esc(f.name)}</b> ناموفق بود:\n<code>${esc(why)}</code>`,
        [[{ text: '🔁 دوباره', callback_data: `r:${id}` }, { text: '❌ لغو', callback_data: `c:${id}` }]]);
      return Response.json({ ok: true });
    }
    const extra = await req.json().catch(() => ({}));
    if (extra.thumb_key) this.sql.exec('UPDATE files SET thumb_key=? WHERE id=?', extra.thumb_key, id);
    if (extra.duration) this.sql.exec('UPDATE files SET duration=? WHERE id=?', Math.round(extra.duration), id);
    if (extra.width) this.sql.exec('UPDATE files SET width=?, height=? WHERE id=?', extra.width, extra.height || null, id);
    const size = f.storage === 'cf' ? this.cfSize(id) : f.storage === 'vps' ? Math.max(0, Math.round(Number(extra.size) || 0)) : await this.s3head(f.obj_key);
    if (!size) return new Response(f.storage === 'cf' ? 'nothing uploaded' : 'object missing in Arvan', { status: 409 });
    await this.finishFile(this.one('SELECT * FROM files WHERE id=?', id), size);
    return Response.json({ ok: true, size });
  }
}

// ---------------------------------------------------------------- Worker (router)
function timingSafeEqual(a, b) {
  const x = enc.encode(String(a)), y = enc.encode(String(b));
  if (x.length !== y.length) return false;
  let r = 0;
  for (let i = 0; i < x.length; i++) r |= x[i] ^ y[i];
  return r === 0;
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const p = url.pathname;
    const store = env.STORE.get(env.STORE.idFromName('main'));
    const fwd = (path) => store.fetch(new Request(new URL(path + url.search, 'https://store'), req));
    const secretOk = (s) => s && req.headers.get('x-telegram-bot-api-secret-token') === s;

    if (p === '/') return new Response('TeleTVShare');
    if (p === `/tg/${env.WEBHOOK_SECRET}` && req.method === 'POST') {
      return secretOk(env.WEBHOOK_SECRET) ? fwd('/tg') : new Response('forbidden', { status: 403 });
    }
    if (p === `/tga/${env.ADMIN_WEBHOOK_SECRET}` && req.method === 'POST') {
      return secretOk(env.ADMIN_WEBHOOK_SECRET) ? fwd('/tga') : new Response('forbidden', { status: 403 });
    }
    if (/^\/[ft]\//.test(p) && (req.method === 'GET' || req.method === 'HEAD')) return fwd(p);
    if (p.startsWith('/api/')) return fwd(p);
    if (p.startsWith('/helper/')) {
      const h = req.headers.get('authorization') || '';
      if (!env.HELPER_SECRET || !timingSafeEqual(h.replace(/^Bearer /, ''), env.HELPER_SECRET)) return new Response('unauthorized', { status: 401 });
      return fwd(p);
    }
    return new Response('Not found', { status: 404 });
  },
};
