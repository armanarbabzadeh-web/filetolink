"""Video-site downloads for TeleTVShare (yt-dlp): list qualities, then download the chosen one.

Logs never contain URLs or titles (the repository and its run logs are public).
"""

import glob
import mimetypes
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
    """Return {title, duration, thumbnail, formats:[{label, height, size, fid, audio}]}."""
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
    return {"title": info.get("title") or "video", "duration": duration, "thumbnail": info.get("thumbnail"), "formats": out}


def download(url, fmt, on_progress):
    """Download in the chosen format. Returns (path, info)."""
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
