"""Video-site downloads for TeleTVShare (yt-dlp): list qualities, then download the chosen one.

Logs never contain URLs or titles (the repository and its run logs are public).
"""

import glob
import html
import mimetypes
import re
import urllib.parse
import os
import tempfile
import time
import urllib.request

import imageio_ffmpeg
import yt_dlp

FFMPEG = imageio_ffmpeg.get_ffmpeg_exe()


class _Silent:
    """yt-dlp would print URLs and titles; the run logs are public, so drop everything."""
    def debug(self, msg): pass
    def info(self, msg): pass
    def warning(self, msg): pass
    def error(self, msg): pass


COOKIES = os.environ.get("YT_COOKIES_FILE")  # optional cookies.txt (needed for YouTube from cloud servers)
BASE = {
    "quiet": True, "no_warnings": True, "noplaylist": True, "socket_timeout": 30, "logger": _Silent(),
    **({"cookiefile": COOKIES} if COOKIES and os.path.exists(COOKIES) else {}),
    "ffmpeg_location": FFMPEG, "retries": 5, "fragment_retries": 5, "concurrent_fragment_downloads": 4,
}
HEIGHTS = [2160, 1440, 1080, 720, 480, 360, 240]


def _size(f, duration):
    s = f.get("filesize") or f.get("filesize_approx")
    if not s and f.get("tbr") and duration:
        s = f["tbr"] * 1000 / 8 * duration
    return int(s or 0)


def probe(url):
    """Return {title, duration, thumbnail, formats:[...]}: yt-dlp first, then the links in the page itself."""
    try:
        res = yt_probe(url)
        # a site yt-dlp really knows: use it. Its "generic" mode can pick a preview clip of the page,
        # so for those the page's own player/download links are tried first.
        if res["formats"] and res["formats"][0]["fid"] != "best" and res.get("extractor") != "Generic":
            return res
    except Exception as e:
        res, err = None, e
    else:
        err = None
    try:
        page = page_probe(url)
    except Exception:
        page = None
    if page:
        return page
    if res:
        return res
    raise err


def yt_probe(url):
    with yt_dlp.YoutubeDL({**BASE, "skip_download": True}) as y:
        info = y.extract_info(url, download=False)
    if info.get("_type") == "playlist" and info.get("entries"):
        info = next(e for e in info["entries"] if e)
    duration = info.get("duration") or 0
    fmts = info.get("formats") or [info]

    audios = [f for f in fmts if f.get("vcodec") == "none" and f.get("acodec") not in (None, "none")]
    # prefer m4a audio (plays everywhere), then the highest bitrate
    audio = max(audios, key=lambda f: (f.get("ext") == "m4a", f.get("abr") or f.get("tbr") or 0), default=None)

    best = {}
    for f in fmts:
        h = f.get("height")
        if not h or f.get("vcodec") in (None, "none"):
            continue
        h = min(HEIGHTS, key=lambda x: abs(x - h))
        muxed = f.get("acodec") not in (None, "none")
        score = (f.get("ext") == "mp4", (f.get("vcodec") or "").startswith(("avc", "h264")), muxed or audio is not None, f.get("tbr") or 0)
        if h not in best or score > best[h][0]:
            best[h] = (score, f)

    out = []
    for h in sorted(best, reverse=True):
        f = best[h][1]
        muxed = f.get("acodec") not in (None, "none")
        if muxed or not audio:
            fid, size = f["format_id"], _size(f, duration)
        else:
            fid, size = f"{f['format_id']}+{audio['format_id']}", _size(f, duration) + _size(audio, duration)
        out.append({"label": f"{h}p", "height": h, "size": size, "fid": fid, "audio": False})
    out = out[:6]
    if audio:
        out.append({"label": "فقط صدا", "height": 0, "size": _size(audio, duration), "fid": audio["format_id"], "audio": True})
    if not out and fmts:
        out.append({"label": "بهترین کیفیت", "height": 0, "size": _size(fmts[-1], duration), "fid": "best", "audio": False})
    return {"title": info.get("title") or "video", "duration": duration, "thumbnail": info.get("thumbnail"), "formats": out,
            "extractor": info.get("extractor_key") or ""}


def download(url, fmt, on_progress):
    """Download in the chosen format. Returns (path, info)."""
    if fmt.get("direct"):
        return direct_download(fmt, on_progress)
    tmp = tempfile.mkdtemp(prefix="ttvs-")
    state = {"last": 0.0}

    def hook(d):
        if d.get("status") == "downloading" and time.time() - state["last"] > 10:
            state["last"] = time.time()
            on_progress(d.get("downloaded_bytes") or 0, d.get("total_bytes") or d.get("total_bytes_estimate") or 0, d.get("speed") or 0)

    opts = {**BASE, "format": fmt["fid"], "outtmpl": os.path.join(tmp, "media.%(ext)s"), "progress_hooks": [hook]}
    if not fmt.get("audio"):
        opts["merge_output_format"] = "mp4"
    with yt_dlp.YoutubeDL(opts) as y:
        info = y.extract_info(url, download=True)
    files = [p for p in glob.glob(os.path.join(tmp, "media.*")) if not p.endswith((".part", ".ytdl"))]
    if not files:
        raise RuntimeError("download produced no file")
    return max(files, key=os.path.getsize), info


