"""TeleTVShare helper: runs always-on on the VPS (`python main.py --service`, HELPER_NAME=vps) and,
as a fallback, on GitHub Actions (`python main.py`, one pass over the queue).

1. Telegram files over 20 MB (the Bot API can't download them): logs in as the main bot over MTProto
   with the public app id the Worker hands out (GET /helper/tg) and streams the file to Arvan.
2. Video-site links (owner only): lists the qualities (yt-dlp), downloads the chosen one.
The owner's Cloudflare files are sent to the Worker in parts instead of Arvan.

Every job is claimed first (a lease the Worker hands out); progress keeps it alive, so the VPS and
GitHub never work on the same file, and a job left by a stopped helper is picked up again.

Env: WORKER_URL, HELPER_SECRET, ARVAN_ENDPOINT, ARVAN_REGION, ARVAN_BUCKET,
     ARVAN_ACCESS_KEY, ARVAN_SECRET_KEY, YT_COOKIES_FILE (optional),
     HELPER_NAME (vps|gh, default gh), SESSION_DIR (VPS: keep the Telegram login between jobs)
Logs never contain URLs, titles or file names (the repository and its run logs are public).
"""

import asyncio
import hashlib
import logging
import os
import shutil
import sys
import tempfile
import time
from concurrent.futures import ThreadPoolExecutor

import boto3
from aiohttp import ClientSession, ClientTimeout
from botocore.config import Config

import links

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("helper")

WORKER_URL = os.environ["WORKER_URL"].rstrip("/")
HELPER_NAME = os.environ.get("HELPER_NAME", "gh")
AUTH = {"Authorization": f"Bearer {os.environ['HELPER_SECRET']}", "User-Agent": "TeleTVShareHelper/4.0", "X-Helper": HELPER_NAME}
SESSION_DIR = os.environ.get("SESSION_DIR")  # set on the VPS: one Telegram login that stays, not a new login per run
POLL = 5            # seconds between queue checks in service mode
DISK_RESERVE = 2 * 1024**3
BUCKET = os.environ["ARVAN_BUCKET"]

s3 = boto3.client(
    "s3",
    endpoint_url=os.environ["ARVAN_ENDPOINT"],
    region_name=os.environ["ARVAN_REGION"],
    aws_access_key_id=os.environ["ARVAN_ACCESS_KEY"],
    aws_secret_access_key=os.environ["ARVAN_SECRET_KEY"],
    config=Config(s3={"addressing_style": "path"}, signature_version="s3v4", retries={"max_attempts": 5}, max_pool_connections=12),
)
http: ClientSession | None = None

PART = 16 * 1024 * 1024  # S3 multipart part size
PARALLEL = 16            # 16 MB parts in flight to Arvan at once, shared by ALL files (keeps memory bounded)
MAX_JOBS = int(os.environ.get("MAX_JOBS", "25"))  # files at the same time in service mode (the owner may send many)
POOL = ThreadPoolExecutor(PARALLEL)  # upload threads shared by all files
PART_SLOTS = asyncio.Semaphore(PARALLEL)
tg = None
TG_LOCK = asyncio.Lock()


async def telegram():
    """Log in as the main bot over MTProto (needed for files over 20 MB). Details come from the Worker."""
    global tg
    async with TG_LOCK:  # several jobs may ask at once; log in only once
        if tg is None:
            await _login()
    return tg


async def _login():
    global tg
    if tg is None:
        from pyrogram import Client
        logging.getLogger("pyrogram").setLevel(logging.WARNING)
        cfg = await call("GET", "/helper/tg")
        if SESSION_DIR:
            # one session file per bot token: a new token starts a fresh login automatically
            name = "bot_" + hashlib.sha256(cfg["bot_token"].encode()).hexdigest()[:12]
            os.makedirs(SESSION_DIR, exist_ok=True)
            client = Client(name, api_id=int(cfg["api_id"]), api_hash=cfg["api_hash"], bot_token=cfg["bot_token"],
                            workdir=SESSION_DIR, no_updates=True)
        else:
            client = Client("helper", api_id=int(cfg["api_id"]), api_hash=cfg["api_hash"], bot_token=cfg["bot_token"],
                            in_memory=True, no_updates=True)
        await client.start()
        tg = client
        log.info("logged in to Telegram")
    return tg


