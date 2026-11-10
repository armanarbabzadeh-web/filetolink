"""TeleTVShare owner's web panel (users only). Runs on the owner's VPS behind Caddy at https://<own domain>/panel.

* Login, the password hash (PBKDF2-SHA256) and sessions live here, in PANEL_STATE (owner-only file).
* User data and actions come from the Worker's private API /vpspanel/* (Bearer PANEL_SECRET).
* Temporary credentials (first login and recovery) go to the owner through the admin bot only:
  /panel in the admin bot sets a flag on the Worker, this service sees it within a minute; or run
  `python panel.py --reset` on the VPS. They must be changed on first login.
* Standard library only. Listens on 127.0.0.1 only.

Env: WORKER_URL, PANEL_SECRET, PANEL_URL (public address, for the bot message), PANEL_PORT (8091),
     PANEL_STATE (/var/lib/teletvshare/panel.json)
"""
import base64
import hashlib
import hmac
import json
import os
import re
import secrets
import sys
import threading
import time
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

WORKER_URL = os.environ.get("WORKER_URL", "").rstrip("/")
PANEL_SECRET = os.environ.get("PANEL_SECRET", "")
PANEL_URL = os.environ.get("PANEL_URL", "")
PORT = int(os.environ.get("PANEL_PORT", "8091"))
STATE = os.environ.get("PANEL_STATE", "/var/lib/teletvshare/panel.json")
HERE = os.path.dirname(os.path.abspath(__file__))
# Offline UI tests only: one extra http origin allowed for pictures and video (never set on the VPS).
DEV_MEDIA = (" " + os.environ["PANEL_DEV_MEDIA"]) if re.fullmatch(r"http://127\.0\.0\.1:\d+", os.environ.get("PANEL_DEV_MEDIA", "")) else ""

COOKIE = "tvs_panel"
SESSION_S = 4 * 3600
ITER = 600_000
MAX_FAILS = 5
FAIL_WINDOW = 15 * 60
POLL_S = int(os.environ.get("PANEL_POLL", "60"))
ABC = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789"
lock = threading.RLock()