def content_type(path):
    return mimetypes.guess_type(path)[0] or "application/octet-stream"


def fetch_thumbnail(url):
    if not url:
        return None
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req, timeout=20) as r:
        data = r.read(2_000_000)
    return data if len(data) > 500 else None


# ---- fallback for sites yt-dlp doesn't know: read the page like a browser and use the links the site
# itself offers (<source> tags of its player, "download" buttons). Only plain links in the page are used;
# scrambled player links and "are you a robot" checks are left alone.
UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36"


def _opener():
    import http.cookiejar
    jar = http.cookiejar.CookieJar()
    return urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar)), jar


def _cookie_header(jar):
    return "; ".join(f"{c.name}={c.value}" for c in jar)


def _attr(tag, name):
    m = re.search(name + r"""\s*=\s*(["'])(.*?)\1""", tag, re.I | re.S)
    return html.unescape(m.group(2)).strip() if m else ""


def _check(op, url, referer):
    """(size, ok) for a candidate link: must answer with video/audio content."""
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Referer": referer, "Range": "bytes=0-0"})
    with op.open(req, timeout=25) as r:
        ctype = (r.headers.get("Content-Type") or "").lower()
        rng = r.headers.get("Content-Range") or ""
        size = int(rng.rsplit("/", 1)[-1]) if "/" in rng and rng.rsplit("/", 1)[-1].isdigit() else int(r.headers.get("Content-Length") or 0)
        r.read(1)
    return size, ctype.startswith(("video/", "audio/")) or ctype == "application/octet-stream"


def page_probe(url):
    op, jar = _opener()
    with op.open(urllib.request.Request(url, headers={"User-Agent": UA}), timeout=30) as r:
        page = r.read(3_000_000).decode("utf-8", "replace")
    found = []  # (label, link)
    for tag in re.findall(r"<source\b[^>]*>", page, re.I):
        src, typ = _attr(tag, "src"), _attr(tag, "type").lower()
        if src and (typ.startswith("video/") or re.search(r"\.(mp4|webm|m4v)\b", src, re.I)):
            found.append((_attr(tag, "label") or _attr(tag, "res") or _attr(tag, "size"), src))
    for tag, text in re.findall(r"(<a\b[^>]*>)([^<]{0,80})", page, re.I):
        href = _attr(tag, "href")
        if href and ("download" in tag.lower()) and re.search(r"\.(mp4|webm|m4v|mkv)\b", href, re.I):
            found.append((html.unescape(text).strip(), href))
    seen, formats = set(), []
    for label, link in found:
        link = urllib.parse.urljoin(url, link)
        if link in seen or re.search(r"/(preview|thumbs?|screenshots?)/", link, re.I):
            continue
        seen.add(link)
        try:
            size, ok = _check(op, link, url)
        except Exception:
            continue
        if ok and size and any(f["size"] == size for f in formats):
            continue  # the same file offered twice (player + download button)
        if ok:
            formats.append({"label": (label or "MP4")[:40], "height": 0, "size": size, "fid": "direct", "audio": False,
                            "direct": link, "referer": url, "cookie": _cookie_header(jar)})
        if len(formats) >= 6:
            break
    if not formats:
        return None
    formats.sort(key=lambda f: f["size"], reverse=True)
    def meta(prop):
        m = re.search(r"""<meta[^>]+(?:property|name)=["']%s["'][^>]*>""" % re.escape(prop), page, re.I)
        return _attr(m.group(0), "content") if m else ""
    for f in formats:
        f["thumb"] = urllib.parse.urljoin(url, meta("og:image")) if meta("og:image") else None
    title = meta("og:title") or html.unescape((re.search(r"<title[^>]*>(.*?)</title>", page, re.I | re.S) or [None, "video"])[1]).strip()
    return {"title": title or "video", "duration": 0, "thumbnail": formats[0]["thumb"], "formats": formats}


def direct_download(fmt, on_progress):
    tmp = tempfile.mkdtemp(prefix="ttvs-")
    path = os.path.join(tmp, "media.mp4")
    headers = {"User-Agent": UA, "Referer": fmt.get("referer") or ""}
    if fmt.get("cookie"):
        headers["Cookie"] = fmt["cookie"]
    req = urllib.request.Request(fmt["direct"], headers=headers)
    done, last, started = 0, 0.0, time.time()
    with urllib.request.urlopen(req, timeout=60) as r, open(path, "wb") as out:
        total = int(r.headers.get("Content-Length") or 0)
        while True:
            chunk = r.read(1024 * 1024)
            if not chunk:
                break
            out.write(chunk)
            done += len(chunk)
            if time.time() - last > 10:
                last = time.time()
                on_progress(done, total, done / max(1.0, time.time() - started))
    if done < 1000:
        raise RuntimeError("download produced no file")
    return path, {"thumbnail": fmt.get("thumb")}
