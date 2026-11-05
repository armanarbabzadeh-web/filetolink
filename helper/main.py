"""Large-file helper for the File-to-Link bot.

Telegram's Bot API can't download files over 20 MB, so this small service logs in
as the same bot over MTProto (Pyrogram), streams such files from Telegram and
uploads them to the Cloudflare Worker in parts (Cloudflare's free plan caps each
request body at 100 MB).

Flow: the Worker POSTs /wake -> we fetch /helper/jobs from the Worker -> for each
job we stream the file and PUT it to /helper/upload/<id>?offset=N, reporting
progress, then POST /helper/finish/<id> (or /helper/fail/<id>).

Env: API_ID, API_HASH, BOT_TOKEN, WORKER_URL, HELPER_SECRET,
     PORT (Render sets it), RENDER_EXTERNAL_URL (Render sets it), PROXY (local testing).
"""

import asyncio
import logging
import os
import time
from urllib.parse import urlparse

from aiohttp import ClientSession, ClientTimeout, web
from pyrogram import Client

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("helper")
logging.getLogger("pyrogram").setLevel(logging.WARNING)

API_ID = int(os.environ["API_ID"])
API_HASH = os.environ["API_HASH"]
BOT_TOKEN = os.environ["BOT_TOKEN"]
WORKER_URL = os.environ["WORKER_URL"].rstrip("/")
SECRET = os.environ["HELPER_SECRET"]
PORT = int(os.environ.get("PORT", "10000"))
SELF_URL = os.environ.get("RENDER_EXTERNAL_URL", "").rstrip("/")
PART_CHUNKS = 20  # each PUT = 20 storage chunks (~38 MB)

AUTH = {"Authorization": f"Bearer {SECRET}"}


def proxy_settings():
    raw = os.environ.get("PROXY")  # e.g. socks5://127.0.0.1:10808 for local testing
    if not raw:
        return None
    u = urlparse(raw)
    return {"scheme": u.scheme, "hostname": u.hostname, "port": u.port}


tg = Client(
    "helper",
    api_id=API_ID,
    api_hash=API_HASH,
    bot_token=BOT_TOKEN,
    in_memory=True,
    no_updates=True,
    proxy=proxy_settings(),
)

wake = asyncio.Event()
busy = False
http: ClientSession | None = None


async def call(method, path, *, data=None, json=None, tries=4):
    """Request to the Worker with retries. Returns parsed JSON (or text)."""
    last = None
    for attempt in range(tries):
        try:
            async with http.request(method, WORKER_URL + path, data=data, json=json, headers=AUTH) as r:
                body = await r.text()
                if r.status >= 500 or r.status == 429:
                    raise RuntimeError(f"{method} {path}: HTTP {r.status} {body[:200]}")
                if r.status >= 400:
                    raise PermissionError(f"{method} {path}: HTTP {r.status} {body[:200]}")
                try:
                    return await r.json(content_type=None)
                except Exception:
                    return body
        except PermissionError:
            raise
        except Exception as e:  # network / 5xx: retry with backoff
            last = e
            log.warning("retry %d %s %s: %s", attempt + 1, method, path, e)
            await asyncio.sleep(2 * (attempt + 1))
    raise last


async def process(job, chunk):
    jid, name, size = job["id"], job["name"], job["size"]
    part = chunk * PART_CHUNKS
    log.info("job %s: %s (%d bytes)", jid, name, size)
    buf = bytearray()
    offset = done = 0
    last_report = 0.0
    started = time.time()
    try:
        async for piece in tg.stream_media(job["tg_file_id"]):
            buf += piece
            done += len(piece)
            while len(buf) >= part:
                await call("PUT", f"/helper/upload/{jid}?offset={offset}", data=bytes(buf[:part]))
                del buf[:part]
                offset += part
            if time.time() - last_report > 10:
                last_report = time.time()
                speed = done / max(1.0, time.time() - started)
                await call("POST", f"/helper/progress/{jid}", json={"done": done, "total": size, "speed": int(speed)}, tries=1)
        if buf or offset == 0:
            await call("PUT", f"/helper/upload/{jid}?offset={offset}", data=bytes(buf))
        res = await call("POST", f"/helper/finish/{jid}")
        log.info("job %s done in %.0fs: %s", jid, time.time() - started, res)
    except Exception as e:
        log.exception("job %s failed", jid)
        try:
            await call("POST", f"/helper/fail/{jid}", data=f"{type(e).__name__}: {e}"[:400], tries=2)
        except Exception:
            log.exception("could not report failure")


async def job_loop():
    global busy
    while True:
        await wake.wait()
        wake.clear()
        busy = True
        try:
            data = await call("GET", "/helper/jobs")
            for job in data.get("jobs", []):
                await process(job, data["chunk"])
        except Exception:
            log.exception("job loop error")
        finally:
            busy = False


async def keep_awake():
    # Render's free plan sleeps after 15 minutes without inbound requests,
    # so ping ourselves while a long transfer is running.
    while True:
        await asyncio.sleep(240)
        if busy and SELF_URL:
            try:
                async with http.get(SELF_URL + "/health") as r:
                    await r.read()
            except Exception as e:
                log.warning("self-ping failed: %s", e)


async def handle_wake(request):
    if request.headers.get("Authorization") != f"Bearer {SECRET}":
        return web.Response(status=401, text="unauthorized")
    wake.set()
    return web.json_response({"ok": True, "busy": busy})


async def handle_health(_):
    return web.json_response({"ok": True, "busy": busy})


async def main():
    global http
    # Cloudflare rejects default Python user agents, so send our own.
    http = ClientSession(
        timeout=ClientTimeout(total=None, sock_connect=30, sock_read=300),
        headers={"User-Agent": "FileToLinkHelper/1.0"},
    )

    app = web.Application()
    app.add_routes([web.get("/", handle_health), web.get("/health", handle_health), web.post("/wake", handle_wake)])
    runner = web.AppRunner(app)
    await runner.setup()
    await web.TCPSite(runner, "0.0.0.0", PORT).start()
    log.info("listening on :%d", PORT)

    await tg.start()
    me = await tg.get_me()
    log.info("logged in as @%s", me.username)

    wake.set()  # process anything queued while we were asleep
    await asyncio.gather(job_loop(), keep_awake())


async def run_once():
    """GitHub Actions mode: move every queued large file, then exit."""
    global http
    http = ClientSession(
        timeout=ClientTimeout(total=None, sock_connect=30, sock_read=300),
        headers={"User-Agent": "FileToLinkHelper/1.0"},
    )
    await tg.start()
    log.info("logged in as @%s", (await tg.get_me()).username)
    tried = set()
    try:
        while True:
            data = await call("GET", "/helper/jobs")
            jobs = [j for j in data.get("jobs", []) if j["id"] not in tried]
            if not jobs:
                break
            for job in jobs:
                tried.add(job["id"])
                await process(job, data["chunk"])
    finally:
        await tg.stop()
        await http.close()
    log.info("queue empty, %d job(s) handled", len(tried))


if __name__ == "__main__":
    import sys

    asyncio.run(run_once() if "--once" in sys.argv else main())