async def process(job):
    """A Telegram file over 20 MB: stream it from Telegram to Arvan (S3 multipart) or to the owner's Cloudflare storage."""
    jid, key, size = job["id"], job["obj_key"], job["size"]
    cf = job.get("storage") == "cf"
    log.info("job %s (%d bytes)", jid, size)  # no file names: run logs of a public repo are public
    loop = asyncio.get_running_loop()
    client = await telegram()
    if job.get("storage") == "vps":
        return await process_vps(job, client)
    # Cloudflare parts: 10 chunks (19 MB) so many files at once still fit in memory
    part_size = int(job.get("chunk") or 1_900_000) * 10 if cf else PART
    upload_id, parts, offset = None, [], 0
    if not cf:
        mp = await loop.run_in_executor(None, lambda: s3.create_multipart_upload(
            Bucket=BUCKET, Key=key, ACL="public-read",
            ContentType=job.get("mime") or "application/octet-stream",
            ContentDisposition=job.get("disposition") or "inline",
        ))
        upload_id = mp["UploadId"]
    buf, done, last_report, started = bytearray(), 0, 0.0, time.time()
    pending = set()      # Arvan parts being uploaded right now
    next_part = 0
    sem = PART_SLOTS

    async def put_part(n, data):
        try:
            res = await loop.run_in_executor(POOL, lambda: s3.upload_part(
                Bucket=BUCKET, Key=key, UploadId=upload_id, PartNumber=n, Body=data))
            parts.append({"PartNumber": n, "ETag": res["ETag"]})
        finally:
            sem.release()

    async def flush(data):
        nonlocal offset, next_part
        if cf:  # the owner's Cloudflare storage takes parts in order
            await call("PUT", f"/helper/upload/{jid}?offset={offset}", data=data)
            offset += len(data)
            return
        await sem.acquire()  # at most PARALLEL parts in memory / in flight
        for t_ in [t_ for t_ in pending if t_.done()]:
            pending.discard(t_)
            t_.result()  # re-raise a failed part
        next_part += 1
        pending.add(asyncio.create_task(put_part(next_part, data)))

    async def drain():
        if pending:
            await asyncio.gather(*pending)
            pending.clear()

    completed = False
    try:
        async for piece in client.stream_media(job["tg_file_id"]):
            buf += piece
            done += len(piece)
            if len(buf) >= part_size:
                await flush(bytes(buf[:part_size]))
                del buf[:part_size]
            if time.time() - last_report > 10:
                last_report = time.time()
                speed = done / max(1.0, time.time() - started)
                try:
                    await call("POST", f"/helper/progress/{jid}", json={"done": done, "total": size, "speed": int(speed)}, tries=1)
                except PermissionError:
                    raise RuntimeError("cancelled by user")
                except Exception:
                    pass
        if buf or (not next_part and not offset):
            await flush(bytes(buf))
        await drain()
        if not cf:
            parts.sort(key=lambda x: x["PartNumber"])
            await loop.run_in_executor(None, lambda: s3.complete_multipart_upload(
                Bucket=BUCKET, Key=key, UploadId=upload_id, MultipartUpload={"Parts": parts}))
        completed = True
        for attempt in range(1, 6):  # Arvan can take a moment before the new object is visible
            try:
                await call("POST", f"/helper/finish/{jid}", json={})
                break
            except PermissionError as e:
                if "409" not in str(e) or attempt == 5:
                    raise
                await asyncio.sleep(5 * attempt)
        log.info("job %s done in %.0fs", jid, time.time() - started)
    except Exception as e:
        log.warning("job %s failed: %s", jid, type(e).__name__)
        if any(k in type(e).__name__ for k in ("Auth", "Unauthorized", "Revoked", "Connection")):
            await reset_telegram()
        for t_ in pending:
            t_.cancel()
        if upload_id and not completed:
            try:
                await loop.run_in_executor(None, lambda: s3.abort_multipart_upload(Bucket=BUCKET, Key=key, UploadId=upload_id))
            except Exception:
                log.warning("abort failed (ignored)")
        await fail(jid, e)



