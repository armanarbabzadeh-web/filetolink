// Web admin panel (users only), served by the Store Durable Object under /panel.
// Login: username + password (PBKDF2-SHA256), HttpOnly session cookie scoped to /panel.
// Initial / recovery credentials come from the admin bot's /panel command, and must be
// changed on first login. Credentials and sessions live in the DO (meta + panel_sessions).
import PAGE from './panel.html';

const COOKIE = 'tvs_panel';
const SESSION_MS = 4 * 3600_000;
const ITER = 100_000;            // Workers' PBKDF2 maximum
const MAX_FAILS = 5;             // wrong logins allowed per window...
const FAIL_WINDOW = 15 * 60_000; // ...then the login is locked for the same time
const ACTIONS = ['ext', 'p1g', 'p5g', 'p20g', 'p50g', 'free', 'ban', 'unban', 'tvoff'];
const enc = new TextEncoder();

const b64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
function rand(len, abc) {
  const out = [];
  const max = 256 - (256 % abc.length);
  while (out.length < len) {
    for (const b of crypto.getRandomValues(new Uint8Array(len * 2))) {
      if (b < max && out.length < len) out.push(abc[b % abc.length]);
    }
  }
  return out.join('');
}
function same(a, b) {
  const x = enc.encode(String(a)), y = enc.encode(String(b));
  let r = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) r |= (x[i] || 0) ^ (y[i] || 0);
  return r === 0;
}
async function sha256(s) { return b64(await crypto.subtle.digest('SHA-256', enc.encode(s))); }
async function pbkdf2(password, salt, iter = ITER) {
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  return b64(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: iter }, key, 256));
}
async function makeHash(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  return JSON.stringify({ salt: b64(salt), iter: ITER, hash: await pbkdf2(password, salt) });
}
async function checkHash(password, stored) {
  // A dummy hash keeps the timing the same when no credentials exist or the username is wrong.
  let rec;
  try { rec = JSON.parse(stored); } catch { rec = null; }
  const salt = rec ? unb64(rec.salt) : new Uint8Array(16);
  const h = await pbkdf2(password, salt, rec?.iter || ITER);
  return !!rec && same(h, rec.hash);
}

const SEC_HEADERS = {
  'cache-control': 'no-store',
  'x-frame-options': 'DENY',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'x-robots-tag': 'noindex, nofollow',
};
function json(data, status = 200, extra = {}) {
  return new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json; charset=utf-8', ...SEC_HEADERS, ...extra } });
}
const err = (status, error, extra) => json({ error }, status, extra);
function cookie(token, maxAge) {
  return `${COOKIE}=${token}; Path=/panel; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAge}`;
}
function readCookie(req) {
  const m = new RegExp(`(?:^|;\\s*)${COOKIE}=([A-Za-z0-9]+)`).exec(req.headers.get('cookie') || '');
  return m ? m[1] : null;
}

function ensure(store) {
  if (store._panelReady) return;
  store.sql.exec(`CREATE TABLE IF NOT EXISTS panel_sessions(id TEXT PRIMARY KEY, created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL, limited INTEGER NOT NULL DEFAULT 0)`);
  store._panelReady = true;
}

