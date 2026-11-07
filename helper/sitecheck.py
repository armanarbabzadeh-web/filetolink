"""Which video sites work from this server? Probes yt-dlp's own sample URLs for popular sites.

Prints one line per site: OK (with number of qualities) or FAIL (short reason). Used by
.github/workflows/site-check.yml (manual run only).
"""
import importlib
import sys
import time
from concurrent.futures import ThreadPoolExecutor, TimeoutError as Timeout

import links

SITES = {
    # name: (extractor module, class name)
    "Aparat": ("aparat", "AparatIE"),
    "Instagram": ("instagram", "InstagramIE"),
    "TikTok": ("tiktok", "TikTokIE"),
    "X (Twitter)": ("twitter", "TwitterIE"),
    "Facebook": ("facebook", "FacebookIE"),
    "Vimeo": ("vimeo", "VimeoIE"),
    "Dailymotion": ("dailymotion", "DailymotionIE"),
    "Twitch clips": ("twitch", "TwitchClipsIE"),
    "Reddit": ("reddit", "RedditIE"),
    "SoundCloud": ("soundcloud", "SoundcloudIE"),
    "Telegram (public posts)": ("telegram", "TelegramEmbedIE"),
    "Pinterest": ("pinterest", "PinterestIE"),
    "TED": ("ted", "TedTalkIE"),
    "Internet Archive": ("archiveorg", "ArchiveOrgIE"),
    "Streamable": ("streamable", "StreamableIE"),
    "Imgur": ("imgur", "ImgurIE"),
    "9GAG": ("ninegag", "NineGagIE"),
    "Bilibili": ("bilibili", "BiliBiliIE"),
    "Rumble": ("rumble", "RumbleEmbedIE"),
    "VK": ("vk", "VKIE"),
    "OK.ru": ("odnoklassniki", "OdnoklassnikiIE"),
    "Coub": ("coub", "CoubIE"),
    "Kick": ("kick", "KickClipIE"),
    "YouTube": ("youtube", "YoutubeIE"),
}


def sample_urls(module, cls, n=3):
    try:
        ie = getattr(importlib.import_module(f"yt_dlp.extractor.{module}"), cls)
    except Exception:
        return []
    tests = getattr(ie, "_TESTS", []) or []
    urls = [t["url"] for t in tests if isinstance(t, dict) and t.get("url") and not t.get("only_matching")]
    return urls[:n]


def check(name, module, cls):
    urls = sample_urls(module, cls)
    if not urls:
        return name, "SKIP", "no sample url"
    last = ""
    for u in urls:
        with ThreadPoolExecutor(1) as ex:
            fut = ex.submit(links.probe, u)
            try:
                info = fut.result(timeout=60)
                if info["formats"]:
                    return name, "OK", f"{len(info['formats'])} quality option(s)"
            except Timeout:
                last = "timeout"
            except Exception as e:
                msg = str(e).lower()
                last = ("login/bot check" if any(k in msg for k in ("sign in", "login", "logged", "cookies", "bot", "rate-limit", "403", "forbidden"))
                        else "unavailable sample" if any(k in msg for k in ("unavailable", "removed", "not exist", "404", "private"))
                        else type(e).__name__)
    return name, "FAIL", last


if __name__ == "__main__":
    for name, (mod, cls) in SITES.items():
        n, status, note = check(name, mod, cls)
        print(f"{status:4} | {n} | {note}", flush=True)
        time.sleep(1)
    sys.exit(0)
