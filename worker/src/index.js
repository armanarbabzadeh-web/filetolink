// File-to-link: private Telegram bot + file store on Cloudflare (free plan).
// Storage: one SQLite-backed Durable Object ("Store"). Files are split into chunks
// of CHUNK bytes and kept in the `chunks` table. Total data is capped at QUOTA.
import { DurableObject } from 'cloudflare:workers';

const CHUNK = 1_900_000;            // < 2 MB SQLite row limit
const QUOTA = 4_900_000_000;        // ~4.9 GB of file data (free DO storage is 5 GB)
const TG_BOT_MAX = 20 * 1024 * 1024; // Bot API getFile download limit
const PAGE = 8;

// ---------------------------------------------------------------- helpers
const enc = new TextEncoder();

function randomId(len = 16) {
  const abc = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  const bytes = crypto.getRandomValues(new Uint8Array(len * 2));
  let s = '';
  for (const b of bytes) {
    if (b < 248) s += abc[b % 62];
    if (s.length === len) break;
  }
  return s.length === len ? s : randomId(len);
}

function fmtSize(n) {
  if (n == null) return '?';
  if (n < 1000) return `${n} B`;
  if (n < 1e6) return `${(n / 1e3).toFixed(1)} KB`;
  if (n < 1e9) return `${(n / 1e6).toFixed(1)} MB`;
  return `${(n / 1e9).toFixed(2)} GB`;
}