async function session(store, req) {
  const token = readCookie(req);
  if (!token) return null;
  const id = await sha256(token);
  store.sql.exec('DELETE FROM panel_sessions WHERE expires_at < ?', Date.now());
  const s = store.one('SELECT * FROM panel_sessions WHERE id=?', id);
  return s ? { ...s, token } : null;
}
async function newSession(store, limited) {
  const token = rand(43, 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789');
  const now = Date.now();
  store.sql.exec('INSERT INTO panel_sessions(id, created_at, expires_at, limited) VALUES (?,?,?,?)', await sha256(token), now, now + SESSION_MS, limited ? 1 : 0);
  return cookie(token, SESSION_MS / 1000);
}

function fails(store) {
  try { return JSON.parse(store.meta('panel_fail') || 'null') || { n: 0, first: 0, lock: 0 }; } catch { return { n: 0, first: 0, lock: 0 }; }
}

// ---- admin bot: /panel issues fresh temporary credentials (also the recovery path)
export async function panelCredentials(store, chat) {
  ensure(store);
  const username = 'admin-' + rand(5, 'abcdefghijkmnpqrstuvwxyz23456789');
  const password = rand(16, 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789');
  store.meta('panel_user', username);
  store.meta('panel_pw', await makeHash(password));
  store.meta('panel_must', 1);
  store.meta('panel_fail', null);
  store.sql.exec('DELETE FROM panel_sessions');
  const url = `${store.env.PUBLIC_URL || ''}/panel`;
  return store.send(chat, [
    '🔐 <b>ورود به پنل وب</b>',
    `آدرس: ${url}`,
    `نام کاربری: <code>${username}</code>`,
    `رمز موقت: <tg-spoiler><code>${password}</code></tg-spoiler>`,
    '',
    'بعد از اولین ورود باید نام کاربری و رمز را عوض کنید.',
    'رمز قبلی و همه نشست‌های باز باطل شدند. این پیام را بعد از ورود پاک کنید.',
  ].join('\n'), null, null, 'admin');
}

// ---- HTTP
export async function panel(store, req, url, p) {
  ensure(store);
  if (p === '/panel' || p === '/panel/') {
    if (req.method !== 'GET' && req.method !== 'HEAD') return err(405, 'method');
    const nonce = rand(22, 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789');
    return new Response(PAGE.replaceAll('__NONCE__', nonce), {
      headers: {
        'content-type': 'text/html; charset=utf-8', ...SEC_HEADERS,
        'content-security-policy': `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
      },
    });
  }
  if (!p.startsWith('/panel/api/')) return err(404, 'not found');
  const path = p.slice('/panel/api'.length);

  if (req.method === 'POST') {
    // Cross-site writes: SameSite=Strict already blocks the cookie; also demand a same-origin JSON request.
    const origin = req.headers.get('origin');
    // (req.url is the internal https://store/... address here, so compare with the Host header.)
    let originHost = null;
    try { originHost = origin ? new URL(origin).host : null; } catch { originHost = '?'; }
    if (origin && origin !== store.env.PUBLIC_URL && originHost !== req.headers.get('host')) return err(403, 'origin');
    if (req.headers.get('x-panel') !== '1') return err(403, 'header');
  } else if (req.method !== 'GET') return err(405, 'method');
  const body = req.method === 'POST' ? await req.json().catch(() => ({})) : {};

  if (path === '/login' && req.method === 'POST') return login(store, req, body);

  const s = await session(store, req);
  if (!s) return err(401, 'login');
  const must = store.meta('panel_must') === '1';

  if (path === '/logout' && req.method === 'POST') {
    store.sql.exec('DELETE FROM panel_sessions WHERE id=?', s.id);
    return json({ ok: true }, 200, { 'set-cookie': cookie('x', 0) });
  }
  if (path === '/me') return json({ username: store.meta('panel_user'), mustChange: must || !!s.limited });
  if (path === '/credentials' && req.method === 'POST') return changeCredentials(store, s, body);
  if (must || s.limited) return err(403, 'change');

  let m;
  if (path === '/users' && req.method === 'GET') return json(usersList(store));
  if ((m = /^\/users\/(\d{1,20})$/.exec(path)) && req.method === 'GET') {
    const d = userDetail(store, Number(m[1]));
    return d ? json(d) : err(404, 'کاربر پیدا نشد');
  }
  if ((m = /^\/users\/(\d{1,20})\/action$/.exec(path)) && req.method === 'POST') {
    const uid = Number(m[1]);
    if (!ACTIONS.includes(body.action)) return err(400, 'عملیات نامعتبر');
    if (store.isAdmin(uid)) return err(400, 'این حساب مدیر است');
    const r = await store.adminUserAction(uid, body.action);
    if (!r.ok) return err(400, r.error);
    return json({ ok: true, note: r.note, user: userDetail(store, uid) });
  }
  if ((m = /^\/users\/(\d{1,20})\/files\/([A-Za-z0-9]{16})\/delete$/.exec(path)) && req.method === 'POST') {
    const uid = Number(m[1]);
    const f = store.one('SELECT id, owner, status FROM files WHERE id=?', m[2]);
    if (!f || f.owner !== uid) return err(404, 'فایل پیدا نشد');
    if (!['ready', 'failed'].includes(f.status)) return err(409, 'این فایل در حال انتقال است؛ کمی بعد دوباره امتحان کنید');
    await store.deleteFile(f.id);
    return json({ ok: true, note: 'فایل حذف شد', user: userDetail(store, uid) });
  }
  return err(404, 'not found');
}

async function login(store, req, body) {
  const now = Date.now();
  const f = fails(store);
  if (f.lock > now) return err(429, 'locked', { 'retry-after': String(Math.ceil((f.lock - now) / 1000)) });
  const username = String(body.username || '').slice(0, 64);
  const password = String(body.password || '').slice(0, 256);
  const userOk = same(username, store.meta('panel_user') || '\u0000');
  const passOk = await checkHash(password, store.meta('panel_pw'));
  if (!userOk || !passOk || !store.meta('panel_user')) {
    const n = f.first && now - f.first < FAIL_WINDOW ? f.n + 1 : 1;
    const first = n === 1 ? now : f.first;
    const lock = n >= MAX_FAILS ? now + FAIL_WINDOW : 0;
    store.meta('panel_fail', JSON.stringify({ n: lock ? 0 : n, first: lock ? 0 : first, lock }));
    if (lock) await store.notifyAdmin(`⚠️ پنل وب: ${MAX_FAILS.toLocaleString("fa-IR")} تلاش ناموفق ورود؛ ورود ۱۵ دقیقه قفل شد.\nاگر خودتان نبودید، با /panel رمز را عوض کنید.`);
    return err(401, lock ? 'locked' : 'bad', lock ? { 'retry-after': String(FAIL_WINDOW / 1000) } : {});
  }
  store.meta('panel_fail', null);
  const must = store.meta('panel_must') === '1';
  const setCookie = await newSession(store, must);
  const ip = req.headers.get('cf-connecting-ip') || '?';
  await store.notifyAdmin(`🔓 ورود به پنل وب${must ? ' (با رمز موقت)' : ''}\nIP: <code>${ip.replace(/[^0-9a-fA-F:.]/g, '')}</code>`);
  return json({ ok: true, mustChange: must }, 200, { 'set-cookie': setCookie });
}

async function changeCredentials(store, s, body) {
  const current = String(body.current || '').slice(0, 256);
  const username = String(body.username || '').trim();
  const password = String(body.password || '');
  if (!(await checkHash(current, store.meta('panel_pw')))) return err(400, 'رمز فعلی درست نیست');
  if (!/^[A-Za-z0-9_.-]{3,32}$/.test(username)) return err(400, 'نام کاربری ۳ تا ۳۲ حرف انگلیسی، عدد یا . _ - باشد');
  if (password.length < 10 || password.length > 128) return err(400, 'رمز جدید باید دست‌کم ۱۰ نویسه باشد');
  if (password === current) return err(400, 'رمز جدید باید با رمز فعلی فرق کند');
  if (store.meta('panel_must') === '1' && username === store.meta('panel_user')) return err(400, 'نام کاربری موقت را هم عوض کنید');
  store.meta('panel_user', username);
  store.meta('panel_pw', await makeHash(password));
  store.meta('panel_must', null);
  // Sign out everything else and give this browser a full session.
  store.sql.exec('DELETE FROM panel_sessions');
  const setCookie = await newSession(store, false);
  await store.notifyAdmin('🔑 نام کاربری و رمز پنل وب عوض شد.');
  return json({ ok: true }, 200, { 'set-cookie': setCookie });
}

// ---- data
const quotaOf = (q) => (Number.isFinite(q) ? q : null); // the owner is unlimited

function usersList(store) {
  const files = Object.fromEntries(store.q(`SELECT owner, COUNT(*) AS c FROM files WHERE status='ready' GROUP BY owner`).map((r) => [r.owner, r.c]));
  const tvs = new Set(store.q('SELECT user_id FROM devices').map((r) => r.user_id));
  return store.q('SELECT id, first_name, username, plan, expires_at, banned, created_at, last_seen FROM users ORDER BY last_seen DESC').map((u) => {
    const lim = store.limits(u);
    return {
      id: u.id, first_name: u.first_name, username: u.username, plan: u.plan, plan_title: lim.title,
      expires_at: u.plan !== 'free' ? u.expires_at : null, used: store.userUsed(u.id), quota: quotaOf(lim.quota),
      files: files[u.id] || 0, tv: tvs.has(u.id), banned: !!u.banned, created_at: u.created_at, last_seen: u.last_seen,
      admin: store.isAdmin(u.id),
    };
  });
}

function userDetail(store, uid) {
  const u = store.user(uid);
  if (!u) return null;
  const lim = store.limits(u);
  const tv = store.one('SELECT created_at, last_seen FROM devices WHERE user_id=?', uid);
  return {
    id: u.id, first_name: u.first_name, username: u.username, plan: u.plan, plan_title: lim.title,
    expires_at: u.plan !== 'free' ? u.expires_at : null, used: store.userUsed(uid), quota: quotaOf(lim.quota),
    banned: !!u.banned, created_at: u.created_at, last_seen: u.last_seen, terms_at: u.terms_at, referred_by: u.referred_by,
    admin: store.isAdmin(uid),
    tv: tv ? { since: tv.created_at, last_seen: tv.last_seen } : null,
    files: store.q('SELECT id, name, size, kind, status, storage, created_at FROM files WHERE owner=? ORDER BY created_at DESC', uid),
    payments: store.q('SELECT id, plan, months, amount, status, created_at, decided_at FROM payments WHERE user_id=? ORDER BY id DESC', uid),
  };
}
