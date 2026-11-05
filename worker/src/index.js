// TeleTVShare: Telegram bot -> ArvanCloud Object Storage -> Android TV.
//
// * Main bot (@TeleTVShare_bot): users send files; files are stored in the Arvan bucket and
//   shown on the user's paired TV. No links are shown in the bot.
// * Admin bot (separate token): only the owner; receipts, users, gift codes, settings.
// * The TV never talks to Cloudflare (workers.dev is filtered in Iran). It reads everything
//   from Arvan: a pairing object p/<CODE>.json and a per-TV manifest m/<token>.json, and
//   reports viewing usage through a presigned PUT URL (r/<token>.json).
// * Bookkeeping lives in one SQLite-backed Durable Object ("Store").
import { DurableObject } from 'cloudflare:workers';
import { AwsClient } from 'aws4fetch';

const CHUNK = 1_900_000;              // legacy in-DO storage (migration only)
const TG_BOT_MAX = 20 * 1024 * 1024;  // Bot API getFile limit; bigger files go to the helper
const PAGE = 8;
const DAY = 864e5;
const GRACE_MS = DAY;                 // files over quota are kept 24h after a plan ends
const REMIND_BEFORE = 3 * DAY;
const PAIR_TTL = 15 * 60_000;
const MAINT_EVERY = 30 * 60_000;
const MANIFEST_REFRESH = 3 * DAY;     // presigned report URL lives 7 days
const WELCOME = { plan: 'p500', days: 7 };