function fmtDate(ms) {
  try {
    return new Intl.DateTimeFormat('fa-IR', {
      timeZone: 'Asia/Tehran', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit',
    }).format(new Date(ms));
  } catch {
    return new Date(ms).toISOString().slice(0, 16).replace('T', ' ');
  }
}

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function short(s, n = 28) {
  s = String(s);
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

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
    `);
  }

  // ---- storage primitives
  q(query, ...args) { return this.sql.exec(query, ...args).toArray(); }
  one(query, ...args) { return this.q(query, ...args)[0] || null; }

  used() {
    return this.one(`SELECT COALESCE(SUM(size),0) AS s FROM files
      WHERE status IN ('ready','uploading','queued','waiting_helper','helper_uploading')`).s;
  }

  link(f) { return `${this.env.PUBLIC_URL}/f/${f.id}/${encodeURIComponent(f.name)}`; }

  deleteFile(id) {
    this.sql.exec('DELETE FROM chunks WHERE file_id=?', id);
    this.sql.exec('DELETE FROM files WHERE id=?', id);
  }

  // Write a byte stream as chunks starting at chunk index `startIdx`. Returns bytes written.
  async writeStream(id, body, startIdx = 0) {
    const reader = body.getReader();
    let buf = new Uint8Array(CHUNK), fill = 0, idx = startIdx, total = 0;
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

  async tgDownload(fileId) {
    const gf = await this.tg('getFile', { file_id: fileId });
    if (!gf.ok) throw new Error(gf.description || 'getFile failed');
    const r = await fetch(`https://api.telegram.org/file/bot${this.env.BOT_TOKEN}/${gf.result.file_path}`);
    if (!r.ok || !r.body) throw new Error(`download failed: HTTP ${r.status}`);
    return r;
  }

  // ---- HTTP entry (called by the Worker after auth)
  async fetch(req) {
    const url = new URL(req.url);
    const p = url.pathname;
    try {
      if (p === '/tg') {
        await this.onUpdate(await req.json());
        return new Response('ok');
      }
      let m;
      if ((m = /^\/f\/([A-Za-z0-9]{16})(?:\/.*)?$/.exec(p))) return this.serve(req, m[1], url);
      if ((m = /^\/t\/([A-Za-z0-9]{16})$/.exec(p))) return this.serveThumb(m[1]);
      if (p === '/api/files') return this.apiFiles(url);
      if ((m = /^\/api\/files\/([A-Za-z0-9]{16})$/.exec(p)) && req.method === 'DELETE') {
        this.deleteFile(m[1]);
        return Response.json({ ok: true });
      }
      if (p === '/helper/jobs') return this.helperJobs();
      if ((m = /^\/helper\/upload\/([A-Za-z0-9]{16})$/.exec(p))) return this.helperUpload(req, m[1], url);
      if ((m = /^\/helper\/(finish|fail)\/([A-Za-z0-9]{16})$/.exec(p))) return this.helperDone(req, m[1], m[2]);
      if ((m = /^\/helper\/progress\/([A-Za-z0-9]{16})$/.exec(p))) return this.helperProgress(req, m[1]);
      return new Response('Not found', { status: 404 });
    } catch (e) {
      console.log('error', p, e.stack || e);
      return new Response('Internal error', { status: 500 });
    }
  }

  // ---- Telegram updates
  async onUpdate(u) {
    if (u.update_id != null) {
      if (this.one('SELECT 1 AS x FROM seen WHERE update_id=?', u.update_id)) return;
      this.sql.exec('INSERT INTO seen(update_id, at) VALUES (?,?)', u.update_id, Date.now());
      this.sql.exec('DELETE FROM seen WHERE at < ?', Date.now() - 3 * 864e5);
    }
    if (u.callback_query) return this.onCallback(u.callback_query);
    const m = u.message;
    if (!m) return;
    if (String(m.from?.id) !== String(this.env.OWNER_ID)) {
      await this.send(m.chat.id, '⛔️ این بات خصوصی است.');
      return;
    }
    const text = (m.text || '').trim();
    if (/^\/(start|help)\b/.test(text)) return this.send(m.chat.id, this.helpText());
    if (/^\/list\b/.test(text)) return this.sendList(m.chat.id, 0);
    if (/^\/usage\b/.test(text)) return this.send(m.chat.id, this.usageText());
    const media = extractMedia(m);
    if (!media) return this.send(m.chat.id, this.helpText());
    return this.addFile(m, media);
  }

  helpText() {
    return [
      '👋 <b>سلام!</b>',
      'هر فایلی (عکس، ویدیو، سند، صوت) بفرستی، لینک مستقیمش را می‌دهم.',
      '',
      '/list — فهرست فایل‌ها و پاک کردن',
      '/usage — فضای مصرف‌شده',
      '',
      this.usageText(),
    ].join('\n');
  }

  usageText() {
    const used = this.used();
    const count = this.one(`SELECT COUNT(*) AS c FROM files WHERE status='ready'`).c;
    const pct = Math.round((used / QUOTA) * 100);
    const bar = '█'.repeat(Math.round(pct / 10)) + '░'.repeat(10 - Math.round(pct / 10));
    return `💾 ${bar} ${pct}%\n${fmtSize(used)} از ${fmtSize(QUOTA)} — ${count} فایل`;
  }

  async addFile(m, media) {
    if (media.size > QUOTA) {
      return this.send(m.chat.id, `❌ این فایل (${fmtSize(media.size)}) از کل فضا بزرگ‌تر است.`, null, m.message_id);
    }
    const id = randomId();
    const free = QUOTA - this.used();
    const status = media.size > free ? 'waiting_space' : media.size > TG_BOT_MAX ? 'waiting_helper' : 'queued';
    this.sql.exec(`INSERT INTO files(id,name,mime,size,kind,status,tg_file_id,thumb_file_id,width,height,duration,chat_id,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      id, media.name, media.mime, media.size, media.kind, status, media.fileId, media.thumbId,
      media.width, media.height, media.duration, m.chat.id, Date.now());
    const sent = await this.send(m.chat.id, `⏳ <b>${esc(media.name)}</b> (${fmtSize(media.size)})`, null, m.message_id);
    if (sent.ok) this.sql.exec('UPDATE files SET msg_id=? WHERE id=?', sent.result.message_id, id);
    await this.afterStatus(id);
  }

  // Act on a file's current status: queue it, wake the helper, or ask for space.
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
        ? `⏳ ${title}\nفایل بزرگ‌تر از ۲۰ مگ است؛ برنامه کمکی دارد آن را منتقل می‌کند. ممکن است یکی دو دقیقه طول بکشد.`
        : `🕓 ${title}\nفایل‌های بالای ۲۰ مگ به برنامه کمکی نیاز دارند که هنوز راه‌اندازی نشده. فایل در صف ماند و بعد از راه‌اندازی خودکار آپلود می‌شود.`);
    } else if (f.status === 'waiting_space') {
      await this.showSpacePicker(f, 0);
    }
  }

  async wakeHelper() {
    if (!this.env.HELPER_URL) return false;
    try {
      const r = await fetch(`${this.env.HELPER_URL.replace(/\/$/, '')}/wake`, {
        method: 'POST', headers: { authorization: `Bearer ${this.env.HELPER_SECRET}` },
        signal: AbortSignal.timeout(5000),
      });
      return r.ok || r.status >= 500; // a sleeping Render instance may time out while booting
    } catch {
      return true; // timeout usually means it is booting
    }
  }

  // ---- "not enough space" flow
  async showSpacePicker(pending, page) {
    const free = QUOTA - this.used();
    const rows = this.q(`SELECT id,name,size,created_at FROM files WHERE status='ready'
      ORDER BY created_at ASC LIMIT ? OFFSET ?`, PAGE + 1, page * PAGE);
    const more = rows.length > PAGE;
    const kb = rows.slice(0, PAGE).map((f) => [{
      text: `🗑 ${short(f.name, 22)} · ${fmtSize(f.size)} · ${fmtDate(f.created_at).split('،')[0]}`,
      callback_data: `x:${f.id}:${pending.id}`,
    }]);
    const nav = [];
    if (page > 0) nav.push({ text: '« قدیمی‌تر', callback_data: `q:${pending.id}:${page - 1}` });
    if (more) nav.push({ text: 'جدیدتر »', callback_data: `q:${pending.id}:${page + 1}` });
    if (nav.length) kb.push(nav);
    kb.push([{ text: '❌ لغو آپلود این فایل', callback_data: `c:${pending.id}` }]);
    const text = [
      `⚠️ <b>فضا کافی نیست</b>`,
      `فایل: <b>${esc(pending.name)}</b> (${fmtSize(pending.size)})`,
      `فضای آزاد: ${fmtSize(Math.max(0, free))} — باید ${fmtSize(pending.size - free)} دیگر آزاد شود.`,
      '',
      'فایل‌های قدیمی (قدیمی‌ترین اول). روی هر کدام بزن تا پاک شود:',
    ].join('\n');
    await this.edit(pending.chat_id, pending.msg_id, text, kb);
  }

  // ---- /list
  listView(page) {
    const total = this.one(`SELECT COUNT(*) AS c FROM files WHERE status='ready'`).c;
    const rows = this.q(`SELECT id,name,size,created_at FROM files WHERE status='ready'
      ORDER BY created_at DESC LIMIT ? OFFSET ?`, PAGE, page * PAGE);
    if (!total) return { text: '📭 هنوز فایلی نداری.\n\n' + this.usageText(), kb: null };
    const lines = rows.map((f, i) =>
      `${page * PAGE + i + 1}. <a href="${esc(this.link(f))}">${esc(short(f.name, 40))}</a>\n     ${fmtSize(f.size)} · ${fmtDate(f.created_at)}`);
    const kb = [];
    for (let i = 0; i < rows.length; i += 4) {
      kb.push(rows.slice(i, i + 4).map((f, j) => ({ text: `🗑 ${page * PAGE + i + j + 1}`, callback_data: `d:${f.id}:${page}` })));
    }
    const pages = Math.ceil(total / PAGE);
    const nav = [];
    if (page > 0) nav.push({ text: '« جدیدتر', callback_data: `l:${page - 1}` });
    if (page < pages - 1) nav.push({ text: 'قدیمی‌تر »', callback_data: `l:${page + 1}` });
    if (nav.length) kb.push(nav);
    return { text: `📂 <b>فایل‌ها</b> (صفحه ${page + 1} از ${pages})\n\n${lines.join('\n')}\n\n${this.usageText()}`, kb };
  }

  async sendList(chatId, page) {
    const v = this.listView(page);
    return this.send(chatId, v.text, v.kb);
  }

  // ---- buttons
  async onCallback(cb) {
    const chatId = cb.message?.chat?.id, msgId = cb.message?.message_id;
    const answer = (text) => this.tg('answerCallbackQuery', { callback_query_id: cb.id, text });
    if (String(cb.from?.id) !== String(this.env.OWNER_ID)) return answer('⛔️');
    const [op, a, b] = String(cb.data || '').split(':');

    if (op === 'l') { // list page
      const v = this.listView(Number(a) || 0);
      await this.edit(chatId, msgId, v.text, v.kb);
      return answer();
    }
    if (op === 'd') { // confirm delete from list
      const f = this.one('SELECT id,name,size FROM files WHERE id=?', a);
      if (!f) { await answer('این فایل دیگر وجود ندارد'); const v = this.listView(Number(b) || 0); return this.edit(chatId, msgId, v.text, v.kb); }
      await this.edit(chatId, msgId, `🗑 این فایل پاک شود؟\n<b>${esc(f.name)}</b> (${fmtSize(f.size)})\n\nلینکش دیگر کار نمی‌کند.`, [[
        { text: '✅ بله، پاک کن', callback_data: `D:${a}:${b}` },
        { text: '↩️ برگشت', callback_data: `l:${b}` },
      ]]);
      return answer();
    }
    if (op === 'D') { // delete from list
      this.deleteFile(a);
      const v = this.listView(Number(b) || 0);
      await this.edit(chatId, msgId, v.text, v.kb);
      return answer('پاک شد');
    }
    if (op === 'q') { // space picker page
      const p = this.one(`SELECT * FROM files WHERE id=? AND status='waiting_space'`, a);
      if (p) await this.showSpacePicker(p, Number(b) || 0);
      return answer();
    }
    if (op === 'x') { // confirm delete from space picker
      const f = this.one('SELECT id,name,size,created_at FROM files WHERE id=?', a);
      if (!f) return answer('این فایل دیگر وجود ندارد');
      await this.edit(chatId, msgId, `🗑 این فایل پاک شود؟\n<b>${esc(f.name)}</b> (${fmtSize(f.size)})\nآپلود: ${fmtDate(f.created_at)}\n\nلینکش دیگر کار نمی‌کند.`, [[
        { text: '✅ بله، پاک کن', callback_data: `X:${a}:${b}` },
        { text: '↩️ برگشت', callback_data: `q:${b}:0` },
      ]]);
      return answer();
    }
    if (op === 'X') { // delete from space picker, then retry the pending file
      this.deleteFile(a);
      const p = this.one(`SELECT * FROM files WHERE id=? AND status='waiting_space'`, b);
      if (!p) return answer('پاک شد');
      if (p.size <= QUOTA - this.used()) {
        this.sql.exec('UPDATE files SET status=? WHERE id=?', p.size > TG_BOT_MAX ? 'waiting_helper' : 'queued', p.id);
        await answer('پاک شد — فضا کافی است');
        return this.afterStatus(p.id);
      }
      await this.showSpacePicker(p, 0);
      return answer('پاک شد');
    }
    if (op === 'c') { // cancel pending upload
      const p = this.one('SELECT * FROM files WHERE id=?', a);
      if (p && p.status !== 'ready') {
        this.deleteFile(a);
        await this.edit(chatId, msgId, `❌ آپلود <b>${esc(p.name)}</b> لغو شد.`);
      }
      return answer('لغو شد');
    }
    if (op === 'r') { // retry failed
      const p = this.one(`SELECT * FROM files WHERE id=? AND status='failed'`, a);
      if (p) {
        const st = p.size > QUOTA - this.used() ? 'waiting_space' : p.size > TG_BOT_MAX ? 'waiting_helper' : 'queued';
        this.sql.exec('UPDATE files SET status=?, error=NULL WHERE id=?', st, a);
        await this.afterStatus(a);
      }
      return answer();
    }
    return answer();
  }

  // ---- background upload queue (alarm)
  async alarm() {
    // Anything left "uploading" belongs to a run that died; start it over.
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
    if (this.one(`SELECT 1 AS x FROM files WHERE status='queued' LIMIT 1`)) await this.ctx.storage.setAlarm(Date.now() + 50);
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
      `✅ <b>${esc(f.name)}</b> (${fmtSize(f.size)})\n\n<code>${esc(link)}</code>\n\n${this.usageText()}`,
      [[{ text: '🔗 باز کردن لینک', url: link }], [{ text: '🗑 پاک کردن', callback_data: `d:${f.id}:0` }]]);
  }

  // ---- serving files
  serve(req, id, url) {
    const f = this.one('SELECT id,name,mime,size,status FROM files WHERE id=?', id);
    if (!f || f.status !== 'ready') return new Response('File not found', { status: 404 });
    const size = f.size;
    let start = 0, end = size - 1, status = 200;
    const range = req.headers.get('range');
    if (range && size > 0) {
      const m = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
      if (m && (m[1] !== '' || m[2] !== '')) {
        if (m[1] === '') start = Math.max(0, size - Number(m[2]));
        else { start = Number(m[1]); if (m[2] !== '') end = Math.min(Number(m[2]), size - 1); }
        if (start > end || start >= size) {
          return new Response(null, { status: 416, headers: { 'content-range': `bytes */${size}` } });
        }
        status = 206;
      }
    }
    const len = size === 0 ? 0 : end - start + 1;
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

  // ---- API for the Android TV app
  apiFiles(url) {
    const limit = Math.min(Number(url.searchParams.get('limit')) || 100, 500);
    const offset = Number(url.searchParams.get('offset')) || 0;
    const kind = url.searchParams.get('kind');
    const rows = kind
      ? this.q(`SELECT id,name,mime,size,kind,width,height,duration,created_at,(thumb IS NOT NULL) AS has_thumb
          FROM files WHERE status='ready' AND kind=? ORDER BY created_at DESC LIMIT ? OFFSET ?`, kind, limit, offset)
      : this.q(`SELECT id,name,mime,size,kind,width,height,duration,created_at,(thumb IS NOT NULL) AS has_thumb
          FROM files WHERE status='ready' ORDER BY created_at DESC LIMIT ? OFFSET ?`, limit, offset);
    return Response.json({
      used: this.used(), quota: QUOTA,
      files: rows.map((f) => ({
        ...f, has_thumb: !!f.has_thumb, url: this.link(f),
        thumb: f.has_thumb ? `${this.env.PUBLIC_URL}/t/${f.id}` : null,
      })),
    });
  }

  // ---- API for the large-file helper (Render)
  helperJobs() {
    const jobs = this.q(`SELECT id,name,size,tg_file_id FROM files WHERE status IN ('waiting_helper','helper_uploading') ORDER BY created_at`);
    return Response.json({ chunk: CHUNK, jobs });
  }

  // PUT /helper/upload/<id>?offset=N — body is the next part of the file.
  // Parts must start on a chunk boundary and (except the last) be a multiple of CHUNK.
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
    const bar = '█'.repeat(Math.round(pct / 10)) + '░'.repeat(10 - Math.round(pct / 10));
    await this.edit(f.chat_id, f.msg_id,
      `⏳ <b>${esc(f.name)}</b> (${fmtSize(f.size)})\nدر حال انتقال فایل بزرگ…\n${bar} ${pct}%\n${fmtSize(done)} از ${fmtSize(total)}${speed ? ` · ${fmtSize(speed)}/s` : ''}`,
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

// ---------------------------------------------------------------- Worker (router + auth)
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
    if (p.startsWith('/api/')) {
      if (!env.API_KEY || !timingSafeEqual(bearer(req, url), env.API_KEY)) return new Response('unauthorized', { status: 401 });
      return fwd(p);
    }
    if (p.startsWith('/helper/')) {
      if (!env.HELPER_SECRET || !timingSafeEqual(bearer(req, url), env.HELPER_SECRET)) return new Response('unauthorized', { status: 401 });
      return fwd(p);
    }
    return new Response('Not found', { status: 404 });
  },
};
