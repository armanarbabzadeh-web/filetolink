// File-to-link: multi-user Telegram bot + file store on Cloudflare.
// Storage: one SQLite-backed Durable Object ("Store"). Files are split into chunks
// of CHUNK bytes in the `chunks` table. Every user has a plan quota; the whole
// store is capped at TOTAL_CAP (free Durable Object storage is 5 GB).
import { DurableObject } from 'cloudflare:workers';

const CHUNK = 1_900_000;              // < 2 MB SQLite row limit
const TOTAL_CAP = 4_900_000_000;      // whole store
const TG_BOT_MAX = 20 * 1024 * 1024;  // Bot API getFile download limit
const PAGE = 8;
const DAY = 864e5;
const GRACE_MS = DAY;                 // files over quota are kept 24h after expiry
const REMIND_BEFORE = 3 * DAY;
const PAIR_TTL = 10 * 60_000;
const MAINT_EVERY = 30 * 60_000;

// quota and monthly download cap (bw) in bytes, price in toman
const PLANS = {
  free: { title: 'رایگان', quota: 100e6, bw: 1e9, price: 0 },
  p500: { title: '۵۰۰ مگابایت', quota: 500e6, bw: 5e9, price: 50_000 },
  p2g: { title: '۲ گیگابایت', quota: 2e9, bw: 20e9, price: 150_000 },
  p5g: { title: '۵ گیگابایت', quota: 5e9, bw: 50e9, price: 350_000 },
};
const PLAN_ORDER = ['free', 'p500', 'p2g', 'p5g'];
const ACTIVE = `('ready','uploading','queued','waiting_helper','helper_uploading')`;

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
const randomDigits = (n) => randomId(n, '0123456789');
const giftCode = () => randomId(4, 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789') + '-' + randomId(4, 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789');

const faNum = (n) => new Intl.NumberFormat('fa-IR').format(n);

