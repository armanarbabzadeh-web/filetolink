// Private API for the owner's web panel, which runs on the owner's VPS (helper/panel.py).
// The panel's login, password and sessions live on the VPS; this API only serves user data and the
// admin bot's user actions. The outer router lets a request in only with Bearer PANEL_SECRET.
const ACTIONS = ['ext', 'p1g', 'p5g', 'p20g', 'p50g', 'free', 'ban', 'unban', 'tvoff'];
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const quotaOf = (q) => (Number.isFinite(q) ? q : null); // the owner is unlimited
const json = (data, status = 200) => Response.json(data, { status, headers: { 'cache-control': 'no-store' } });

export async function vpsPanel(store, req, p) {
  const path = p.slice('/vpspanel'.length);
  const body = req.method === 'POST' ? await req.json().catch(() => ({})) : {};
  let m;
  if (path === '/users' && req.method === 'GET') return json(usersList(store));
  if ((m = /^\/users\/(\d{1,20})$/.exec(path)) && req.method === 'GET') {
    const d = await userDetail(store, Number(m[1]));
    return d ? json(d) : json({ error: 'کاربر پیدا نشد' }, 404);
  }
  if ((m = /^\/users\/(\d{1,20})\/action$/.exec(path)) && req.method === 'POST') {
    const uid = Number(m[1]);
    if (!ACTIONS.includes(body.action)) return json({ error: 'عملیات نامعتبر' }, 400);
    if (store.isAdmin(uid)) return json({ error: 'این حساب مدیر است' }, 400);
    const r = await store.adminUserAction(uid, body.action);
    if (!r.ok) return json({ error: r.error }, 400);
    return json({ ok: true, note: r.note, user: await userDetail(store, uid) });
  }
  if ((m = /^\/users\/(\d{1,20})\/files\/([A-Za-z0-9]{16})\/delete$/.exec(path)) && req.method === 'POST') {
    const uid = Number(m[1]);
    const f = store.one('SELECT id, owner, status FROM files WHERE id=?', m[2]);
    if (!f || f.owner !== uid) return json({ error: 'فایل پیدا نشد' }, 404);
    if (!['ready', 'failed'].includes(f.status)) return json({ error: 'این فایل در حال انتقال است؛ کمی بعد دوباره امتحان کنید' }, 409);
    await store.deleteFile(f.id);
    return json({ ok: true, note: 'فایل حذف شد', user: await userDetail(store, uid) });
  }
  // The VPS asks every minute whether /panel was sent in the admin bot (one-shot flag).
  if (path === '/poll' && req.method === 'POST') {
    const reset = !!store.meta('panel_reset_req');
    if (reset) store.meta('panel_reset_req', null);
    return json({ reset });
  }
  // Messages to the owner through the admin bot. Fixed templates only; values are escaped.
  if (path === '/notify' && req.method === 'POST') {
    const t = noticeText(body);
    if (!t) return json({ error: 'unknown notice' }, 400);
    await store.notifyAdmin(t);
    return json({ ok: true });
  }
  return json({ error: 'not found' }, 404);
}

function noticeText(b) {
  const ip = String(b.ip || '?').replace(/[^0-9a-fA-F:.]/g, '').slice(0, 45) || '?';
  if (b.kind === 'creds') {
    return [
      '🔐 <b>ورود به پنل مدیریت (سرور خودتان)</b>',
      b.url ? `آدرس: ${esc(b.url)}` : null,
      `نام کاربری: <code>${esc(b.username)}</code>`,
      `رمز موقت: <tg-spoiler><code>${esc(b.password)}</code></tg-spoiler>`,
      '',
      'بعد از اولین ورود باید نام کاربری و رمز را عوض کنید.',
      'رمز قبلی و همه نشست‌های باز باطل شدند. این پیام را بعد از ورود پاک کنید.',
    ].filter((x) => x !== null).join('\n');
  }
  if (b.kind === 'login') return `🔓 ورود به پنل مدیریت${b.temp ? ' (با رمز موقت)' : ''}\nIP: <code>${ip}</code>`;
  if (b.kind === 'locked') return `⚠️ پنل مدیریت: ۵ تلاش ناموفق ورود از IP <code>${ip}</code>؛ ورود ۱۵ دقیقه قفل شد.\nاگر خودتان نبودید، با /panel رمز را عوض کنید.`;
  if (b.kind === 'changed') return '🔑 نام کاربری و رمز پنل مدیریت عوض شد.';
  return null;
}

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

// Open/download link for a stored file: Arvan objects are public-read; the owner's Cloudflare and VPS
// files go through the owner's own domain with the helper's permanent signed links.
async function fileUrl(store, f) {
  if (f.status !== 'ready') return null;
  if (f.storage === 'arvan') return store.publicUrl(f.obj_key || store.fileKey(f));
  if ((f.storage === 'cf' || f.storage === 'do') && store.ownDomain()) return store.ownLink(f, 'c');
  if (f.storage === 'vps' && store.ownDomain()) return store.ownLink(f, 'v');
  return null;
}

async function userDetail(store, uid) {
  const u = store.user(uid);
  if (!u) return null;
  const lim = store.limits(u);
  const tv = store.one('SELECT created_at, last_seen FROM devices WHERE user_id=?', uid);
  const files = store.q('SELECT id, name, size, kind, status, storage, obj_key, created_at FROM files WHERE owner=? ORDER BY created_at DESC', uid);
  for (const f of files) { f.url = await fileUrl(store, f); delete f.obj_key; }
  return {
    id: u.id, first_name: u.first_name, username: u.username, plan: u.plan, plan_title: lim.title,
    expires_at: u.plan !== 'free' ? u.expires_at : null, used: store.userUsed(uid), quota: quotaOf(lim.quota),
    banned: !!u.banned, created_at: u.created_at, last_seen: u.last_seen, terms_at: u.terms_at, referred_by: u.referred_by,
    admin: store.isAdmin(uid),
    tv: tv ? { since: tv.created_at, last_seen: tv.last_seen } : null,
    files,
    payments: store.q('SELECT id, plan, months, amount, status, created_at, decided_at FROM payments WHERE user_id=? ORDER BY id DESC', uid),
  };
}