# ---------------------------------------------------------------- state
def load():
    try:
        with open(STATE, encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return {}


def save(st):
    tmp = STATE + ".tmp"
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        json.dump(st, f)
    os.replace(tmp, STATE)


def b64(b):
    return base64.b64encode(b).decode()


def make_hash(password):
    salt = secrets.token_bytes(16)
    return {"salt": b64(salt), "iter": ITER, "hash": b64(hashlib.pbkdf2_hmac("sha256", password.encode(), salt, ITER))}


def check_hash(password, rec):
    # Same work whether or not credentials exist, so timing says nothing.
    salt = base64.b64decode(rec["salt"]) if rec else b"\0" * 16
    h = b64(hashlib.pbkdf2_hmac("sha256", password.encode(), salt, (rec or {}).get("iter", ITER)))
    return bool(rec) and hmac.compare_digest(h, rec["hash"])


def sid(token):
    return hashlib.sha256(token.encode()).hexdigest()


# ---------------------------------------------------------------- Worker API
def worker(method, path, body=None, timeout=30):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(WORKER_URL + "/vpspanel" + path, data=data, method=method, headers={
        "Authorization": "Bearer " + PANEL_SECRET, "Content-Type": "application/json", "User-Agent": "TeleTVSharePanel/1.0"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, json.loads(r.read() or b"{}")
    except urllib.error.HTTPError as e:
        if e.code in (401, 403):  # never pass this on as "please log in": it is the VPS-Worker key
            return 502, {"error": "کلید ارتباط سرور با ورکر پذیرفته نشد (PANEL_SECRET)"}
        try:
            return e.code, json.loads(e.read() or b"{}")
        except ValueError:
            return e.code, {"error": f"خطای ورکر ({e.code})"}
    except Exception:
        return 502, {"error": "اتصال سرور به ورکر برقرار نشد"}


def notify(**notice):
    for _ in range(5):
        code, _j = worker("POST", "/notify", notice)
        if code == 200:
            return True
        time.sleep(10)
    return False


def reset_credentials():
    """New temporary credentials, all sessions out, sent to the owner via the admin bot. Never printed."""
    username = "admin-" + "".join(secrets.choice("abcdefghijkmnpqrstuvwxyz23456789") for _ in range(5))
    password = "".join(secrets.choice(ABC) for _ in range(16))
    with lock:
        save({"user": username, "pw": make_hash(password), "must": True, "fail": None, "sessions": {}})
    return notify(kind="creds", username=username, password=password, url=PANEL_URL)


def poller():
    while True:
        time.sleep(POLL_S)
        code, j = worker("POST", "/poll", {})
        if code == 200 and j.get("reset"):
            reset_credentials()


# ---------------------------------------------------------------- HTTP
SEC = {
    "Cache-Control": "no-store", "X-Frame-Options": "DENY", "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer", "X-Robots-Tag": "noindex, nofollow",
}
USER_RE = re.compile(r"^/users/(\d{1,20})$")
ACTION_RE = re.compile(r"^/users/(\d{1,20})/action$")
DELETE_RE = re.compile(r"^/users/(\d{1,20})/files/([A-Za-z0-9]{16})/delete$")


def cookie(token, max_age):
    return f"{COOKIE}={token}; Path=/panel; HttpOnly; Secure; SameSite=Strict; Max-Age={max_age}"


class Handler(BaseHTTPRequestHandler):
    server_version = "panel"
    sys_version = ""

    def log_message(self, fmt, *args):  # no access log (user ids are in the paths)
        pass

    # -- helpers
    def send(self, status, body, ctype, extra=None):
        data = body if isinstance(body, bytes) else body.encode()
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        for k, v in {**SEC, **(extra or {})}.items():
            self.send_header(k, v)
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(data)

    def json(self, status, data, extra=None):
        self.send(status, json.dumps(data, ensure_ascii=False), "application/json; charset=utf-8", extra)

    def err(self, status, error, extra=None):
        self.json(status, {"error": error}, extra)

    def ip(self):
        xff = self.headers.get("X-Forwarded-For", "")  # set by Caddy, which is the only way in
        return (xff.split(",")[-1].strip() if xff else self.client_address[0])[:45]

    def session(self):
        m = re.search(rf"(?:^|;\s*){COOKIE}=([A-Za-z0-9_-]+)", self.headers.get("Cookie", ""))
        if not m:
            return None, None
        key = sid(m.group(1))
        with lock:
            st = load()
            now = time.time()
            sessions = {k: v for k, v in (st.get("sessions") or {}).items() if v["exp"] > now}
            if sessions != st.get("sessions"):
                st["sessions"] = sessions
                save(st)
            return (key, sessions[key]) if key in sessions else (None, None)

    def new_session(self, st, limited):
        token = secrets.token_urlsafe(32).replace("-", "A").replace("_", "B")
        st.setdefault("sessions", {})[sid(token)] = {"exp": time.time() + SESSION_S, "limited": limited}
        return cookie(token, SESSION_S)

    # -- routes
    def do_HEAD(self):
        self.do_GET()

    def do_GET(self):
        path = self.path.split("?", 1)[0]
        if path in ("/panel", "/panel/"):
            nonce = secrets.token_urlsafe(16).replace("-", "A").replace("_", "B")
            with open(os.path.join(HERE, "panel.html"), encoding="utf-8") as f:
                page = f.read().replace("__NONCE__", nonce)
            return self.send(200, page, "text/html; charset=utf-8", {
                "Content-Security-Policy": f"default-src 'none'; script-src 'nonce-{nonce}'; style-src 'nonce-{nonce}'; "
                                           f"connect-src 'self'; img-src 'self' https: data:{DEV_MEDIA}; media-src 'self' https:{DEV_MEDIA}; "
                                           "base-uri 'none'; form-action 'none'; frame-ancestors 'none'"})
        return self.api("GET", path)

    def do_POST(self):
        path = self.path.split("?", 1)[0]
        origin = self.headers.get("Origin")
        if origin and re.sub(r"^https?://", "", origin) != self.headers.get("Host", ""):
            return self.err(403, "origin")
        if self.headers.get("X-Panel") != "1":
            return self.err(403, "header")
        return self.api("POST", path)

    def body(self):
        n = min(int(self.headers.get("Content-Length") or 0), 65536)
        try:
            return json.loads(self.rfile.read(n) or b"{}") if n else {}
        except ValueError:
            return {}

    def api(self, method, path):
        if not path.startswith("/panel/api/"):
            return self.err(404, "not found")
        path = path[len("/panel/api"):]
        body = self.body() if method == "POST" else {}
        if path == "/login" and method == "POST":
            return self.login(body)
        key, s = self.session()
        if not s:
            return self.err(401, "login")
        with lock:
            st = load()
        must = bool(st.get("must"))
        if path == "/logout" and method == "POST":
            with lock:
                st = load()
                (st.get("sessions") or {}).pop(key, None)
                save(st)
            return self.json(200, {"ok": True}, {"Set-Cookie": cookie("x", 0)})
        if path == "/me":
            return self.json(200, {"username": st.get("user"), "mustChange": must or s.get("limited", False)})
        if path == "/credentials" and method == "POST":
            return self.change(body)
        if must or s.get("limited"):
            return self.err(403, "change")

        if path == "/users" and method == "GET":
            return self.json(*worker("GET", "/users"))
        if USER_RE.match(path) and method == "GET":
            return self.json(*worker("GET", path))
        if ACTION_RE.match(path) and method == "POST":
            return self.json(*worker("POST", path, {"action": str(body.get("action", ""))[:16]}))
        if DELETE_RE.match(path) and method == "POST":
            return self.json(*worker("POST", path, {}))
        return self.err(404, "not found")

    def login(self, body):
        now = time.time()
        username = str(body.get("username", ""))[:64]
        password = str(body.get("password", ""))[:256]
        with lock:
            st = load()
        f = st.get("fail") or {"n": 0, "first": 0, "lock": 0}
        if f["lock"] > now:
            return self.err(429, "locked", {"Retry-After": str(int(f["lock"] - now) + 1)})
        user_ok = bool(st.get("user")) and hmac.compare_digest(username.encode(), st["user"].encode())
        pass_ok = check_hash(password, st.get("pw"))
        with lock:
            st = load()
            if not (user_ok and pass_ok):
                n = f["n"] + 1 if f["first"] and now - f["first"] < FAIL_WINDOW else 1
                locked = n >= MAX_FAILS
                st["fail"] = {"n": 0, "first": 0, "lock": now + FAIL_WINDOW} if locked else {"n": n, "first": f["first"] if n > 1 else now, "lock": 0}
                save(st)
            else:
                st["fail"] = None
                must = bool(st.get("must"))
                set_cookie = self.new_session(st, must)
                save(st)
        if not (user_ok and pass_ok):
            if locked:
                threading.Thread(target=notify, kwargs={"kind": "locked", "ip": self.ip()}, daemon=True).start()
                return self.err(401, "locked", {"Retry-After": str(FAIL_WINDOW)})
            return self.err(401, "bad")
        threading.Thread(target=notify, kwargs={"kind": "login", "ip": self.ip(), "temp": must}, daemon=True).start()
        return self.json(200, {"ok": True, "mustChange": must}, {"Set-Cookie": set_cookie})

    def change(self, body):
        current = str(body.get("current", ""))[:256]
        username = str(body.get("username", "")).strip()
        password = str(body.get("password", ""))
        with lock:
            st = load()
        if not check_hash(current, st.get("pw")):
            return self.err(400, "رمز فعلی درست نیست")
        if not re.fullmatch(r"[A-Za-z0-9_.-]{3,32}", username):
            return self.err(400, "نام کاربری ۳ تا ۳۲ حرف انگلیسی، عدد یا . _ - باشد")
        if not 10 <= len(password) <= 128:
            return self.err(400, "رمز جدید باید دست‌کم ۱۰ نویسه باشد")
        if password == current:
            return self.err(400, "رمز جدید باید با رمز فعلی فرق کند")
        if st.get("must") and username == st.get("user"):
            return self.err(400, "نام کاربری موقت را هم عوض کنید")
        new_hash = make_hash(password)
        with lock:
            st = load()
            st.update({"user": username, "pw": new_hash, "must": False, "fail": None, "sessions": {}})
            set_cookie = self.new_session(st, False)  # every other browser is signed out
            save(st)
        threading.Thread(target=notify, kwargs={"kind": "changed"}, daemon=True).start()
        return self.json(200, {"ok": True}, {"Set-Cookie": set_cookie})


def main():
    if not WORKER_URL or not PANEL_SECRET:
        sys.exit("WORKER_URL and PANEL_SECRET are required")
    if "--reset" in sys.argv:
        ok = reset_credentials()
        print("new temporary credentials sent to the admin bot" if ok else "could not reach the Worker; try again")
        sys.exit(0 if ok else 1)
    if not os.path.exists(STATE):
        reset_credentials()
    threading.Thread(target=poller, daemon=True).start()
    srv = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    srv.daemon_threads = True
    print(f"panel on 127.0.0.1:{PORT}", flush=True)
    srv.serve_forever()


if __name__ == "__main__":
    main()