function fmtSize(n) {
  if (n == null) return '?';
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
const bar = (pct) => {
  const k = Math.max(0, Math.min(10, Math.round(pct / 10)));
  return '█'.repeat(k) + '░'.repeat(10 - k);
};

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
      CREATE TABLE IF NOT EXISTS seen(update_id INTEGER PRIMARY KEY, at INTEGER);
      CREATE TABLE IF NOT EXISTS users(
        id INTEGER PRIMARY KEY, first_name TEXT, username TEXT,
        plan TEXT NOT NULL DEFAULT 'free', expires_at INTEGER, grace_until INTEGER,
        reminded INTEGER NOT NULL DEFAULT 0, banned INTEGER NOT NULL DEFAULT 0, state TEXT,
        bw_month TEXT, bw_used INTEGER NOT NULL DEFAULT 0, bw_warned INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL, last_seen INTEGER);
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
      CREATE TABLE IF NOT EXISTS pairs(code TEXT PRIMARY KEY, secret TEXT NOT NULL UNIQUE,
        name TEXT, created_at INTEGER NOT NULL, user_id INTEGER, token TEXT);
      CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT);
    `);
    // migration: files.owner (files from the single-user version belong to the admin)
    const cols = this.q('PRAGMA table_info(files)').map((c) => c.name);
    if (!cols.includes('owner')) {
      this.sql.exec('ALTER TABLE files ADD COLUMN owner INTEGER');
      this.sql.exec('UPDATE files SET owner=? WHERE owner IS NULL', Number(env.OWNER_ID));
    }
    this.sql.exec('CREATE INDEX IF NOT EXISTS files_owner ON files(owner, created_at)');
  }

  // ---- storage primitives
  q(query, ...args) { return this.sql.exec(query, ...args).toArray(); }
  one(query, ...args) { return this.q(query, ...args)[0] || null; }
  meta(key, value) {
    if (value === undefined) return this.one('SELECT value FROM meta WHERE key=?', key)?.value ?? null;
    this.sql.exec('INSERT OR REPLACE INTO meta(key,value) VALUES (?,?)', key, String(value));
  }

  isAdmin(id) { return String(id) === String(this.env.OWNER_ID); }
  totalUsed() { return this.one(`SELECT COALESCE(SUM(size),0) AS s FROM files WHERE status IN ${ACTIVE}`).s; }
  userUsed(uid) { return this.one(`SELECT COALESCE(SUM(size),0) AS s FROM files WHERE owner=? AND status IN ${ACTIVE}`, uid).s; }
  user(uid) { return this.one('SELECT * FROM users WHERE id=?', uid); }

  // Effective limits for a user. The admin is limited only by the whole store.
  limits(u) {
    if (this.isAdmin(u.id)) return { plan: 'admin', title: 'مدیر', quota: TOTAL_CAP, bw: Infinity };
    const p = PLANS[u.plan] || PLANS.free;
    return { plan: u.plan, title: p.title, quota: p.quota, bw: p.bw };
  }

  freeFor(u) {
    const lim = this.limits(u);
    return Math.max(0, Math.min(lim.quota - this.userUsed(u.id), TOTAL_CAP - this.totalUsed()));
  }

  touchUser(from) {
    const now = Date.now();
    this.sql.exec(`INSERT INTO users(id, first_name, username, created_at, last_seen) VALUES (?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET first_name=excluded.first_name, username=excluded.username, last_seen=excluded.last_seen`,
      from.id, from.first_name || '', from.username || null, now, now);
    return this.user(from.id);
  }

  link(f) { return `${this.env.PUBLIC_URL}/f/${f.id}/${encodeURIComponent(f.name)}`; }

  deleteFile(id) {
    this.sql.exec('DELETE FROM chunks WHERE file_id=?', id);
    this.sql.exec('DELETE FROM files WHERE id=?', id);
  }

  async writeStream(id, body, startIdx = 0) {
    const reader = body.getReader();
    const buf = new Uint8Array(CHUNK);
    let fill = 0, idx = startIdx, total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      let off = 0;
      while (off < value.length) {
        const n = Math.min(CHUNK - fill, value.length - off);
        buf.set(value.subarray(off, off + n), fill);
        fill += n; off += n;
        if (fill === CHUNK) {
          this.sql.exec('INSERT OR REPLACE INTO chunks(file_id, idx, data) VALUES (?,?,?)', id, idx++, buf);
          total += fill; fill = 0;
        }
      }
    }
    if (fill) {
      this.sql.exec('INSERT OR REPLACE INTO chunks(file_id, idx, data) VALUES (?,?,?)', id, idx++, buf.slice(0, fill));
      total += fill;
    }
    return total;
  }

  // ---- Telegram API
  async tg(method, body) {
    const r = await fetch(`https://api.telegram.org/bot${this.env.BOT_TOKEN}/${method}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    const j = await r.json().catch(() => ({ ok: false, description: `HTTP ${r.status}` }));
    if (!j.ok && !/not modified/.test(j.description || '')) console.log('tg error', method, j.description);
    return j;
  }

  async edit(chatId, msgId, text, keyboard) {
    return this.tg('editMessageText', {
      chat_id: chatId, message_id: msgId, text, parse_mode: 'HTML',
      link_preview_options: { is_disabled: true },
      reply_markup: keyboard ? { inline_keyboard: keyboard } : undefined,
    });
  }

  async send(chatId, text, keyboard, replyTo) {
    return this.tg('sendMessage', {
      chat_id: chatId, text, parse_mode: 'HTML',
      link_preview_options: { is_disabled: true },
      reply_parameters: replyTo ? { message_id: replyTo, allow_sending_without_reply: true } : undefined,
      reply_markup: keyboard ? { inline_keyboard: keyboard } : undefined,
    });
  }

  notifyAdmin(text, keyboard) { return this.send(Number(this.env.OWNER_ID), text, keyboard); }

  async tgDownload(fileId) {
    const gf = await this.tg('getFile', { file_id: fileId });
    if (!gf.ok) throw new Error(gf.description || 'getFile failed');
    const r = await fetch(`https://api.telegram.org/file/bot${this.env.BOT_TOKEN}/${gf.result.file_path}`);
    if (!r.ok || !r.body) throw new Error(`download failed: HTTP ${r.status}`);
    return r;
  }

  // ---- HTTP entry (called by the Worker)
  async fetch(req) {
    const url = new URL(req.url);
    const p = url.pathname;
    try {
      await this.ensureAlarm();
      if (p === '/tg') {
        await this.onUpdate(await req.json());
        return new Response('ok');
      }
      let m;
      if ((m = /^\/f\/([A-Za-z0-9]{16})(?:\/.*)?$/.exec(p))) return this.serve(req, m[1], url);
      if ((m = /^\/t\/([A-Za-z0-9]{16})$/.exec(p))) return this.serveThumb(m[1]);
      if (p === '/api/tv/pair' && req.method === 'POST') return this.pairStart(req);
      if ((m = /^\/api\/tv\/pair\/([A-Za-z0-9]{32})$/.exec(p))) return this.pairPoll(m[1]);
      if (p.startsWith('/api/')) return this.api(req, url, p);
      if (p.startsWith('/helper/')) {
        if (p === '/helper/jobs') return this.helperJobs();
        if ((m = /^\/helper\/upload\/([A-Za-z0-9]{16})$/.exec(p))) return this.helperUpload(req, m[1], url);
        if ((m = /^\/helper\/(finish|fail)\/([A-Za-z0-9]{16})$/.exec(p))) return this.helperDone(req, m[1], m[2]);
        if ((m = /^\/helper\/progress\/([A-Za-z0-9]{16})$/.exec(p))) return this.helperProgress(req, m[1]);
      }
      return new Response('Not found', { status: 404 });
    } catch (e) {
      console.log('error', p, e.stack || e);
      return new Response('Internal error', { status: 500 });
    }
  }

  // ================================================================ Telegram
  async onUpdate(u) {
    if (u.update_id != null) {
      if (this.one('SELECT 1 AS x FROM seen WHERE update_id=?', u.update_id)) return;
      this.sql.exec('INSERT INTO seen(update_id, at) VALUES (?,?)', u.update_id, Date.now());
    }
    if (u.callback_query) return this.onCallback(u.callback_query);
    const m = u.message;
    if (!m || m.chat?.type !== 'private' || !m.from) return;
    const user = this.touchUser(m.from);
    if (user.banned && !this.isAdmin(user.id)) return this.send(m.chat.id, '⛔️ حساب شما مسدود شده است.');

    const text = (m.text || '').trim();
    const cmd = /^\/(\w+)(?:@\w+)?\s*(.*)$/s.exec(text);
    if (cmd) {
      const [, name, arg] = cmd;
      if (user.state && name !== 'start') this.setState(user.id, null);
      return this.onCommand(m, user, name.toLowerCase(), arg.trim());
    }

    // waiting for a receipt
    if (user.state?.startsWith('receipt:') && (m.photo || m.document)) return this.onReceipt(m, user, user.state.slice(8));
    // waiting for a gift code
    if (user.state === 'gift' && text) { this.setState(user.id, null); return this.redeem(m.chat.id, user, text); }
    // waiting for a TV code
    if (user.state === 'tv' && /^\d{6}$/.test(text.replace(/\s/g, ''))) {
      this.setState(user.id, null);
      return this.linkTv(m.chat.id, user, text.replace(/\s/g, ''));
    }

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
    if (name === 'help' || name === 'menu') return this.sendMenu(chat, user);
    if (name === 'list') return this.sendList(chat, user.id, 0);
    if (name === 'usage' || name === 'account') return this.send(chat, this.accountText(user), this.menuKeyboard(user));
    if (name === 'buy' || name === 'plans') return this.send(chat, this.plansText(user), this.plansKeyboard(user));
    if (name === 'code' || name === 'gift' && !this.isAdmin(user.id)) {
      if (arg) return this.redeem(chat, user, arg);
      this.setState(user.id, 'gift');
      return this.send(chat, '🎁 کد هدیه را بفرستید:');
    }
    if (name === 'tv') {
      if (/^\d{6}$/.test(arg)) return this.linkTv(chat, user, arg);
      return this.sendTvStatus(chat, user);
    }
    if (name === 'cancel') return this.send(chat, 'لغو شد.', this.menuKeyboard(user));
    if (this.isAdmin(user.id)) return this.onAdminCommand(chat, name, arg);
    return this.sendMenu(chat, user);
  }

  // ---- menus & account
  menuKeyboard(user) {
    return [
      [{ text: '📦 خرید یا تمدید اشتراک', callback_data: 'b' }],
      [{ text: '📂 فایل‌های من', callback_data: 'l:0' }, { text: '👤 حساب من', callback_data: 'a' }],
      [{ text: '🎁 کد هدیه', callback_data: 'g' }, { text: '📺 تلویزیون', callback_data: 't' }],
    ];
  }

  async sendMenu(chat, user, welcome = false) {
    const head = welcome
      ? `👋 سلام ${esc(user.first_name || '')}!\nهر فایلی (عکس، ویدیو، سند، صوت) برایم بفرستی، لینک مستقیم دانلودش را می‌دهم. فایل‌هایت در اپ تلویزیون هم دیده می‌شوند.\n\n`
      : '';
    return this.send(chat, head + this.accountText(user), this.menuKeyboard(user));
  }

  accountText(user) {
    user = this.user(user.id) || user;
    const lim = this.limits(user);
    const used = this.userUsed(user.id);
    const pct = lim.quota ? Math.round((used / lim.quota) * 100) : 0;
    const lines = [`👤 پلن: <b>${lim.title}</b>`];
    if (user.expires_at && user.plan !== 'free') lines.push(`⏳ اعتبار تا ${fmtDate(user.expires_at, false)}`);
    lines.push(`💾 ${bar(pct)} ${pct}%`, `${fmtSize(used)} از ${fmtSize(lim.quota)}`);
    if (Number.isFinite(lim.bw)) {
      const bw = user.bw_month === monthKey() ? user.bw_used : 0;
      lines.push(`📶 دانلود این ماه: ${fmtSize(bw)} از ${fmtSize(lim.bw)}`);
    }
    if (user.grace_until) lines.push(`\n⚠️ اشتراک شما تمام شده و فایل‌های بیش از ${fmtSize(lim.quota)} تا ${fmtDate(user.grace_until)} پاک می‌شوند. برای جلوگیری، اشتراک را تمدید کنید.`);
    return lines.join('\n');
  }

  usageLine(uid) {
    const u = this.user(uid);
    const lim = this.limits(u);
    const used = this.userUsed(uid);
    return `💾 ${fmtSize(used)} از ${fmtSize(lim.quota)}`;
  }

  // ---- plans & payment
  plansText(user) {
    const lines = ['📦 <b>پلن‌های اشتراک ماهانه</b>', ''];
    for (const k of PLAN_ORDER) {
      const p = PLANS[k];
      lines.push(k === 'free'
        ? `• ${p.title}: ${fmtSize(p.quota)} فضا`
        : `• <b>${p.title}</b> — ${faNum(p.price)} تومان در ماه (دانلود ماهانه تا ${fmtSize(p.bw)})`);
    }
    lines.push('', `پلن فعلی شما: ${this.limits(user).title}`);
    return lines.join('\n');
  }

  plansKeyboard(user) {
    const cur = PLAN_ORDER.indexOf(user.plan);
    const active = user.plan !== 'free' && user.expires_at > Date.now();
    const rows = PLAN_ORDER.slice(1)
      .filter((k) => !active || PLAN_ORDER.indexOf(k) >= cur)
      .map((k) => [{
        text: `${k === user.plan && active ? '🔄 تمدید' : '🛒'} ${PLANS[k].title} — ${faNum(PLANS[k].price)} تومان`,
        callback_data: `B:${k}`,
      }]);
    rows.push([{ text: '🎁 کد هدیه دارم', callback_data: 'g' }]);
    return rows;
  }

  paymentText(plan) {
    const p = PLANS[plan];
    return [
      `🛒 پلن <b>${p.title}</b> — یک ماه`,
      `💳 مبلغ: <b>${faNum(p.price)} تومان</b>`,
      '',
      `شماره کارت: <code>${esc(this.env.CARD_NUMBER)}</code>`,
      `به نام: ${esc(this.env.CARD_NAME)} — ${esc(this.env.CARD_BANK)}`,
      '',
      '✅ بعد از واریز، <b>عکس رسید</b> را همین‌جا بفرستید.',
      'بعد از بررسی (معمولاً چند دقیقه) اشتراک شما فعال می‌شود.',
    ].join('\n');
  }

  async onReceipt(m, user, plan) {
    if (!PLANS[plan] || plan === 'free') return;
    this.setState(user.id, null);
    const isPhoto = !!m.photo;
    const fileId = isPhoto ? m.photo[m.photo.length - 1].file_id : m.document.file_id;
    this.sql.exec(`INSERT INTO payments(user_id, plan, amount, status, file_id, is_photo, created_at)
      VALUES (?,?,?,?,?,?,?)`, user.id, plan, PLANS[plan].price, 'pending', fileId, isPhoto ? 1 : 0, Date.now());
    const pay = this.one('SELECT * FROM payments WHERE id=last_insert_rowid()');
    const caption = this.paymentCaption(pay, user) + '\n\n⏳ در انتظار تأیید';
    const kb = { inline_keyboard: [[{ text: '✅ تأیید', callback_data: `pa:${pay.id}` }, { text: '❌ رد', callback_data: `pr:${pay.id}` }]] };
    const sent = await this.tg(isPhoto ? 'sendPhoto' : 'sendDocument', {
      chat_id: Number(this.env.OWNER_ID), [isPhoto ? 'photo' : 'document']: fileId,
      caption, parse_mode: 'HTML', reply_markup: kb,
    });
    if (sent.ok) this.sql.exec('UPDATE payments SET admin_msg_id=? WHERE id=?', sent.result.message_id, pay.id);
    return this.send(m.chat.id, '🧾 رسید دریافت شد. بعد از بررسی (معمولاً چند دقیقه) اشتراک شما فعال می‌شود و همین‌جا خبرتان می‌کنم.', null, m.message_id);
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

  // Activate (or extend) a plan. Returns false if it would downgrade an active plan.
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

  async decidePayment(cb, id, approve) {
    const pay = this.one('SELECT * FROM payments WHERE id=?', id);
    if (!pay) return;
    const user = this.user(pay.user_id);
    if (pay.status !== 'pending') {
      return this.tg('answerCallbackQuery', { callback_query_id: cb.id, text: 'قبلاً بررسی شده' });
    }
    let result;
    if (approve) {
      const exp = this.activatePlan(pay.user_id, pay.plan, 30);
      if (!exp) {
        return this.tg('answerCallbackQuery', { callback_query_id: cb.id, show_alert: true,
          text: 'کاربر الان پلن بزرگ‌تری دارد. اول پلنش را از /user عوض کنید.' });
      }
      this.sql.exec(`UPDATE payments SET status='approved', decided_at=? WHERE id=?`, Date.now(), id);
      result = `✅ تأیید شد — اعتبار تا ${fmtDate(exp, false)}`;
      await this.send(pay.user_id, `🎉 پرداخت شما تأیید شد!\nپلن <b>${PLANS[pay.plan].title}</b> تا ${fmtDate(exp, false)} فعال است.\n\n${this.accountText(this.user(pay.user_id))}`, this.menuKeyboard(user));
    } else {
      this.sql.exec(`UPDATE payments SET status='rejected', decided_at=? WHERE id=?`, Date.now(), id);
      result = '❌ رد شد';
      await this.send(pay.user_id, '❌ رسید شما تأیید نشد. اگر فکر می‌کنید اشتباهی رخ داده، دوباره از «خرید اشتراک» اقدام کنید و رسید درست را بفرستید.', this.menuKeyboard(user));
    }
    await this.tg('editMessageCaption', {
      chat_id: cb.message.chat.id, message_id: cb.message.message_id, parse_mode: 'HTML',
      caption: `${this.paymentCaption(pay, user)}\n\n${result}`,
    });
    return this.tg('answerCallbackQuery', { callback_query_id: cb.id, text: approve ? 'تأیید شد' : 'رد شد' });
  }

  // ---- gift codes
  async redeem(chat, user, raw) {
    const code = String(raw).trim().toUpperCase().replace(/\s+/g, '');
    const g = this.one('SELECT * FROM gift_codes WHERE code=?', code);
    if (!g) return this.send(chat, '❌ این کد هدیه معتبر نیست.', this.menuKeyboard(user));
    if (g.used >= g.max_uses) return this.send(chat, '❌ ظرفیت استفاده از این کد تمام شده است.', this.menuKeyboard(user));
    if (this.one('SELECT 1 AS x FROM gift_uses WHERE code=? AND user_id=?', code, user.id)) {
      return this.send(chat, '❌ شما قبلاً از این کد استفاده کرده‌اید.', this.menuKeyboard(user));
    }
    const exp = this.activatePlan(user.id, g.plan, g.days);
    if (!exp) return this.send(chat, '❌ اشتراک فعلی شما از پلن این کد بزرگ‌تر است. بعد از پایان اشتراک فعلی از کد استفاده کنید.', this.menuKeyboard(user));
    this.sql.exec('UPDATE gift_codes SET used=used+1 WHERE code=?', code);
    this.sql.exec('INSERT INTO gift_uses(code, user_id, at) VALUES (?,?,?)', code, user.id, Date.now());
    await this.notifyAdmin(`🎁 کد <code>${code}</code> توسط ${esc(user.first_name)} (<code>${user.id}</code>) استفاده شد — ${g.used + 1}/${g.max_uses}`);
    return this.send(chat, `🎉 کد هدیه فعال شد!\nپلن <b>${PLANS[g.plan].title}</b> تا ${fmtDate(exp, false)}\n\n${this.accountText(this.user(user.id))}`, this.menuKeyboard(user));
  }

  // ---- TV pairing
  async pairStart(req) {
    const body = await req.json().catch(() => ({}));
    this.sql.exec('DELETE FROM pairs WHERE created_at < ?', Date.now() - PAIR_TTL);
    let code;
    do code = randomDigits(6); while (this.one('SELECT 1 AS x FROM pairs WHERE code=?', code));
    const secret = randomId(32);
    this.sql.exec('INSERT INTO pairs(code, secret, name, created_at) VALUES (?,?,?,?)',
      code, secret, String(body.name || 'Android TV').slice(0, 60), Date.now());
    return Response.json({
      code, secret, expires_in: PAIR_TTL / 1000,
      link: `https://t.me/${this.env.BOT_USERNAME}?start=tv_${code}`, bot: this.env.BOT_USERNAME,
    });
  }

  pairPoll(secret) {
    const p = this.one('SELECT * FROM pairs WHERE secret=?', secret);
    if (!p || p.created_at < Date.now() - PAIR_TTL) return Response.json({ status: 'expired' });
    if (!p.token) return Response.json({ status: 'pending' });
    this.sql.exec('DELETE FROM pairs WHERE secret=?', secret);
    const u = this.user(p.user_id);
    return Response.json({ status: 'linked', token: p.token, user: u?.first_name || '' });
  }

  async linkTv(chat, user, code) {
    const p = this.one('SELECT * FROM pairs WHERE code=?', code);
    if (!p || p.created_at < Date.now() - PAIR_TTL || p.token) {
      return this.send(chat, '❌ این کد معتبر نیست یا منقضی شده. کد جدید را از صفحه تلویزیون بخوانید.', this.menuKeyboard(user));
    }
    const old = this.one('SELECT * FROM devices WHERE user_id=?', user.id);
    const token = randomId(40);
    this.sql.exec('DELETE FROM devices WHERE user_id=?', user.id);
    this.sql.exec('INSERT INTO devices(token, user_id, name, created_at) VALUES (?,?,?,?)', token, user.id, p.name, Date.now());
    this.sql.exec('UPDATE pairs SET user_id=?, token=? WHERE code=?', user.id, token, code);
    return this.send(chat, `📺 تلویزیون «${esc(p.name)}» به حساب شما وصل شد.${old ? `\nتلویزیون قبلی («${esc(old.name)}») قطع شد.` : ''}`, this.menuKeyboard(user));
  }

  tvStatus(user) {
    const d = this.one('SELECT * FROM devices WHERE user_id=?', user.id);
    if (!d) {
      return {
        text: '📺 هیچ تلویزیونی به حساب شما وصل نیست.\n\nاپ را روی تلویزیون باز کنید؛ یک کد ۶ رقمی و QR نشان می‌دهد. QR را با دوربین گوشی اسکن کنید یا کد را همین‌جا بفرستید.\n\nهر حساب فقط روی یک تلویزیون کار می‌کند.',
        kb: [[{ text: '🔢 وارد کردن کد تلویزیون', callback_data: 'tc' }]],
      };
    }
    return {
      text: `📺 تلویزیون وصل: <b>${esc(d.name)}</b>\nاز ${fmtDate(d.created_at)}${d.last_seen ? `\nآخرین فعالیت: ${fmtDate(d.last_seen)}` : ''}\n\nبا وصل کردن تلویزیون دیگر، این یکی خودکار قطع می‌شود.`,
      kb: [[{ text: '🔌 قطع این تلویزیون', callback_data: 'tu' }], [{ text: '🔢 وصل کردن تلویزیون دیگر', callback_data: 'tc' }]],
    };
  }

  sendTvStatus(chat, user) {
    const v = this.tvStatus(user);
    return this.send(chat, v.text, v.kb);
  }

  // ---- files
  async addFile(m, user, media) {
    const lim = this.limits(user);
    if (media.size > lim.quota) {
      return this.send(m.chat.id, `❌ این فایل (${fmtSize(media.size)}) از کل فضای پلن شما (${fmtSize(lim.quota)}) بزرگ‌تر است.`,
        this.isAdmin(user.id) ? null : [[{ text: '📦 خرید فضای بیشتر', callback_data: 'b' }]], m.message_id);
    }
    if (media.size > TOTAL_CAP - this.totalUsed() && media.size <= lim.quota - this.userUsed(user.id)) {
      await this.notifyAdmin(`⚠️ فضای کل سرور پر است (${fmtSize(this.totalUsed())} از ${fmtSize(TOTAL_CAP)}). کاربر <code>${user.id}</code> نتوانست فایل ${fmtSize(media.size)} آپلود کند.`);
      if (!this.isAdmin(user.id)) return this.send(m.chat.id, '⚠️ ظرفیت سرور موقتاً پر است. لطفاً کمی بعد دوباره امتحان کنید.', null, m.message_id);
    }
    const id = randomId();
    const free = this.freeFor(user);
    const status = media.size > free ? 'waiting_space' : media.size > TG_BOT_MAX ? 'waiting_helper' : 'queued';
    this.sql.exec(`INSERT INTO files(id,name,mime,size,kind,status,tg_file_id,thumb_file_id,width,height,duration,chat_id,created_at,owner)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      id, media.name, media.mime, media.size, media.kind, status, media.fileId, media.thumbId,
      media.width, media.height, media.duration, m.chat.id, Date.now(), user.id);
    const sent = await this.send(m.chat.id, `⏳ <b>${esc(media.name)}</b> (${fmtSize(media.size)})`, null, m.message_id);
    if (sent.ok) this.sql.exec('UPDATE files SET msg_id=? WHERE id=?', sent.result.message_id, id);
    await this.afterStatus(id);
  }

  async afterStatus(id) {
    const f = this.one('SELECT * FROM files WHERE id=?', id);
    if (!f) return;
    const title = `<b>${esc(f.name)}</b> (${fmtSize(f.size)})`;
    if (f.status === 'queued') {
      await this.edit(f.chat_id, f.msg_id, `⏳ ${title}\nدر حال آپلود…`);
      await this.ctx.storage.setAlarm(Date.now() + 50);
    } else if (f.status === 'waiting_helper') {
      const woke = await this.wakeHelper();
      await this.edit(f.chat_id, f.msg_id, woke
        ? `⏳ ${title}\nفایل بزرگ‌تر از ۲۰ مگ است؛ انتقال آن تا حدود یک دقیقه دیگر شروع می‌شود.`
        : `🕓 ${title}\nفایل در صف انتقال ماند و به‌زودی آپلود می‌شود.`,
        [[{ text: '❌ لغو', callback_data: `c:${id}` }]]);
    } else if (f.status === 'waiting_space') {
      await this.showSpacePicker(f, 0);
    }
  }

  async wakeHelper() {
    if (this.env.GITHUB_TOKEN && this.env.GITHUB_REPO) {
      const r = await fetch(`https://api.github.com/repos/${this.env.GITHUB_REPO}/dispatches`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.env.GITHUB_TOKEN}`, accept: 'application/vnd.github+json',
          'user-agent': 'filetolink-worker', 'content-type': 'application/json',
        },
        body: JSON.stringify({ event_type: 'large-file' }),
      }).catch((e) => ({ ok: false, status: String(e) }));
      if (!r.ok) console.log('github dispatch failed', r.status);
      return r.ok;
    }
    if (!this.env.HELPER_URL) return false;
    try {
      const r = await fetch(`${this.env.HELPER_URL.replace(/\/$/, '')}/wake`, {
        method: 'POST', headers: { authorization: `Bearer ${this.env.HELPER_SECRET}` }, signal: AbortSignal.timeout(5000),
      });
      return r.ok || r.status >= 500;
    } catch {
      return true;
    }
  }

  async showSpacePicker(pending, page) {
    const user = this.user(pending.owner);
    const lim = this.limits(user);
    const free = this.freeFor(user);
    const rows = this.q(`SELECT id,name,size,created_at FROM files WHERE status='ready' AND owner=?
      ORDER BY created_at ASC LIMIT ? OFFSET ?`, pending.owner, PAGE + 1, page * PAGE);
    const more = rows.length > PAGE;
    const kb = rows.slice(0, PAGE).map((f) => [{
      text: `🗑 ${short(f.name, 22)} · ${fmtSize(f.size)} · ${fmtDate(f.created_at, false)}`,
      callback_data: `x:${f.id}:${pending.id}`,
    }]);
    const nav = [];
    if (page > 0) nav.push({ text: '« قدیمی‌تر', callback_data: `q:${pending.id}:${page - 1}` });
    if (more) nav.push({ text: 'جدیدتر »', callback_data: `q:${pending.id}:${page + 1}` });
    if (nav.length) kb.push(nav);
    if (!this.isAdmin(user.id)) kb.push([{ text: '📦 خرید فضای بیشتر', callback_data: 'b' }]);
    kb.push([{ text: '❌ لغو آپلود این فایل', callback_data: `c:${pending.id}` }]);
    const text = [
      '⚠️ <b>فضا کافی نیست</b>',
      `فایل: <b>${esc(pending.name)}</b> (${fmtSize(pending.size)})`,
      `فضای آزاد شما: ${fmtSize(free)} از ${fmtSize(lim.quota)} — باید ${fmtSize(pending.size - free)} دیگر آزاد شود.`,
      '',
      rows.length ? 'فایل‌های قدیمی شما (قدیمی‌ترین اول). روی هر کدام بزنید تا پاک شود:' : 'برای آپلود این فایل، فضای بیشتری بخرید.',
    ].join('\n');
    await this.edit(pending.chat_id, pending.msg_id, text, kb);
  }

  listView(uid, page) {
    const total = this.one(`SELECT COUNT(*) AS c FROM files WHERE status='ready' AND owner=?`, uid).c;
    const rows = this.q(`SELECT id,name,size,created_at FROM files WHERE status='ready' AND owner=?
      ORDER BY created_at DESC LIMIT ? OFFSET ?`, uid, PAGE, page * PAGE);
    if (!total) return { text: `📭 هنوز فایلی نداری. هر فایلی بفرستی اینجا می‌آید.\n\n${this.usageLine(uid)}`, kb: null };
    const lines = rows.map((f, i) =>
      `${page * PAGE + i + 1}. <a href="${esc(this.link(f))}">${esc(short(f.name, 40))}</a>\n     ${fmtSize(f.size)} · ${fmtDate(f.created_at)}`);
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
    return f && (String(f.owner) === String(uid) || this.isAdmin(uid));
  }

  // ---- buttons
  async onCallback(cb) {
    const chatId = cb.message?.chat?.id, msgId = cb.message?.message_id;
    const answer = (text, alert = false) => this.tg('answerCallbackQuery', { callback_query_id: cb.id, text, show_alert: alert });
    const user = this.touchUser(cb.from);
    if (user.banned && !this.isAdmin(user.id)) return answer('⛔️ حساب شما مسدود است', true);
    const [op, a, b] = String(cb.data || '').split(':');
    const admin = this.isAdmin(user.id);

    switch (op) {
      case 'm': await this.edit(chatId, msgId, this.accountText(user), this.menuKeyboard(user)); return answer();
      case 'a': await this.send(chatId, this.accountText(user), this.menuKeyboard(user)); return answer();
      case 'b': await this.send(chatId, this.plansText(user), this.plansKeyboard(user)); return answer();
      case 'B': {
        if (!PLANS[a] || a === 'free') return answer();
        this.setState(user.id, `receipt:${a}`);
        await this.send(chatId, this.paymentText(a), [[{ text: '❌ انصراف', callback_data: 'bc' }]]);
        return answer();
      }
      case 'bc': this.setState(user.id, null); await this.edit(chatId, msgId, 'خرید لغو شد.', this.menuKeyboard(user)); return answer();
      case 'g': this.setState(user.id, 'gift'); await this.send(chatId, '🎁 کد هدیه را بفرستید:'); return answer();
      case 't': { const v = this.tvStatus(user); await this.send(chatId, v.text, v.kb); return answer(); }
      case 'tc': this.setState(user.id, 'tv'); await this.send(chatId, '🔢 کد ۶ رقمی که روی صفحه تلویزیون است را بفرستید:'); return answer();
      case 'tu': {
        this.sql.exec('DELETE FROM devices WHERE user_id=?', user.id);
        const v = this.tvStatus(user);
        await this.edit(chatId, msgId, v.text, v.kb);
        return answer('تلویزیون قطع شد');
      }
      case 'l': { const v = this.listView(user.id, Number(a) || 0); await this.send(chatId, v.text, v.kb); return answer(); }
      case 'L': { const v = this.listView(user.id, Number(a) || 0); await this.edit(chatId, msgId, v.text, v.kb); return answer(); }
      case 'd': {
        if (!this.canTouch(user.id, a)) return answer('این فایل دیگر وجود ندارد');
        const f = this.one('SELECT id,name,size FROM files WHERE id=?', a);
        await this.edit(chatId, msgId, `🗑 این فایل پاک شود؟\n<b>${esc(f.name)}</b> (${fmtSize(f.size)})\n\nلینکش دیگر کار نمی‌کند.`, [[
          { text: '✅ بله، پاک کن', callback_data: `D:${a}:${b}` }, { text: '↩️ برگشت', callback_data: `L:${b}` },
        ]]);
        return answer();
      }
      case 'D': {
        if (this.canTouch(user.id, a)) this.deleteFile(a);
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
        await this.edit(chatId, msgId, `🗑 این فایل پاک شود؟\n<b>${esc(f.name)}</b> (${fmtSize(f.size)})\nآپلود: ${fmtDate(f.created_at)}\n\nلینکش دیگر کار نمی‌کند.`, [[
          { text: '✅ بله، پاک کن', callback_data: `X:${a}:${b}` }, { text: '↩️ برگشت', callback_data: `q:${b}:0` },
        ]]);
        return answer();
      }
      case 'X': {
        if (this.canTouch(user.id, a)) this.deleteFile(a);
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
          this.deleteFile(a);
          await this.edit(chatId, msgId, `❌ آپلود <b>${esc(p.name)}</b> لغو شد.`);
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

    if (!admin) return answer();
    // ---- admin buttons
    if (op === 'pa' || op === 'pr') return this.decidePayment(cb, Number(a), op === 'pa');
    if (op === 'u') { // u:<uid>:<action>
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
        await this.send(target.id, `ℹ️ پلن حساب شما توسط مدیر به‌روز شد.\n\n${this.accountText(this.user(target.id))}`, this.menuKeyboard(target));
      } else if (b === 'ban' || b === 'unban') {
        this.sql.exec('UPDATE users SET banned=? WHERE id=?', b === 'ban' ? 1 : 0, target.id);
        note = b === 'ban' ? 'مسدود شد' : 'آزاد شد';
      }
      const v = this.adminUserView(target.id);
      await this.edit(chatId, msgId, v.text, v.kb);
      return answer(note);
    }
    if (op === 'U') { const v = this.adminUsersView(Number(a) || 0); await this.edit(chatId, msgId, v.text, v.kb); return answer(); }
    if (op === 'uv') { const v = this.adminUserView(Number(a)); await this.send(chatId, v.text, v.kb); return answer(); }
    return answer();
  }

  // ================================================================ admin
  async onAdminCommand(chat, name, arg) {
    if (name === 'admin' || name === 'stats') return this.send(chat, this.adminStats(), [
      [{ text: '👥 کاربران', callback_data: 'U:0' }],
    ]);
    if (name === 'users') { const v = this.adminUsersView(0); return this.send(chat, v.text, v.kb); }
    if (name === 'user') {
      const id = Number(arg.replace('@', '')) || this.one('SELECT id FROM users WHERE username=?', arg.replace('@', ''))?.id;
      if (!id || !this.user(id)) return this.send(chat, 'کاربر پیدا نشد. مثال: <code>/user 123456789</code> یا <code>/user @username</code>');
      const v = this.adminUserView(id);
      return this.send(chat, v.text, v.kb);
    }
    if (name === 'gift') {
      // /gift <plan> [days] [uses]
      const [planArg, daysArg, usesArg] = arg.split(/\s+/);
      const plan = { 500: 'p500', p500: 'p500', '2': 'p2g', '2g': 'p2g', p2g: 'p2g', '5': 'p5g', '5g': 'p5g', p5g: 'p5g' }[String(planArg || '').toLowerCase()];
      if (!plan) {
        return this.send(chat, [
          '🎁 <b>ساخت کد هدیه</b>',
          '<code>/gift پلن [روز] [تعداد استفاده]</code>',
          '', 'پلن: <code>500</code> یا <code>2g</code> یا <code>5g</code>',
          'مثال: <code>/gift 2g 30 1</code> → یک کد ۲ گیگ، ۳۰ روزه، یک‌بار مصرف',
          'مثال: <code>/gift 500 7 20</code> → کد ۵۰۰ مگ، ۷ روزه، برای ۲۰ نفر',
        ].join('\n'));
      }
      const days = Math.max(1, Math.min(365, Number(daysArg) || 30));
      const uses = Math.max(1, Math.min(10000, Number(usesArg) || 1));
      const code = giftCode();
      this.sql.exec('INSERT INTO gift_codes(code, plan, days, max_uses, created_at) VALUES (?,?,?,?,?)', code, plan, days, uses, Date.now());
      return this.send(chat, [
        `🎁 کد هدیه ساخته شد: <code>${code}</code>`,
        `پلن ${PLANS[plan].title} — ${faNum(days)} روز — ${faNum(uses)} بار استفاده`,
        '', 'لینک مستقیم (با یک کلیک فعال می‌شود):',
        `https://t.me/${this.env.BOT_USERNAME}?start=gift_${code}`,
      ].join('\n'));
    }
    if (name === 'gifts') {
      const rows = this.q('SELECT * FROM gift_codes ORDER BY created_at DESC LIMIT 30');
      return this.send(chat, rows.length
        ? '🎁 <b>کدهای هدیه</b>\n\n' + rows.map((g) => `<code>${g.code}</code> — ${PLANS[g.plan].title}، ${g.days} روز — ${g.used}/${g.max_uses}`).join('\n')
        : 'هنوز کدی نساخته‌اید. <code>/gift</code>');
    }
    if (name === 'delgift') {
      this.sql.exec('DELETE FROM gift_codes WHERE code=?', arg.toUpperCase());
      return this.send(chat, 'کد حذف شد.');
    }
    if (name === 'payments') {
      const rows = this.q(`SELECT p.*, u.first_name FROM payments p JOIN users u ON u.id=p.user_id ORDER BY p.created_at DESC LIMIT 20`);
      return this.send(chat, rows.length
        ? '🧾 <b>آخرین پرداخت‌ها</b>\n\n' + rows.map((p) => `#${p.id} ${({ pending: '⏳', approved: '✅', rejected: '❌' })[p.status]} ${esc(p.first_name)} — ${PLANS[p.plan].title} — ${faNum(p.amount)} — ${fmtDate(p.created_at)}`).join('\n')
        : 'هنوز پرداختی ثبت نشده.');
    }
    return this.send(chat, [
      '🛠 <b>دستورهای مدیر</b>',
      '/admin — آمار', '/users — فهرست کاربران', '/user شناسه — مدیریت یک کاربر',
      '/gift — ساخت کد هدیه', '/gifts — فهرست کدها', '/delgift کد — حذف کد', '/payments — پرداخت‌ها',
    ].join('\n'));
  }

  adminStats() {
    const users = this.one('SELECT COUNT(*) AS c FROM users').c;
    const paid = this.one(`SELECT COUNT(*) AS c FROM users WHERE plan!='free' AND expires_at > ?`, Date.now()).c;
    const files = this.one(`SELECT COUNT(*) AS c FROM files WHERE status='ready'`).c;
    const pending = this.one(`SELECT COUNT(*) AS c FROM payments WHERE status='pending'`).c;
    const since = Date.now() - 30 * DAY;
    const income = this.one(`SELECT COALESCE(SUM(amount),0) AS s FROM payments WHERE status='approved' AND decided_at > ?`, since).s;
    const used = this.totalUsed();
    return [
      '📊 <b>آمار</b>',
      `👥 کاربران: ${faNum(users)} (پولی فعال: ${faNum(paid)})`,
      `📂 فایل‌ها: ${faNum(files)}`,
      `💾 فضای کل: ${bar(used / TOTAL_CAP * 100)} ${fmtSize(used)} از ${fmtSize(TOTAL_CAP)}`,
      `💰 درآمد ۳۰ روز اخیر: ${faNum(income)} تومان`,
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
    const files = this.one(`SELECT COUNT(*) AS c FROM files WHERE owner=? AND status='ready'`, uid).c;
    const tv = this.one('SELECT name FROM devices WHERE user_id=?', uid);
    const paid = this.one(`SELECT COALESCE(SUM(amount),0) AS s FROM payments WHERE user_id=? AND status='approved'`, uid).s;
    const text = [
      `👤 <b>${esc(u.first_name)}</b>${u.username ? ` @${esc(u.username)}` : ''} — <code>${u.id}</code>`,
      `پلن: ${lim.title}${u.expires_at && u.plan !== 'free' ? ` تا ${fmtDate(u.expires_at, false)}` : ''}${u.banned ? ' — ⛔️ مسدود' : ''}`,
      `فضا: ${fmtSize(this.userUsed(uid))} از ${fmtSize(lim.quota)} — ${faNum(files)} فایل`,
      `دانلود این ماه: ${fmtSize(u.bw_month === monthKey() ? u.bw_used : 0)}`,
      `تلویزیون: ${tv ? esc(tv.name) : '—'}`,
      `مجموع پرداخت: ${faNum(paid)} تومان`,
      `عضویت: ${fmtDate(u.created_at, false)} — آخرین فعالیت: ${fmtDate(u.last_seen || u.created_at)}`,
    ].join('\n');
    const kb = [
      [{ text: '➕ تمدید ۳۰ روز', callback_data: `u:${uid}:ext` }],
      [{ text: '۵۰۰ مگ', callback_data: `u:${uid}:p500` }, { text: '۲ گیگ', callback_data: `u:${uid}:p2g` }, { text: '۵ گیگ', callback_data: `u:${uid}:p5g` }, { text: 'رایگان', callback_data: `u:${uid}:free` }],
      [u.banned ? { text: '✅ رفع مسدودی', callback_data: `u:${uid}:unban` } : { text: '⛔️ مسدود کردن', callback_data: `u:${uid}:ban` }],
    ];
    return { text, kb };
  }

  // ================================================================ background work
  async ensureAlarm() {
    if (!(await this.ctx.storage.getAlarm())) await this.ctx.storage.setAlarm(Date.now() + 60_000);
  }

  async alarm() {
    try {
      if (Date.now() >= Number(this.meta('next_maint') || 0)) {
        this.meta('next_maint', Date.now() + MAINT_EVERY);
        await this.maintenance();
      }
    } catch (e) {
      console.log('maintenance failed', e.stack || e);
    }
    await this.processQueue();
    const queued = this.one(`SELECT 1 AS x FROM files WHERE status='queued' LIMIT 1`);
    await this.ctx.storage.setAlarm(Date.now() + (queued ? 50 : 10 * 60_000));
  }

  async processQueue() {
    for (const s of this.q(`SELECT id FROM files WHERE status='uploading'`)) {
      this.sql.exec('DELETE FROM chunks WHERE file_id=?', s.id);
      this.sql.exec(`UPDATE files SET status='queued' WHERE id=?`, s.id);
    }
    const f = this.one(`SELECT * FROM files WHERE status='queued' ORDER BY created_at LIMIT 1`);
    if (!f) return;
    this.sql.exec(`UPDATE files SET status='uploading' WHERE id=?`, f.id);
    try {
      const r = await this.tgDownload(f.tg_file_id);
      const size = await this.writeStream(f.id, r.body, 0);
      await this.storeThumb(f);
      this.sql.exec(`UPDATE files SET status='ready', size=? WHERE id=?`, size, f.id);
      await this.announceReady(f.id);
    } catch (e) {
      console.log('upload failed', f.id, e.stack || e);
      this.sql.exec('DELETE FROM chunks WHERE file_id=?', f.id);
      this.sql.exec(`UPDATE files SET status='failed', error=? WHERE id=?`, String(e.message || e), f.id);
      await this.edit(f.chat_id, f.msg_id, `❌ آپلود <b>${esc(f.name)}</b> ناموفق بود:\n<code>${esc(e.message || e)}</code>`,
        [[{ text: '🔁 دوباره', callback_data: `r:${f.id}` }, { text: '❌ لغو', callback_data: `c:${f.id}` }]]);
    }
  }

  // Expiry reminders, downgrades after expiry, and cleanup after the 24h grace period.
  async maintenance() {
    const now = Date.now();
    this.sql.exec('DELETE FROM seen WHERE at < ?', now - 3 * DAY);
    this.sql.exec('DELETE FROM pairs WHERE created_at < ?', now - PAIR_TTL);

    for (const u of this.q(`SELECT * FROM users WHERE plan!='free' AND reminded=0 AND expires_at BETWEEN ? AND ?`, now, now + REMIND_BEFORE)) {
      this.sql.exec('UPDATE users SET reminded=1 WHERE id=?', u.id);
      await this.send(u.id, `⏰ اشتراک <b>${PLANS[u.plan].title}</b> شما ${fmtDate(u.expires_at)} تمام می‌شود.\nبرای اینکه فایل‌هایتان پاک نشوند، اشتراک را تمدید کنید.`,
        [[{ text: `🔄 تمدید ${PLANS[u.plan].title}`, callback_data: `B:${u.plan}` }]]);
    }

    for (const u of this.q(`SELECT * FROM users WHERE plan!='free' AND expires_at < ?`, now)) {
      const old = PLANS[u.plan].title;
      const over = this.userUsed(u.id) > PLANS.free.quota;
      this.sql.exec(`UPDATE users SET plan='free', expires_at=NULL, reminded=0, grace_until=? WHERE id=?`, over ? now + GRACE_MS : null, u.id);
      await this.send(u.id, over
        ? `⚠️ اشتراک <b>${old}</b> شما تمام شد و حساب به پلن رایگان (${fmtSize(PLANS.free.quota)}) برگشت.\nفایل‌های بیشتر از این مقدار <b>۲۴ ساعت دیگر</b> (از قدیمی‌ترین) پاک می‌شوند، مگر اینکه اشتراک را تمدید کنید.`
        : `ℹ️ اشتراک <b>${old}</b> شما تمام شد و حساب به پلن رایگان برگشت.`,
        [[{ text: `🔄 تمدید ${old}`, callback_data: `B:${u.plan}` }], [{ text: '📦 پلن‌ها', callback_data: 'b' }]]);
    }

    for (const u of this.q(`SELECT * FROM users WHERE grace_until IS NOT NULL AND grace_until < ?`, now)) {
      const quota = this.limits(u).quota;
      let used = this.userUsed(u.id);
      const removed = [];
      for (const f of this.q(`SELECT id,name,size FROM files WHERE owner=? AND status IN ${ACTIVE} ORDER BY created_at ASC`, u.id)) {
        if (used <= quota) break;
        this.deleteFile(f.id);
        used -= f.size;
        removed.push(f.name);
      }
      this.sql.exec('UPDATE users SET grace_until=NULL WHERE id=?', u.id);
      if (removed.length) {
        await this.send(u.id, `🗑 به دلیل پایان اشتراک، ${faNum(removed.length)} فایل قدیمی پاک شد:\n${removed.slice(0, 15).map((n) => '• ' + esc(short(n, 40))).join('\n')}`,
          [[{ text: '📦 خرید اشتراک', callback_data: 'b' }]]);
      }
    }

    const used = this.totalUsed();
    if (used > TOTAL_CAP * 0.9 && this.meta('cap_warned') !== monthKey()) {
      this.meta('cap_warned', monthKey());
      await this.notifyAdmin(`⚠️ فضای کل سرور ${Math.round(used / TOTAL_CAP * 100)}% پر است (${fmtSize(used)} از ${fmtSize(TOTAL_CAP)}).`);
    }
  }

  async storeThumb(f) {
    if (!f.thumb_file_id) return;
    try {
      const r = await this.tgDownload(f.thumb_file_id);
      const buf = new Uint8Array(await r.arrayBuffer());
      if (buf.length < 1_000_000) this.sql.exec('UPDATE files SET thumb=? WHERE id=?', buf, f.id);
    } catch (e) {
      console.log('thumb failed', f.id, e.message);
    }
  }

  async announceReady(id) {
    const f = this.one('SELECT * FROM files WHERE id=?', id);
    const link = this.link(f);
    await this.edit(f.chat_id, f.msg_id,
      `✅ <b>${esc(f.name)}</b> (${fmtSize(f.size)})\n\n<code>${esc(link)}</code>\n\n${this.usageLine(f.owner)}`,
      [[{ text: '🔗 باز کردن لینک', url: link }], [{ text: '🗑 پاک کردن', callback_data: `d:${f.id}:0` }]]);
  }

  // ================================================================ serving
  async serve(req, id, url) {
    const f = this.one('SELECT id,name,mime,size,status,owner FROM files WHERE id=?', id);
    if (!f || f.status !== 'ready') return new Response('File not found', { status: 404 });
    const size = f.size;
    let start = 0, end = size - 1, status = 200;
    const range = req.headers.get('range');
    if (range && size > 0) {
      const m = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
      if (m && (m[1] !== '' || m[2] !== '')) {
        if (m[1] === '') start = Math.max(0, size - Number(m[2]));
        else { start = Number(m[1]); if (m[2] !== '') end = Math.min(Number(m[2]), size - 1); }
        if (start > end || start >= size) return new Response(null, { status: 416, headers: { 'content-range': `bytes */${size}` } });
        status = 206;
      }
    }
    const len = size === 0 ? 0 : end - start + 1;

    // monthly download cap of the file's owner
    if (req.method === 'GET' && len > 0) {
      const owner = this.user(f.owner);
      if (owner && !this.isAdmin(owner.id)) {
        const lim = this.limits(owner);
        const mk = monthKey();
        const usedBw = owner.bw_month === mk ? owner.bw_used : 0;
        if (usedBw >= lim.bw) {
          if (!owner.bw_warned) {
            this.sql.exec('UPDATE users SET bw_warned=1 WHERE id=?', owner.id);
            await this.send(owner.id, `📶 سقف دانلود ماهانه پلن شما (${fmtSize(lim.bw)}) پر شد و لینک‌هایتان تا اول ماه بعد یا تا ارتقای اشتراک کار نمی‌کنند.`,
              [[{ text: '📦 ارتقای اشتراک', callback_data: 'b' }]]);
          }
          return new Response('سقف دانلود ماهانه صاحب این فایل پر شده است.\nMonthly download limit reached.', {
            status: 429, headers: { 'content-type': 'text/plain; charset=utf-8' },
          });
        }
        this.sql.exec(`UPDATE users SET bw_used=?, bw_month=?, bw_warned=CASE WHEN bw_month=? THEN bw_warned ELSE 0 END WHERE id=?`,
          usedBw + len, mk, mk, owner.id);
      }
    }

    const ascii = f.name.replace(/[^\x20-\x7e]/g, '_').replace(/"/g, '');
    const disp = url.searchParams.has('dl') ? 'attachment' : 'inline';
    const headers = {
      'content-type': f.mime || guessMime(f.name),
      'content-length': String(len),
      'accept-ranges': 'bytes',
      'content-disposition': `${disp}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(f.name)}`,
      'cache-control': 'private, max-age=86400',
      etag: `"${f.id}"`,
    };
    if (status === 206) headers['content-range'] = `bytes ${start}-${end}/${size}`;
    if (req.method === 'HEAD' || len === 0) return new Response(null, { status, headers });

    const { readable, writable } = new FixedLengthStream(len);
    const sql = this.sql;
    (async () => {
      const w = writable.getWriter();
      try {
        for (let i = Math.floor(start / CHUNK); i <= Math.floor(end / CHUNK); i++) {
          const row = sql.exec('SELECT data FROM chunks WHERE file_id=? AND idx=?', id, i).toArray()[0];
          if (!row) throw new Error(`missing chunk ${i}`);
          const d = new Uint8Array(row.data);
          const base = i * CHUNK;
          await w.write(d.subarray(Math.max(0, start - base), Math.min(d.length, end - base + 1)));
        }
        await w.close();
      } catch (e) {
        console.log('serve aborted', id, e.message);
        w.abort(e).catch(() => {});
      }
    })();
    return new Response(readable, { status, headers });
  }

  serveThumb(id) {
    const f = this.one('SELECT thumb FROM files WHERE id=? AND status=?', id, 'ready');
    if (!f?.thumb) return new Response('No thumbnail', { status: 404 });
    return new Response(f.thumb, { headers: { 'content-type': 'image/jpeg', 'cache-control': 'private, max-age=604800' } });
  }

  // ================================================================ TV API
  authApi(req, url) {
    const h = req.headers.get('authorization') || '';
    const token = h.startsWith('Bearer ') ? h.slice(7) : url.searchParams.get('key') || '';
    if (!token) return null;
    if (this.env.API_KEY && timingSafeEqual(token, this.env.API_KEY)) return Number(this.env.OWNER_ID);
    const d = this.one('SELECT * FROM devices WHERE token=?', token);
    if (!d) return null;
    if (!d.last_seen || Date.now() - d.last_seen > 5 * 60_000) this.sql.exec('UPDATE devices SET last_seen=? WHERE token=?', Date.now(), token);
    return d.user_id;
  }

  api(req, url, p) {
    const uid = this.authApi(req, url);
    if (!uid) return Response.json({ error: 'unauthorized' }, { status: 401 });
    if (this.isAdmin(uid) && !this.user(uid)) this.touchUser({ id: uid, first_name: 'Admin' });
    const user = this.user(uid);
    if (!user || (user.banned && !this.isAdmin(uid))) return Response.json({ error: 'unauthorized' }, { status: 401 });
    let m;
    if (p === '/api/files') return this.apiFiles(url, user);
    if ((m = /^\/api\/files\/([A-Za-z0-9]{16})$/.exec(p)) && req.method === 'DELETE') {
      if (this.canTouch(uid, m[1])) this.deleteFile(m[1]);
      return Response.json({ ok: true });
    }
    if (p === '/api/admin/users' && this.isAdmin(uid)) {
      return Response.json(this.q('SELECT * FROM users ORDER BY created_at').map((u) => ({
        ...u, used: this.userUsed(u.id), tv: this.one('SELECT name FROM devices WHERE user_id=?', u.id)?.name || null,
      })));
    }
    if ((m = /^\/api\/admin\/users\/(\d+)$/.exec(p)) && req.method === 'DELETE' && this.isAdmin(uid) && !this.isAdmin(m[1])) {
      const target = Number(m[1]);
      for (const f of this.q('SELECT id FROM files WHERE owner=?', target)) this.deleteFile(f.id);
      for (const t of ['devices', 'payments']) this.sql.exec(`DELETE FROM ${t} WHERE user_id=?`, target);
      this.sql.exec('DELETE FROM gift_uses WHERE user_id=?', target);
      this.sql.exec('DELETE FROM users WHERE id=?', target);
      return Response.json({ ok: true });
    }
    if ((m = /^\/api\/admin\/users\/(\d+)$/.exec(p)) && req.method === 'PATCH' && this.isAdmin(uid)) {
      return req.json().then((b) => {
        for (const k of ['plan', 'expires_at', 'grace_until', 'reminded', 'bw_used', 'bw_month']) {
          if (k in b) this.sql.exec(`UPDATE users SET ${k}=? WHERE id=?`, b[k], Number(m[1]));
        }
        return Response.json(this.user(Number(m[1])));
      });
    }
    if (p === '/api/admin/maintenance' && req.method === 'POST' && this.isAdmin(uid)) {
      return this.maintenance().then(() => Response.json({ ok: true }));
    }
    if (p === '/api/admin/payments' && this.isAdmin(uid)) return Response.json(this.q('SELECT * FROM payments ORDER BY id'));
    if (p === '/api/admin/gifts' && this.isAdmin(uid)) return Response.json(this.q('SELECT * FROM gift_codes ORDER BY created_at'));
    if (p === '/api/tv/device' && req.method === 'DELETE') {
      this.sql.exec('DELETE FROM devices WHERE user_id=?', uid);
      return Response.json({ ok: true });
    }
    return Response.json({ error: 'not found' }, { status: 404 });
  }

  apiFiles(url, user) {
    const limit = Math.min(Number(url.searchParams.get('limit')) || 100, 500);
    const offset = Number(url.searchParams.get('offset')) || 0;
    const rows = this.q(`SELECT id,name,mime,size,kind,width,height,duration,created_at,(thumb IS NOT NULL) AS has_thumb
      FROM files WHERE status='ready' AND owner=? ORDER BY created_at DESC LIMIT ? OFFSET ?`, user.id, limit, offset);
    const lim = this.limits(user);
    return Response.json({
      user: { name: user.first_name, plan: lim.title, expires_at: user.plan !== 'free' ? user.expires_at : null },
      used: this.userUsed(user.id), quota: lim.quota,
      files: rows.map((f) => ({
        ...f, has_thumb: !!f.has_thumb, url: this.link(f),
        thumb: f.has_thumb ? `${this.env.PUBLIC_URL}/t/${f.id}` : null,
      })),
    });
  }

  // ================================================================ large-file helper
  helperJobs() {
    const jobs = this.q(`SELECT id,name,size,tg_file_id FROM files WHERE status IN ('waiting_helper','helper_uploading') ORDER BY created_at`);
    return Response.json({ chunk: CHUNK, jobs });
  }

  async helperUpload(req, id, url) {
    const f = this.one(`SELECT * FROM files WHERE id=? AND status IN ('waiting_helper','helper_uploading')`, id);
    if (!f) return new Response('no such job', { status: 404 });
    const offset = Number(url.searchParams.get('offset') || 0);
    if (offset % CHUNK) return new Response('offset must be a multiple of chunk size', { status: 400 });
    if (offset === 0) this.sql.exec('DELETE FROM chunks WHERE file_id=?', id);
    this.sql.exec(`UPDATE files SET status='helper_uploading' WHERE id=?`, id);
    const n = await this.writeStream(id, req.body, offset / CHUNK);
    return Response.json({ ok: true, written: n });
  }

  async helperProgress(req, id) {
    const f = this.one(`SELECT * FROM files WHERE id=? AND status IN ('waiting_helper','helper_uploading')`, id);
    if (!f) return new Response('no such job', { status: 404 });
    const { done = 0, total = f.size, speed = 0 } = await req.json().catch(() => ({}));
    const pct = total ? Math.min(100, Math.floor((done / total) * 100)) : 0;
    await this.edit(f.chat_id, f.msg_id,
      `⏳ <b>${esc(f.name)}</b> (${fmtSize(f.size)})\nدر حال انتقال فایل بزرگ…\n${bar(pct)} ${pct}%\n${fmtSize(done)} از ${fmtSize(total)}${speed ? ` · ${fmtSize(speed)}/s` : ''}`,
      [[{ text: '❌ لغو', callback_data: `c:${id}` }]]);
    return Response.json({ ok: true });
  }

  async helperDone(req, kind, id) {
    const f = this.one(`SELECT * FROM files WHERE id=? AND status IN ('waiting_helper','helper_uploading')`, id);
    if (!f) return new Response('no such job', { status: 404 });
    if (kind === 'fail') {
      const why = (await req.text()).slice(0, 500) || 'helper error';
      this.sql.exec('DELETE FROM chunks WHERE file_id=?', id);
      this.sql.exec(`UPDATE files SET status='failed', error=? WHERE id=?`, why, id);
      await this.edit(f.chat_id, f.msg_id, `❌ آپلود <b>${esc(f.name)}</b> ناموفق بود:\n<code>${esc(why)}</code>`,
        [[{ text: '🔁 دوباره', callback_data: `r:${id}` }, { text: '❌ لغو', callback_data: `c:${id}` }]]);
      return Response.json({ ok: true });
    }
    const got = this.one(`SELECT COALESCE(SUM(length(data)),0) AS s FROM chunks WHERE file_id=?`, id).s;
    await this.storeThumb(f);
    this.sql.exec(`UPDATE files SET status='ready', size=? WHERE id=?`, got, id);
    await this.announceReady(id);
    return Response.json({ ok: true, size: got });
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

function bearer(req, url) {
  const h = req.headers.get('authorization') || '';
  return h.startsWith('Bearer ') ? h.slice(7) : url.searchParams.get('key') || '';
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const p = url.pathname;
    const store = env.STORE.get(env.STORE.idFromName('main'));
    const fwd = (path) => store.fetch(new Request(new URL(path + url.search, 'https://store'), req));

    if (p === '/') return new Response('ok');
    if (p === `/tg/${env.WEBHOOK_SECRET}` && req.method === 'POST') {
      if (req.headers.get('x-telegram-bot-api-secret-token') !== env.WEBHOOK_SECRET) return new Response('forbidden', { status: 403 });
      return fwd('/tg');
    }
    if (/^\/[ft]\//.test(p) && (req.method === 'GET' || req.method === 'HEAD')) return fwd(p);
    if (p.startsWith('/api/')) return fwd(p); // the Durable Object checks device tokens
    if (p.startsWith('/helper/')) {
      if (!env.HELPER_SECRET || !timingSafeEqual(bearer(req, url), env.HELPER_SECRET)) return new Response('unauthorized', { status: 401 });
      return fwd(p);
    }
    return new Response('Not found', { status: 404 });
  },
};