async def process_vps(job, client):
    jid, size = job["id"], job["size"]
    try:
        if not VPS_STORE:
            raise RuntimeError("no VPS storage on this helper")
        if shutil.disk_usage(VPS_STORE).free < size + DISK_RESERVE:
            raise RuntimeError("not enough disk on the VPS")
        os.makedirs(os.path.join(VPS_STORE, jid), exist_ok=True)
        tmp = vps_path(jid) + ".part"
        done, last, started = 0, 0.0, time.time()
        with open(tmp, "wb") as out:
            async for piece in client.stream_media(job["tg_file_id"]):
                out.write(piece)
                done += len(piece)
                if time.time() - last > 10:
                    last = time.time()
                    try:
                        await call("POST", f"/helper/progress/{jid}", json={"done": done, "total": size, "speed": int(done / max(1.0, time.time() - started))}, tries=1)
                    except PermissionError:
                        raise RuntimeError("cancelled by user")
                    except Exception:
                        pass
        os.replace(tmp, vps_path(jid))
        await call("POST", f"/helper/finish/{jid}", json={"size": done})
        log.info("job %s stored on VPS in %.0fs", jid, time.time() - started)
    except Exception as e:
        log.warning("job %s failed: %s", jid, type(e).__name__)
        shutil.rmtree(os.path.join(VPS_STORE or "/nonexistent", jid), ignore_errors=True)
        await fail(jid, e)


async def reset_telegram():
    global tg
    if tg is not None:
        try:
            await tg.stop()
        except Exception:
            pass
    tg = None


async def call(method, path, *, data=None, json=None, tries=4):
    last = None
    for attempt in range(tries):
        try:
            async with http.request(method, WORKER_URL + path, data=data, json=json, headers=AUTH) as r:
                body = await r.text()
                if r.status >= 500 or r.status == 429:
                    raise RuntimeError(f"{method} {path}: HTTP {r.status}")
                if r.status >= 400:
                    raise PermissionError(f"{method} {path}: HTTP {r.status} {body[:100]}")
                try:
                    return await r.json(content_type=None)
                except Exception:
                    return body
        except PermissionError:
            raise
        except Exception as e:
            last = e
            log.warning("retry %d %s: %s", attempt + 1, method, type(e).__name__)
            await asyncio.sleep(2 * (attempt + 1))
    raise last


async def fail(jid, e):
    try:
        await call("POST", f"/helper/fail/{jid}", data=f"{type(e).__name__}: {str(e)[:300]}", tries=2)
    except Exception:
        log.warning("could not report failure (job may have been cancelled)")


async def probe_link(job):
    jid = job["id"]
    log.info("probe %s", jid)
    loop = asyncio.get_running_loop()
    try:
        info = await loop.run_in_executor(None, links.probe, job["url"])
        await call("POST", f"/helper/formats/{jid}", json=info)
        log.info("probe %s: %d quality option(s)", jid, len(info["formats"]))
    except Exception as e:
        log.warning("probe %s failed: %s", jid, type(e).__name__)
        await fail(jid, e)


async def upload_to_worker(jid, path, chunk):
    """Owner's Cloudflare storage: send the file to the Worker in parts under the 100 MB request limit."""
    part = chunk * 45  # ~85 MB, chunk-aligned
    total = os.path.getsize(path)
    offset = 0
    with open(path, "rb") as fh:
        while offset < total:
            fh.seek(offset)
            data = fh.read(part)
            await call("PUT", f"/helper/upload/{jid}?offset={offset}", data=data)
            offset += len(data)
            try:
                await call("POST", f"/helper/progress/{jid}", json={"done": offset, "total": total, "speed": 0}, tries=1)
            except Exception:
                pass