const PLANS = {
  free: { title: 'رایگان', quota: 100e6, price: 0 },
  p500: { title: '۵۰۰ مگابایت', quota: 500e6, price: 50_000 },
  p2g: { title: '۲ گیگابایت', quota: 2e9, price: 150_000 },
  p5g: { title: '۵ گیگابایت', quota: 5e9, price: 350_000 },
};
const PLAN_ORDER = ['free', 'p500', 'p2g', 'p5g'];
const ACTIVE = `('ready','uploading','queued','waiting_helper','helper_uploading')`;
const CODE_ABC = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

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
      fileId: o.file_id, name, mime, size: o.file_size || 0,
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
      CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT);
    `);
    this.addCols('files', { owner: 'INTEGER', storage: "TEXT NOT NULL DEFAULT 'do'", obj_key: 'TEXT', thumb_key: 'TEXT' });
    this.addCols('users', {
      up_month: 'TEXT', up_used: 'INTEGER NOT NULL DEFAULT 0',
      watch_month: 'TEXT', watch_used: 'INTEGER NOT NULL DEFAULT 0', watch_warned: 'INTEGER NOT NULL DEFAULT 0',
    });
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
      mult: '20',
      price_p500: String(PLANS.p500.price), price_p2g: String(PLANS.p2g.price), price_p5g: String(PLANS.p5g.price),
    })[key] ?? null;
  }
  price(plan) { return Number(this.setting('price_' + plan)) || 0; }

  isAdmin(id) { return String(id) === String(this.env.OWNER_ID); }
  totalUsed() { return this.one(`SELECT COALESCE(SUM(size),0) AS s FROM files WHERE status IN ${ACTIVE}`).s; }
  userUsed(uid) { return this.one(`SELECT COALESCE(SUM(size),0) AS s FROM files WHERE owner=? AND status IN ${ACTIVE}`, uid).s; }
  user(uid) { return this.one('SELECT * FROM users WHERE id=?', uid); }

  // Effective limits. Monthly upload and viewing caps are `mult` x storage quota.
  limits(u) {
    if (this.isAdmin(u.id)) return { plan: 'admin', title: 'مدیر', quota: Infinity, upCap: Infinity, watchCap: Infinity };
    const p = PLANS[u.plan] || PLANS.free;
    const mult = Number(this.setting('mult')) || 20;
    return { plan: u.plan, title: p.title, quota: p.quota, upCap: p.quota * mult, watchCap: p.quota * mult };
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
      this.sql.exec('INSERT INTO welcomed(id, at) VALUES (?,?)', from.id, now);
      this.activatePlan(from.id, WELCOME.plan, WELCOME.days);
      welcomed = true;
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
  async s3head(key, tries = 5) {
    for (let i = 1; ; i++) {
      const r = await this.s3().fetch(this.objUrl(key), { method: 'HEAD', headers: { 'x-amz-content-sha256': 'UNSIGNED-PAYLOAD' } });
      if (r.ok) return Number(r.headers.get('content-length'));
      if (i >= tries || r.status !== 404) return null;
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
    const f = this.one('SELECT owner, obj_key, thumb_key FROM files WHERE id=?', id);
    this.sql.exec('DELETE FROM chunks WHERE file_id=?', id);
    this.sql.exec('DELETE FROM files WHERE id=?', id);
    if (f) {
      await this.s3del(f.obj_key);
      await this.s3del(f.thumb_key);
      await this.writeManifest(f.owner);
    }
  }

  // ================================================================ Telegram
  token(bot) { return bot === 'admin' ? this.env.ADMIN_BOT_TOKEN : this.env.BOT_TOKEN; }

  async tg(method, body, bot = 'main') {
    this.sub = (this.sub || 0) + 1;
    const r = await fetch(`https://api.telegram.org/bot${this.token(bot)}/${method}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    const j = await r.json().catch(() => ({ ok: false, description: `HTTP ${r.status}` }));
    if (!j.ok && !/not modified/.test(j.description || '')) console.log('tg error', bot, method, j.description);
    return j;
  }

  edit(chatId, msgId, text, keyboard, bot = 'main') {
    return this.tg('editMessageText', {
      chat_id: chatId, message_id: msgId, text, parse_mode: 'HTML',
      link_preview_options: { is_disabled: true },
      reply_markup: keyboard ? { inline_keyboard: keyboard } : undefined,
    }, bot);
  }

  send(chatId, text, keyboard, replyTo, bot = 'main') {
    return this.tg('sendMessage', {
      chat_id: chatId, text, parse_mode: 'HTML',
      link_preview_options: { is_disabled: true },
      reply_parameters: replyTo ? { message_id: replyTo, allow_sending_without_reply: true } : undefined,
      reply_markup: keyboard ? { inline_keyboard: keyboard } : undefined,
    }, bot);
  }

  notifyAdmin(text, keyboard) { return this.send(Number(this.env.OWNER_ID), text, keyboard, null, 'admin'); }

  async tgFile(fileId) {
    const gf = await this.tg('getFile', { file_id: fileId });
    if (!gf.ok) throw new Error(gf.description || 'getFile failed');
    const r = await fetch(`https://api.telegram.org/file/bot${this.env.BOT_TOKEN}/${gf.result.file_path}`);
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
      if ((m = /^\/f\/([A-Za-z0-9]{16})(?:\/.*)?$/.exec(p))) return this.serveLegacy(req, m[1]);
      if (p.startsWith('/api/')) return this.api(req, url, p);
      if (p.startsWith('/helper/')) {
        if (p === '/helper/jobs') return this.helperJobs();
        if ((m = /^\/helper\/(finish|fail)\/([A-Za-z0-9]{16})$/.exec(p))) return this.helperDone(req, m[1], m[2]);
        if ((m = /^\/helper\/progress\/([A-Za-z0-9]{16})$/.exec(p))) return this.helperProgress(req, m[1]);
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
    const user = this.touchUser(m.from);
    if (user._new) await this.notifyAdmin(`👤 کاربر جدید: ${esc(user.first_name)}${user.username ? ` @${esc(user.username)}` : ''} — <code>${user.id}</code>`);
    if (user.banned) return this.send(m.chat.id, '⛔️ حساب شما مسدود شده است.');

    const text = (m.text || '').trim();
    const cmd = /^\/(\w+)(?:@\w+)?\s*(.*)$/s.exec(text);
    if (cmd) {
      if (user.state) this.setState(user.id, null);
      return this.onCommand(m, user, cmd[1].toLowerCase(), cmd[2].trim());
    }
    if (user.state?.startsWith('receipt:') && (m.photo || m.document)) return this.onReceipt(m, user, user.state.slice(8));
    if (user.state === 'gift' && text) { this.setState(user.id, null); return this.redeem(m.chat.id, user, text); }
    if (user.state === 'tv' && text) { this.setState(user.id, null); return this.linkTv(m.chat.id, user, text); }

    const media = extractMedia(m);
    if (!media) return this.sendMenu(m.chat.id, user);
    if (user.state) this.setState(user.id, null);
    return this.addFile(m, user, media);
  }

  setState(uid, state) { this.sql.exec('UPDATE users SET state=? WHERE id=?', state, uid); }

  async onCommand(m, user, name, arg) {
    const chat = m.chat.id;
    if (name === 'start') {
      if (arg.startsWith('tv_')) return this.linkTv(chat, user, arg.slice(3));
      if (arg.startsWith('gift_')) return this.redeem(chat, user, arg.slice(5));
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
    return this.sendMenu(chat, user);
  }

  menuKeyboard() {
    return [
      [{ text: '📦 خرید یا تمدید اشتراک', callback_data: 'b' }],
      [{ text: '📂 فایل‌های من', callback_data: 'l:0' }, { text: '👤 حساب من', callback_data: 'a' }],
      [{ text: '🎁 کد هدیه', callback_data: 'g' }, { text: '📺 تلویزیون', callback_data: 't' }],
    ];
  }

  sendMenu(chat, user, welcome = false) {
    let head = '';
    if (welcome) {
      head = `👋 سلام ${esc(user.first_name || '')}! به <b>TeleTVShare</b> خوش آمدید.\nهر فایلی (ویدیو، عکس، صوت، سند) اینجا بفرستید، روی تلویزیون شما نمایش داده می‌شود.\n\n`;
      if (user._welcomed) head += `🎁 هدیه عضویت: <b>${PLANS[WELCOME.plan].title} رایگان برای ${faNum(WELCOME.days)} روز</b>!\n\n`;
      head += '📺 برای اتصال تلویزیون، اپ TeleTVShare را روی تلویزیون باز کنید و QR روی صفحه را با گوشی اسکن کنید.\n\n';
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
    lines.push(`💾 فضا: ${bar(pctOf(used, lim.quota))} ${fmtSize(used)} از ${fmtSize(lim.quota)}`);
    if (Number.isFinite(lim.upCap)) {
      lines.push(`⬆️ آپلود این ماه: ${fmtSize(mu.up)} از ${fmtSize(lim.upCap)}`);
      lines.push(`📺 تماشای این ماه: ${fmtSize(mu.watch)} از ${fmtSize(lim.watchCap)}`);
    }
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
    const mult = Number(this.setting('mult')) || 20;
    const lines = ['📦 <b>اشتراک‌های ماهانه TeleTVShare</b>', ''];
    for (const k of PLAN_ORDER.slice(1)) {
      lines.push(`• <b>${PLANS[k].title}</b> فضا — ${faNum(this.price(k))} تومان در ماه`);
    }
    lines.push('', `آپلود و تماشای ماهانه هر پلن تا ${faNum(mult)} برابر فضای آن است.`, `پلن فعلی شما: ${this.limits(user).title}`);
    return lines.join('\n');
  }

  plansKeyboard(user) {
    const cur = PLAN_ORDER.indexOf(user.plan);
    const active = user.plan !== 'free' && user.expires_at > Date.now();
    const rows = PLAN_ORDER.slice(1)
      .filter((k) => !active || PLAN_ORDER.indexOf(k) >= cur)
      .map((k) => [{
        text: `${k === user.plan && active ? '🔄 تمدید' : '🛒'} ${PLANS[k].title} — ${faNum(this.price(k))} تومان`,
        callback_data: `B:${k}`,
      }]);
    rows.push([{ text: '🎁 کد هدیه دارم', callback_data: 'g' }]);
    return rows;
  }

  paymentText(plan) {
    return [
      `🛒 اشتراک <b>${PLANS[plan].title}</b> — یک ماه`,
      `💳 مبلغ: <b>${faNum(this.price(plan))} تومان</b>`,
      '',
      `شماره کارت: <code>${esc(this.setting('card_number'))}</code>`,
      `به نام: ${esc(this.setting('card_name'))} — ${esc(this.setting('card_bank'))}`,
      '',
      '✅ بعد از واریز، <b>عکس رسید</b> را همین‌جا بفرستید.',
      'پس از بررسی (معمولاً چند دقیقه) اشتراک شما فعال می‌شود.',
    ].join('\n');
  }

  async onReceipt(m, user, plan) {
    if (!PLANS[plan] || plan === 'free') return;
    this.setState(user.id, null);
    const isPhoto = !!m.photo;
    const fileId = isPhoto ? m.photo[m.photo.length - 1].file_id : m.document.file_id;
    this.sql.exec(`INSERT INTO payments(user_id, plan, amount, status, file_id, is_photo, created_at)
      VALUES (?,?,?,?,?,?,?)`, user.id, plan, this.price(plan), 'pending', fileId, isPhoto ? 1 : 0, Date.now());
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
    const r = await fetch(`https://api.telegram.org/bot${this.env.ADMIN_BOT_TOKEN}/${method}`, { method: 'POST', body: form });
    const j = await r.json().catch(() => ({}));
    if (j.ok) this.sql.exec('UPDATE payments SET admin_msg_id=? WHERE id=?', j.result.message_id, pay.id);
    else console.log('receipt to admin failed', j.description);
  }

  paymentCaption(pay, user) {
    const who = `${esc(user.first_name || '')}${user.username ? ` (@${esc(user.username)})` : ''}`;
    return [
      `🧾 <b>رسید پرداخت #${pay.id}</b>`,
      `👤 ${who} — <code>${user.id}</code>`,
      `📦 پلن: ${PLANS[pay.plan].title}`,
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
  }

  tvStatus(user) {
    const d = this.one('SELECT * FROM devices WHERE user_id=?', user.id);
    if (!d) {
      return {
        text: '📺 هیچ تلویزیونی به حساب شما وصل نیست.\n\nاپ TeleTVShare را روی تلویزیون باز کنید؛ یک کد ۸ حرفی و QR نشان می‌دهد. QR را با دوربین گوشی اسکن کنید یا کد را همین‌جا بفرستید.\n\nهر حساب فقط روی یک تلویزیون کار می‌کند.',
        kb: [[{ text: '🔢 وارد کردن کد تلویزیون', callback_data: 'tc' }]],
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
    const files = this.q(`SELECT id,name,mime,size,kind,width,height,duration,created_at,obj_key,thumb_key
      FROM files WHERE owner=? AND status='ready' AND storage='arvan' ORDER BY created_at DESC`, uid);
    const manifest = {
      v: 1,
      updated_at: Date.now(),
      user: { name: u.first_name || '', plan: lim.title, expires_at: u.plan !== 'free' ? u.expires_at : null },
      used: this.userUsed(uid),
      quota: Number.isFinite(lim.quota) ? lim.quota : null,
      watch: {
        month: monthKey(), used: mu.watch,
        cap: Number.isFinite(lim.watchCap) ? lim.watchCap : null,
        blocked: Number.isFinite(lim.watchCap) && mu.watch >= lim.watchCap,
      },
      report_url: await this.presignPut(`r/${d.token}.json`),
      files: files.map((f) => ({
        id: f.id, name: f.name, mime: f.mime, size: f.size, kind: f.kind,
        width: f.width, height: f.height, duration: f.duration, created_at: f.created_at,
        url: this.publicUrl(f.obj_key), thumb: f.thumb_key ? this.publicUrl(f.thumb_key) : null,
      })),
    };
    await this.putJson(`m/${d.token}.json`, manifest);
    this.sql.exec('UPDATE devices SET manifest_at=? WHERE token=?', Date.now(), d.token);
  }

  // ---- files
  async addFile(m, user, media) {
    const lim = this.limits(user);
    const kb = [[{ text: '📦 ارتقای اشتراک', callback_data: 'b' }]];
    if (media.size > lim.quota) {
      return this.send(m.chat.id, `❌ این فایل (${fmtSize(media.size)}) از کل فضای پلن شما (${fmtSize(lim.quota)}) بزرگ‌تر است.`, kb, m.message_id);
    }
    const mu = this.monthUsage(user);
    if (mu.up + media.size > lim.upCap) {
      return this.send(m.chat.id, `❌ سقف آپلود ماهانه شما (${fmtSize(lim.upCap)}) پر شده است. ${fmtSize(mu.up)} در این ماه آپلود کرده‌اید.`, kb, m.message_id);
    }
    const id = randomId();
    const status = media.size > this.freeFor(user) ? 'waiting_space' : media.size > TG_BOT_MAX ? 'waiting_helper' : 'queued';
    this.sql.exec(`INSERT INTO files(id,name,mime,size,kind,status,tg_file_id,thumb_file_id,width,height,duration,chat_id,created_at,owner,storage)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,'arvan')`,
      id, media.name, media.mime, media.size, media.kind, status, media.fileId, media.thumbId,
      media.width, media.height, media.duration, m.chat.id, Date.now(), user.id);
    this.sql.exec('UPDATE files SET obj_key=? WHERE id=?', this.fileKey({ id, name: media.name }), id);
    const sent = await this.send(m.chat.id, `⏳ <b>${esc(media.name)}</b> (${fmtSize(media.size)})`, null, m.message_id);
    if (sent.ok) this.sql.exec('UPDATE files SET msg_id=? WHERE id=?', sent.result.message_id, id);
    await this.afterStatus(id);
  }

  async afterStatus(id) {
    const f = this.one('SELECT * FROM files WHERE id=?', id);
    if (!f) return;
    const title = `<b>${esc(f.name)}</b> (${fmtSize(f.size)})`;
    if (f.status === 'queued') {
      await this.edit(f.chat_id, f.msg_id, `⏳ ${title}\nدر حال ذخیره…`);
      await this.ctx.storage.setAlarm(Date.now() + 50);
    } else if (f.status === 'waiting_helper') {
      const woke = await this.wakeHelper();
      await this.edit(f.chat_id, f.msg_id, woke
        ? `⏳ ${title}\nفایل بزرگ است؛ انتقال آن تا حدود یک دقیقه دیگر شروع می‌شود.`
        : `🕓 ${title}\nفایل در صف انتقال است و به‌زودی ذخیره می‌شود.`,
        [[{ text: '❌ لغو', callback_data: `c:${id}` }]]);
    } else if (f.status === 'waiting_space') {
      await this.showSpacePicker(f, 0);
    }
  }

  async wakeHelper() {
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
    const rows = this.q(`SELECT id,name,size,created_at,kind FROM files WHERE status='ready' AND owner=?
      ORDER BY created_at DESC LIMIT ? OFFSET ?`, uid, PAGE, page * PAGE);
    if (!total) return { text: `📭 هنوز فایلی ندارید. هر فایلی بفرستید اینجا و روی تلویزیون نمایش داده می‌شود.\n\n${this.usageLine(uid)}`, kb: null };
    const icon = { video: '🎬', image: '🖼', audio: '🎵', file: '📄' };
    const lines = rows.map((f, i) =>
      `${page * PAGE + i + 1}. ${icon[f.kind] || '📄'} ${esc(short(f.name, 40))}\n     ${fmtSize(f.size)} · ${fmtDate(f.created_at)}`);
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
    const user = this.touchUser(cb.from);
    if (user.banned) return answer('⛔️ حساب شما مسدود است', true);
    const [op, a, b] = String(cb.data || '').split(':');

    switch (op) {
      case 'a': await this.send(chatId, this.accountText(user), this.menuKeyboard()); return answer();
      case 'b': await this.send(chatId, this.plansText(user), this.plansKeyboard(user)); return answer();
      case 'B': {
        if (!PLANS[a] || a === 'free') return answer();
        this.setState(user.id, `receipt:${a}`);
        await this.send(chatId, this.paymentText(a), [[{ text: '❌ انصراف', callback_data: 'bc' }]]);
        return answer();
      }
      case 'bc': this.setState(user.id, null); await this.edit(chatId, msgId, 'خرید لغو شد.', this.menuKeyboard()); return answer();
      case 'g': this.setState(user.id, 'gift'); await this.send(chatId, '🎁 کد هدیه را بفرستید:'); return answer();
      case 't': { const v = this.tvStatus(user); await this.send(chatId, v.text, v.kb); return answer(); }
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
          const st = p.size > this.freeFor(this.user(p.owner)) ? 'waiting_space' : p.size > TG_BOT_MAX ? 'waiting_helper' : 'queued';
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
    const text = (m.text || '').trim();
    const cmd = /^\/(\w+)(?:@\w+)?\s*(.*)$/s.exec(text);
    const state = this.meta('admin_state');
    if (!cmd && state) {
      this.meta('admin_state', null);
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
    if (name === 'gift') {
      const [planArg, daysArg, usesArg] = arg.split(/\s+/);
      const plan = { 500: 'p500', p500: 'p500', '2': 'p2g', '2g': 'p2g', p2g: 'p2g', '5': 'p5g', '5g': 'p5g', p5g: 'p5g' }[String(planArg || '').toLowerCase()];
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
    return A(this.adminHelp(), this.adminMenu());
  }

  adminMenu() {
    return [
      [{ text: '🧾 رسیدها', callback_data: 'ap' }, { text: '👥 کاربران', callback_data: 'U:0' }],
      [{ text: '🎁 کدهای هدیه', callback_data: 'ag' }, { text: '⚙️ تنظیمات', callback_data: 'as' }],
      [{ text: '📊 آمار', callback_data: 'am' }],
    ];
  }

  adminHelp() {
    return [
      '🛠 <b>بات مدیریت TeleTVShare</b>',
      '/stats — آمار', '/users — کاربران', '/user شناسه یا @username — مدیریت کاربر',
      '/payments — رسیدها', '/gift — ساخت کد هدیه', '/gifts — کدها', '/delgift کد — حذف کد',
      '/settings — شماره کارت، قیمت‌ها و سقف‌ها',
    ].join('\n');
  }

  giftHelp() {
    return [
      '🎁 <b>ساخت کد هدیه</b>',
      '<code>/gift پلن [روز] [تعداد استفاده]</code>',
      '', 'پلن: <code>500</code> یا <code>2g</code> یا <code>5g</code>',
      'مثال: <code>/gift 2g 30 1</code> ← یک کد ۲ گیگ، ۳۰ روزه، یک‌بار مصرف',
      'مثال: <code>/gift 500 7 20</code> ← کد ۵۰۰ مگ، ۷ روزه، برای ۲۰ نفر',
    ].join('\n');
  }

  giftsText() {
    const rows = this.q('SELECT * FROM gift_codes ORDER BY created_at DESC LIMIT 30');
    return rows.length
      ? '🎁 <b>کدهای هدیه</b>\n\n' + rows.map((g) => `<code>${g.code}</code> — ${PLANS[g.plan].title}، ${faNum(g.days)} روز — ${faNum(g.used)}/${faNum(g.max_uses)}`).join('\n')
      : 'هنوز کدی ساخته نشده.\n\n' + this.giftHelp();
  }

  paymentsText() {
    const rows = this.q(`SELECT p.*, u.first_name FROM payments p LEFT JOIN users u ON u.id=p.user_id ORDER BY p.created_at DESC LIMIT 20`);
    return rows.length
      ? '🧾 <b>آخرین پرداخت‌ها</b>\n\n' + rows.map((p) => `#${p.id} ${({ pending: '⏳', approved: '✅', rejected: '❌' })[p.status]} ${esc(p.first_name)} — ${PLANS[p.plan].title} — ${faNum(p.amount)} — ${fmtDate(p.created_at)}`).join('\n')
      : 'هنوز پرداختی ثبت نشده.';
  }

  pendingKeyboard() {
    const rows = this.q(`SELECT id FROM payments WHERE status='pending' ORDER BY id LIMIT 10`);
    return rows.length ? rows.map((p) => [{ text: `🧾 نمایش دوباره رسید #${p.id}`, callback_data: `ar:${p.id}` }]) : null;
  }

  settingsText() {
    const mult = this.setting('mult');
    return [
      '⚙️ <b>تنظیمات</b>',
      `💳 شماره کارت: <code>${esc(this.setting('card_number'))}</code>`,
      `👤 به نام: ${esc(this.setting('card_name'))}`,
      `🏦 بانک: ${esc(this.setting('card_bank'))}`,
      '',
      ...PLAN_ORDER.slice(1).map((k) => `📦 ${PLANS[k].title}: ${faNum(this.price(k))} تومان`),
      '',
      `📈 سقف آپلود و تماشای ماهانه: ${faNum(mult)} برابر فضای پلن`,
    ].join('\n');
  }

  settingsKeyboard() {
    return [
      [{ text: '💳 شماره کارت', callback_data: 'se:card_number' }, { text: '👤 نام صاحب کارت', callback_data: 'se:card_name' }],
      [{ text: '🏦 بانک', callback_data: 'se:card_bank' }, { text: '📈 ضریب سقف ماهانه', callback_data: 'se:mult' }],
      PLAN_ORDER.slice(1).map((k) => ({ text: `قیمت ${PLANS[k].title}`, callback_data: `se:price_${k}` })),
    ];
  }

  settingPrompt(key) {
    return ({
      card_number: 'شماره کارت جدید را بفرستید (۱۶ رقم):',
      card_name: 'نام صاحب کارت را بفرستید:',
      card_bank: 'نام بانک را بفرستید:',
      mult: 'ضریب سقف آپلود و تماشای ماهانه را بفرستید (مثلاً ۲۰):',
    })[key] || `قیمت جدید ${PLANS[key.replace('price_', '')]?.title || ''} را به تومان بفرستید:`;
  }

  async applySetting(chat, key, raw) {
    const A = (t, kb) => this.send(chat, t, kb, null, 'admin');
    let v = String(raw).trim().replace(/[۰-۹]/g, (d) => '۰۱۲۳۴۵۶۷۸۹'.indexOf(d)).replace(/[٠-٩]/g, (d) => '٠١٢٣٤٥٦٧٨٩'.indexOf(d));
    if (key === 'card_number') {
      v = v.replace(/[\s-]/g, '');
      if (!/^\d{16}$/.test(v)) return A('❌ شماره کارت باید ۱۶ رقم باشد. دوباره از تنظیمات امتحان کنید.', this.settingsKeyboard());
    } else if (key === 'mult' || key.startsWith('price_')) {
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
    if (op === 'gh') { await A(this.giftHelp()); return answer(); }
    if (op === 'as') { await A(this.settingsText(), this.settingsKeyboard()); return answer(); }
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
      const exp = this.activatePlan(pay.user_id, pay.plan, 30);
      if (!exp) return answer('کاربر الان پلن بزرگ‌تری دارد. اول پلنش را از /user عوض کنید.', true);
      this.sql.exec(`UPDATE payments SET status='approved', decided_at=? WHERE id=?`, Date.now(), id);
      result = `✅ تأیید شد — اعتبار تا ${fmtDate(exp, false)}`;
      await this.writeManifest(pay.user_id);
      await this.send(pay.user_id, `🎉 پرداخت شما تأیید شد!\nاشتراک <b>${PLANS[pay.plan].title}</b> تا ${fmtDate(exp, false)} فعال است.\n\n${this.accountText(this.user(pay.user_id))}`, this.menuKeyboard());
    } else {
      this.sql.exec(`UPDATE payments SET status='rejected', decided_at=? WHERE id=?`, Date.now(), id);
      result = '❌ رد شد';
      await this.send(pay.user_id, '❌ رسید شما تأیید نشد. اگر فکر می‌کنید اشتباهی رخ داده، دوباره از «خرید اشتراک» اقدام کنید و رسید درست را بفرستید.', this.menuKeyboard());
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
      `این ماه: آپلود ${fmtSize(mu.up)} از ${fmtSize(lim.upCap)} — تماشا ${fmtSize(mu.watch)} از ${fmtSize(lim.watchCap)}`,
      `تلویزیون: ${tv ? `وصل از ${fmtDate(tv.created_at, false)}` : '—'}`,
      `مجموع پرداخت: ${faNum(paid)} تومان`,
      `عضویت: ${fmtDate(u.created_at, false)} — آخرین فعالیت: ${fmtDate(u.last_seen || u.created_at)}`,
    ].join('\n');
    const kb = [
      [{ text: '➕ تمدید ۳۰ روز', callback_data: `u:${uid}:ext` }],
      [{ text: '۵۰۰ مگ', callback_data: `u:${uid}:p500` }, { text: '۲ گیگ', callback_data: `u:${uid}:p2g` }, { text: '۵ گیگ', callback_data: `u:${uid}:p5g` }, { text: 'رایگان', callback_data: `u:${uid}:free` }],
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
    const queued = this.one(`SELECT 1 AS x FROM files WHERE status='queued' LIMIT 1`);
    await this.ctx.storage.setAlarm(Date.now() + (queued ? 50 : 10 * 60_000));
  }

  // Files up to 20 MB: Telegram -> Arvan, streamed.
  async processQueue() {
    for (const s of this.q(`SELECT id FROM files WHERE status='uploading'`)) this.sql.exec(`UPDATE files SET status='queued' WHERE id=?`, s.id);
    const f = this.one(`SELECT * FROM files WHERE status='queued' ORDER BY created_at LIMIT 1`);
    if (!f) return;
    this.sql.exec(`UPDATE files SET status='uploading' WHERE id=?`, f.id);
    try {
      const { res, size } = await this.tgFile(f.tg_file_id);
      const { readable, writable } = new FixedLengthStream(size);
      res.body.pipeTo(writable).catch(() => {});
      await this.s3put(f.obj_key, readable, { type: f.mime || guessMime(f.name), disposition: this.disposition(f.name) });
      await this.finishFile(f, size);
    } catch (e) {
      console.log('upload failed', f.id, e.stack || e);
      this.sql.exec(`UPDATE files SET status='failed', error=? WHERE id=?`, String(e.message || e), f.id);
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
    const hasTv = this.one('SELECT 1 AS x FROM devices WHERE user_id=?', f.owner);
    await this.edit(f.chat_id, f.msg_id,
      `✅ <b>${esc(f.name)}</b> (${fmtSize(size)}) ذخیره شد${hasTv ? ' و روی تلویزیون نمایش داده می‌شود.' : '.\n📺 برای دیدن روی تلویزیون، تلویزیون را وصل کنید.'}\n\n${this.usageLine(f.owner)}`,
      hasTv ? [[{ text: '🗑 پاک کردن', callback_data: `d:${f.id}:0` }]]
        : [[{ text: '📺 اتصال تلویزیون', callback_data: 't' }], [{ text: '🗑 پاک کردن', callback_data: `d:${f.id}:0` }]]);
  }

  async storeThumb(f) {
    if (!f.thumb_file_id) return;
    try {
      const { res } = await this.tgFile(f.thumb_file_id);
      const buf = await res.arrayBuffer();
      if (buf.byteLength > 1_000_000) return;
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
    this.sql.exec('DELETE FROM seen2 WHERE at < ?', now - 3 * DAY);
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
          await this.send(u.id, `📺 سقف تماشای ماهانه شما (${fmtSize(lim.watchCap)}) پر شد. تا اول ماه بعد یا با ارتقای اشتراک دوباره فعال می‌شود.`,
            [[{ text: '📦 ارتقای اشتراک', callback_data: 'b' }]]);
        }
        await this.writeManifest(u.id);
      }
    }
    return false;
  }

  // ================================================================ legacy + migration
  serveLegacy(req, id) {
    const f = this.one(`SELECT id,name,mime,size,status,storage,obj_key FROM files WHERE id=?`, id);
    if (!f || f.status !== 'ready') return new Response('File not found', { status: 404 });
    if (f.storage === 'arvan') return Response.redirect(this.publicUrl(f.obj_key), 302);
    return new Response('Not available', { status: 404 });
  }

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
  async api(req, url, p) {
    const h = req.headers.get('authorization') || '';
    const token = h.startsWith('Bearer ') ? h.slice(7) : '';
    if (!this.env.API_KEY || !timingSafeEqual(token, this.env.API_KEY)) return Response.json({ error: 'unauthorized' }, { status: 401 });
    let m;
    if (p === '/api/admin/users' && req.method === 'GET') {
      return Response.json(this.q('SELECT * FROM users ORDER BY created_at').map((u) => ({
        ...u, used: this.userUsed(u.id), tv: this.one('SELECT token FROM devices WHERE user_id=?', u.id)?.token || null,
      })));
    }
    if ((m = /^\/api\/admin\/users\/(\d+)$/.exec(p)) && req.method === 'DELETE' && !this.isAdmin(m[1])) {
      const target = Number(m[1]);
      for (const f of this.q('SELECT id FROM files WHERE owner=?', target)) await this.deleteFile(f.id);
      const d = this.one('SELECT * FROM devices WHERE user_id=?', target);
      if (d) await this.removeDevice(d);
      this.sql.exec('DELETE FROM payments WHERE user_id=?', target);
      this.sql.exec('DELETE FROM gift_uses WHERE user_id=?', target);
      this.sql.exec('DELETE FROM users WHERE id=?', target);
      if (url.searchParams.has('forget')) this.sql.exec('DELETE FROM welcomed WHERE id=?', target);
      return Response.json({ ok: true });
    }
    if ((m = /^\/api\/admin\/users\/(\d+)$/.exec(p)) && req.method === 'PATCH') {
      const b = await req.json();
      for (const k of ['plan', 'expires_at', 'grace_until', 'reminded', 'up_used', 'up_month', 'watch_used', 'watch_month', 'watch_warned']) {
        if (k in b) this.sql.exec(`UPDATE users SET ${k}=? WHERE id=?`, b[k], Number(m[1]));
      }
      return Response.json(this.user(Number(m[1])));
    }
    if (p === '/api/admin/files') {
      const owner = url.searchParams.get('owner');
      return Response.json(owner
        ? this.q('SELECT id,name,size,status,storage,obj_key,thumb_key,owner,created_at FROM files WHERE owner=? ORDER BY created_at', Number(owner))
        : this.q('SELECT id,name,size,status,storage,obj_key,thumb_key,owner,created_at FROM files ORDER BY created_at'));
    }
    if (p === '/api/admin/maintenance' && req.method === 'POST') return Response.json({ more: await this.maintenance(), subrequests: this.sub });
    if (p === '/api/admin/migrate' && req.method === 'POST') {
      try { return Response.json(await this.migrateOne()); } catch (e) { return Response.json({ error: String(e.stack || e) }, { status: 500 }); }
    }
    if (p === '/api/admin/payments') return Response.json(this.q('SELECT * FROM payments ORDER BY id'));
    if (p === '/api/admin/gifts') return Response.json(this.q('SELECT * FROM gift_codes ORDER BY created_at'));
    if (p === '/api/admin/settings') return Response.json(Object.fromEntries(
      ['card_number', 'card_name', 'card_bank', 'mult', 'price_p500', 'price_p2g', 'price_p5g'].map((k) => [k, this.setting(k)])));
    return Response.json({ error: 'not found' }, { status: 404 });
  }

  // ================================================================ large-file helper (GitHub Actions)
  helperJobs() {
    const jobs = this.q(`SELECT id,name,size,mime,tg_file_id,obj_key FROM files WHERE status IN ('waiting_helper','helper_uploading') ORDER BY created_at`)
      .map((j) => ({ ...j, disposition: this.disposition(j.name) }));
    return Response.json({ jobs });
  }

  async helperProgress(req, id) {
    const f = this.one(`SELECT * FROM files WHERE id=? AND status IN ('waiting_helper','helper_uploading')`, id);
    if (!f) return new Response('no such job', { status: 404 });
    this.sql.exec(`UPDATE files SET status='helper_uploading' WHERE id=?`, id);
    const { done = 0, total = f.size, speed = 0 } = await req.json().catch(() => ({}));
    const pct = pctOf(done, total);
    await this.edit(f.chat_id, f.msg_id,
      `⏳ <b>${esc(f.name)}</b> (${fmtSize(f.size)})\nدر حال انتقال…\n${bar(pct)} ${pct}%\n${fmtSize(done)} از ${fmtSize(total)}${speed ? ` · ${fmtSize(speed)}/s` : ''}`,
      [[{ text: '❌ لغو', callback_data: `c:${id}` }]]);
    return Response.json({ ok: true });
  }

  async helperDone(req, kind, id) {
    const f = this.one(`SELECT * FROM files WHERE id=? AND status IN ('waiting_helper','helper_uploading')`, id);
    if (!f) return new Response('no such job', { status: 404 });
    if (kind === 'fail') {
      const why = (await req.text()).slice(0, 500) || 'helper error';
      this.sql.exec(`UPDATE files SET status='failed', error=? WHERE id=?`, why, id);
      await this.edit(f.chat_id, f.msg_id, `❌ ذخیره <b>${esc(f.name)}</b> ناموفق بود:\n<code>${esc(why)}</code>`,
        [[{ text: '🔁 دوباره', callback_data: `r:${id}` }, { text: '❌ لغو', callback_data: `c:${id}` }]]);
      return Response.json({ ok: true });
    }
    const size = await this.s3head(f.obj_key);
    if (!size) return new Response('object missing in Arvan', { status: 409 });
    await this.finishFile(f, size);
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
    if (/^\/f\//.test(p) && (req.method === 'GET' || req.method === 'HEAD')) return fwd(p);
    if (p.startsWith('/api/')) return fwd(p);
    if (p.startsWith('/helper/')) {
      const h = req.headers.get('authorization') || '';
      if (!env.HELPER_SECRET || !timingSafeEqual(h.replace(/^Bearer /, ''), env.HELPER_SECRET)) return new Response('unauthorized', { status: 401 });
      return fwd(p);
    }
    return new Response('Not found', { status: 404 });
  },
};
