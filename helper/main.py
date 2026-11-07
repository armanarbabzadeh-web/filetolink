"""TeleTVShare link helper (runs on GitHub Actions).

Handles downloads from video-site links only: lists the available qualities (yt-dlp), then
downloads the one the user picked and uploads it to the ArvanCloud bucket.
It does not log in to Telegram and uses no Telegram api_id/api_hash.

Env: WORKER_URL, HELPER_SECRET, ARVAN_ENDPOINT, ARVAN_REGION, ARVAN_BUCKET,
     ARVAN_ACCESS_KEY, ARVAN_SECRET_KEY, YT_COOKIES_FILE (optional)
Logs never contain URLs, titles or file names (the repository and its run logs are public).
"""

import asyncio
import logging
import os
import time

import boto3
from aiohttp import ClientSession, ClientTimeout
from botocore.config import Config

import links

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("helper")

WORKER_URL = os.environ["WORKER_URL"].rstrip("/")
AUTH = {"Authorization": f"Bearer {os.environ['HELPER_SECRET']}", "User-Agent": "TeleTVShareHelper/3.0"}
BUCKET = os.environ["ARVAN_BUCKET"]

s3 = boto3.client(
    "s3",
    endpoint_url=os.environ["ARVAN_ENDPOINT"],
    region_name=os.environ["ARVAN_REGION"],
    aws_access_key_id=os.environ["ARVAN_ACCESS_KEY"],
    aws_secret_access_key=os.environ["ARVAN_SECRET_KEY"],
    config=Config(s3={"addressing_style": "path"}, signature_version="s3v4", retries={"max_attempts": 5}),
)
http: ClientSession | None = None


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


async def download_link(job):
    jid, key = job["id"], job["obj_key"]
    log.info("link %s (%s)", jid, (job.get("fmt") or {}).get("label"))
    loop = asyncio.get_running_loop()
    started = time.time()

    def progress(done, total, speed):
        asyncio.run_coroutine_threadsafe(
            call("POST", f"/helper/progress/{jid}", json={"done": int(done), "total": int(total or job["size"] or 0), "speed": int(speed)}, tries=1), loop)

    try:
        path, info = await loop.run_in_executor(None, links.download, job["url"], job["fmt"], progress)
        size = os.path.getsize(path)
        await loop.run_in_executor(None, lambda: s3.upload_file(path, BUCKET, key, ExtraArgs={
            "ACL": "public-read", "ContentType": links.content_type(path), "ContentDisposition": job.get("disposition") or "inline"}))
        extra = {"duration": info.get("duration"), "width": info.get("width"), "height": info.get("height")}
        try:
            thumb = await loop.run_in_executor(None, links.fetch_thumbnail, info.get("thumbnail"))
            if thumb:
                tkey = f"t/{jid}.jpg"
                await loop.run_in_executor(None, lambda: s3.put_object(Bucket=BUCKET, Key=tkey, Body=thumb, ACL="public-read",
                                                                       ContentType="image/jpeg", CacheControl="public, max-age=604800"))
                extra["thumb_key"] = tkey
        except Exception:
            log.warning("thumbnail skipped")
        os.remove(path)
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


async def run_once():
    global http
    http = ClientSession(timeout=ClientTimeout(total=None, sock_connect=30, sock_read=300))
    done = set()
    idle_since = None
    try:
        while True:
            data = await call("GET", "/helper/jobs")
            jobs = [j for j in data.get("jobs", []) if (j["id"], j["type"]) not in done and j["type"] in ("probe", "link")]
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
                await (probe_link(job) if job["type"] == "probe" else download_link(job))
    finally:
        await http.close()
    log.info("queue empty, %d job(s) handled", len(done))


if __name__ == "__main__":
    asyncio.run(run_once())