async def download_link(job):
    jid, key = job["id"], job["obj_key"]
    log.info("link %s (%s)", jid, (job.get("fmt") or {}).get("label"))
    loop = asyncio.get_running_loop()
    started = time.time()

    def progress(done, total, speed):
        asyncio.run_coroutine_threadsafe(
            call("POST", f"/helper/progress/{jid}", json={"done": int(done), "total": int(total or job["size"] or 0), "speed": int(speed)}, tries=1), loop)

    try:
        need = int((job.get("size") or 0) * 1.3) + DISK_RESERVE
        free = shutil.disk_usage(tempfile.gettempdir()).free
        if free < need:
            raise RuntimeError(f"not enough disk on helper ({free // 2**20} MB free)")
        path, info = await loop.run_in_executor(None, links.download, job["url"], job["fmt"], progress)
        size = os.path.getsize(path)
        cf = job.get("storage") == "cf"
        vps = job.get("storage") == "vps"
        if vps:
            if not VPS_STORE:
                raise RuntimeError("no VPS storage on this helper")
            os.makedirs(os.path.join(VPS_STORE, jid), exist_ok=True)
            shutil.move(path, vps_path(jid))
            path = None
        elif cf:
            await upload_to_worker(jid, path, int(job.get("chunk") or 1_900_000))
        else:
            await loop.run_in_executor(None, lambda: s3.upload_file(path, BUCKET, key, ExtraArgs={
                "ACL": "public-read", "ContentType": links.content_type(path), "ContentDisposition": job.get("disposition") or "inline"}))
        extra = {"duration": info.get("duration"), "width": info.get("width"), "height": info.get("height")}
        try:
            thumb = await loop.run_in_executor(None, links.fetch_thumbnail, info.get("thumbnail"))
            if thumb and (cf or vps):
                await call("PUT", f"/helper/thumb/{jid}", data=thumb, tries=2)
            elif thumb:
                tkey = f"t/{jid}.jpg"
                await loop.run_in_executor(None, lambda: s3.put_object(Bucket=BUCKET, Key=tkey, Body=thumb, ACL="public-read",
                                                                       ContentType="image/jpeg", CacheControl="public, max-age=604800"))
                extra["thumb_key"] = tkey
        except Exception:
            log.warning("thumbnail skipped")
        if path:
            os.remove(path)
        if vps:
            extra["size"] = size
        for attempt in range(1, 6):  # Arvan can take a moment before the new object is visible
            try:
                await call("POST", f"/helper/finish/{jid}", json=extra)
                break
            except PermissionError as e:
                if "409" not in str(e) or attempt == 5:
                    raise
                await asyncio.sleep(5 * attempt)
        log.info("link %s done in %.0fs (%d bytes)", jid, time.time() - started, size)
    except Exception as e:
        log.warning("link %s failed: %s", jid, type(e).__name__)
        await fail(jid, e)


# ---- owner's VPS storage: files live in VPS_STORE/<id>/file and are served on 127.0.0.1 only.
# The Cloudflare quick tunnel (separate service) makes them reachable over HTTPS without opening a port;
# every link is signed by the Worker (HMAC with the helper secret) and expires.
VPS_STORE = os.environ.get("VPS_STORE")
TUNNEL_METRICS = os.environ.get("TUNNEL_METRICS", "http://127.0.0.1:20241")
FILE_PORT = int(os.environ.get("FILE_PORT", "8090"))


def vps_path(jid):
    return os.path.join(VPS_STORE, jid, "file")


def vps_sig(jid, exp):
    import hmac
    return hmac.new(os.environ["HELPER_SECRET"].encode(), f"{jid}:{exp}".encode(), hashlib.sha256).hexdigest()[:32]


async def start_file_server():
    from aiohttp import web
    import hmac as _hmac
    import mimetypes as _mt

    async def get_file(req):
        jid, name = req.match_info["id"], req.match_info["name"]
        try:
            exp = int(req.query.get("exp", "0"))
        except ValueError:
            exp = 0
        if exp < time.time() or not _hmac.compare_digest(req.query.get("sig", ""), vps_sig(jid, exp)):
            return web.Response(status=403, text="link expired")
        path = vps_path(jid)
        if not (jid.isalnum() and os.path.isfile(path)):
            return web.Response(status=404, text="not found")
        ctype = _mt.guess_type(name)[0] or "application/octet-stream"
        return web.FileResponse(path, headers={"Content-Type": ctype, "Cache-Control": "private, max-age=3600"})

    app = web.Application()
    app.router.add_route("GET", "/v/{id}/{name}", get_file)
    runner = web.AppRunner(app, access_log=None)
    await runner.setup()
    await web.TCPSite(runner, "127.0.0.1", FILE_PORT).start()
    log.info("file server on 127.0.0.1:%d", FILE_PORT)


