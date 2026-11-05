"""TeleTVShare large-file helper (runs on GitHub Actions).

Telegram's Bot API can't download files over 20 MB, so this logs in as the main bot over
MTProto (Pyrogram), streams each queued file from Telegram and uploads it straight to the
ArvanCloud bucket as an S3 multipart upload. The Worker is told about progress and the result.

Env: API_ID, API_HASH, BOT_TOKEN, WORKER_URL, HELPER_SECRET,
     ARVAN_ENDPOINT, ARVAN_REGION, ARVAN_BUCKET, ARVAN_ACCESS_KEY, ARVAN_SECRET_KEY,
     PROXY (optional, local testing only, e.g. socks5://127.0.0.1:10808)
"""

import asyncio
import logging
import os
import time
from urllib.parse import urlparse

import boto3
from aiohttp import ClientSession, ClientTimeout
from botocore.config import Config
from pyrogram import Client

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("helper")
logging.getLogger("pyrogram").setLevel(logging.WARNING)

WORKER_URL = os.environ["WORKER_URL"].rstrip("/")
AUTH = {"Authorization": f"Bearer {os.environ['HELPER_SECRET']}", "User-Agent": "TeleTVShareHelper/2.0"}
BUCKET = os.environ["ARVAN_BUCKET"]
PART = 16 * 1024 * 1024  # S3 multipart part size

s3 = boto3.client(
    "s3",
    endpoint_url=os.environ["ARVAN_ENDPOINT"],
    region_name=os.environ["ARVAN_REGION"],
    aws_access_key_id=os.environ["ARVAN_ACCESS_KEY"],
    aws_secret_access_key=os.environ["ARVAN_SECRET_KEY"],
    config=Config(s3={"addressing_style": "path"}, signature_version="s3v4", retries={"max_attempts": 5}),
)


def proxy_settings():
    raw = os.environ.get("PROXY")
    if not raw:
        return None
    u = urlparse(raw)
    return {"scheme": u.scheme, "hostname": u.hostname, "port": u.port}


tg = Client(
    "helper", api_id=int(os.environ["API_ID"]), api_hash=os.environ["API_HASH"],
    bot_token=os.environ["BOT_TOKEN"], in_memory=True, no_updates=True, proxy=proxy_settings(),
)
http: ClientSession | None = None


async def call(method, path, *, data=None, json=None, tries=4):
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
        except Exception as e:
            last = e
            log.warning("retry %d %s %s: %s", attempt + 1, method, path, e)
            await asyncio.sleep(2 * (attempt + 1))
    raise last


async def process(job):
    jid, key, size = job["id"], job["obj_key"], job["size"]
    log.info("job %s (%d bytes)", jid, size)  # no file names: run logs of a public repo are public
    loop = asyncio.get_running_loop()
    mp = await loop.run_in_executor(None, lambda: s3.create_multipart_upload(
        Bucket=BUCKET, Key=key, ACL="public-read",
        ContentType=job.get("mime") or "application/octet-stream",
        ContentDisposition=job.get("disposition") or "inline",
    ))
    upload_id = mp["UploadId"]
    parts, buf, done, last_report, started = [], bytearray(), 0, 0.0, time.time()

    async def flush(data):
        n = len(parts) + 1
        res = await loop.run_in_executor(None, lambda: s3.upload_part(
            Bucket=BUCKET, Key=key, UploadId=upload_id, PartNumber=n, Body=data))
        parts.append({"PartNumber": n, "ETag": res["ETag"]})

    completed = False
    try:
        async for piece in tg.stream_media(job["tg_file_id"]):
            buf += piece
            done += len(piece)
            if len(buf) >= PART:
                await flush(bytes(buf))
                buf.clear()
            if time.time() - last_report > 10:
                last_report = time.time()
                speed = done / max(1.0, time.time() - started)
                try:
                    await call("POST", f"/helper/progress/{jid}", json={"done": done, "total": size, "speed": int(speed)}, tries=1)
                except PermissionError:
                    raise RuntimeError("cancelled by user")
        if buf or not parts:
            await flush(bytes(buf))
        await loop.run_in_executor(None, lambda: s3.complete_multipart_upload(
            Bucket=BUCKET, Key=key, UploadId=upload_id, MultipartUpload={"Parts": parts}))
        completed = True
        for attempt in range(1, 6):  # Arvan can take a moment before the new object is visible
            try:
                res = await call("POST", f"/helper/finish/{jid}")
                break
            except PermissionError as e:
                if "409" not in str(e) or attempt == 5:
                    raise
                await asyncio.sleep(5 * attempt)
        log.info("job %s done in %.0fs: %s", jid, time.time() - started, res)
    except Exception as e:
        log.exception("job %s failed", jid)
        if not completed:
            try:
                await loop.run_in_executor(None, lambda: s3.abort_multipart_upload(Bucket=BUCKET, Key=key, UploadId=upload_id))
            except Exception:
                log.warning("abort failed (ignored)")
        try:
            await call("POST", f"/helper/fail/{jid}", data=f"{type(e).__name__}: {e}"[:400], tries=2)
        except Exception:
            log.warning("could not report failure (job may have been cancelled)")


async def run_once():
    global http
    http = ClientSession(timeout=ClientTimeout(total=None, sock_connect=30, sock_read=300))
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
                await process(job)
    finally:
        await tg.stop()
        await http.close()
    log.info("queue empty, %d job(s) handled", len(tried))


if __name__ == "__main__":
    asyncio.run(run_once())