async def tunnel_host():
    try:
        async with http.get(TUNNEL_METRICS + "/quicktunnel", timeout=ClientTimeout(total=3)) as r:
            return (await r.json(content_type=None)).get("hostname") or ""
    except Exception:
        return ""


async def vps_deletes(ids):
    done = []
    for jid in ids:
        if jid.isalnum():
            shutil.rmtree(os.path.join(VPS_STORE, jid), ignore_errors=True)
            done.append(jid)
    if done:
        await call("POST", "/helper/vpsdel", json={"ids": done}, tries=2)
        log.info("removed %d file(s) from VPS storage", len(done))


async def handle(job):
    """Claim a job, then do it while keeping the claim alive."""
    jid = job["id"]
    try:
        await call("POST", f"/helper/claim/{jid}", tries=2)
    except PermissionError:
        return  # another helper has it, or it was cancelled
    except Exception:
        log.warning("claim %s failed", jid)
        return

    async def keepalive():
        while True:
            await asyncio.sleep(60)
            try:
                await call("POST", f"/helper/claim/{jid}", tries=1)
            except Exception:
                pass

    ka = asyncio.create_task(keepalive())
    try:
        if job["type"] == "probe":
            await probe_link(job)
        elif job["type"] == "link":
            await download_link(job)
        else:
            await process(job)
    finally:
        ka.cancel()


async def serve():
    """VPS: stay running, check the queue every few seconds (this is also the VPS heartbeat)."""
    global http
    http = ClientSession(timeout=ClientTimeout(total=None, sock_connect=30, sock_read=300))
    log.info("service started as %s (up to %d jobs at once)", HELPER_NAME, MAX_JOBS)
    if VPS_STORE:
        os.makedirs(VPS_STORE, exist_ok=True)
        await start_file_server()
    running = {}  # job id -> task
    try:
        while True:
            try:
                for jid in [j for j, t_ in running.items() if t_.done()]:
                    running.pop(jid)
                host = await tunnel_host() if VPS_STORE else ""
                data = await call("GET", "/helper/jobs" + (f"?tunnel={host}" if host else ""), tries=2)
                jobs = data.get("jobs", []) if isinstance(data, dict) else []
                if VPS_STORE and isinstance(data, dict) and data.get("vps_delete"):
                    await vps_deletes(data["vps_delete"])
                for job in jobs:
                    if len(running) >= MAX_JOBS:
                        break
                    if job["id"] not in running:
                        running[job["id"]] = asyncio.create_task(handle(job))
                await asyncio.sleep(POLL)
            except Exception as e:
                log.warning("queue check failed: %s", type(e).__name__)
                await asyncio.sleep(15)
    finally:
        for t_ in running.values():
            t_.cancel()
        await reset_telegram()
        await http.close()


async def run_once():
    global http
    http = ClientSession(timeout=ClientTimeout(total=None, sock_connect=30, sock_read=300))
    done = set()
    idle_since = None
    try:
        while True:
            data = await call("GET", "/helper/jobs")
            jobs = [j for j in data.get("jobs", []) if (j["id"], j["type"]) not in done]
            if not jobs:
                # a user may still be choosing a quality: stay a few minutes instead of starting a new run
                if data.get("waiting") and (idle_since is None or time.time() - idle_since < 300):
                    idle_since = idle_since or time.time()
                    await asyncio.sleep(4)
                    continue
                break
            idle_since = None
            for job in jobs:
                done.add((job["id"], job["type"]))
                await handle(job)
    finally:
        await reset_telegram()
        await http.close()
    log.info("queue empty, %d job(s) handled", len(done))


if __name__ == "__main__":
    asyncio.run(serve() if "--service" in sys.argv else run_once())
