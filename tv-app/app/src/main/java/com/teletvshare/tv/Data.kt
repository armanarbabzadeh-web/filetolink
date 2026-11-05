package com.teletvshare.tv

import android.content.Context
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import java.security.SecureRandom
import java.text.SimpleDateFormat
import java.util.Calendar
import java.util.Date
import java.util.Locale
import java.util.TimeZone

/**
 * The TV talks only to ArvanCloud (reachable in Iran without VPN):
 *  - pairing:  waits for  <ARVAN>/p/<CODE>.json  which the bot writes after the user sends the code
 *  - content:  reads the manifest  <ARVAN>/m/<token>.json  (file list, plan, viewing limit)
 *  - usage:    PUTs {"month","bytes"} to the presigned report_url from the manifest
 */

data class FileItem(
    val id: String, val name: String, val size: Long, val kind: String,
    val duration: Int, val createdAt: Long, val url: String, val thumb: String?,
)

data class Manifest(
    val userName: String, val plan: String, val expiresAt: Long?,
    val used: Long, val quota: Long?, val blocked: Boolean, val reportUrl: String?,
    val files: List<FileItem>,
)

class UnlinkedException : RuntimeException("unlinked")

object Prefs {
    private fun p(ctx: Context) = ctx.getSharedPreferences("ttvs", Context.MODE_PRIVATE)
    fun manifest(ctx: Context): String? = p(ctx).getString("manifest", null)
    fun setManifest(ctx: Context, url: String?) = p(ctx).edit().putString("manifest", url).apply()
    fun reportUrl(ctx: Context): String? = p(ctx).getString("report", null)
    fun setReportUrl(ctx: Context, url: String?) = p(ctx).edit().putString("report", url).apply()
}

object Net {
    fun get(url: String): Pair<Int, String> {
        // Unique query so no CDN edge or proxy can serve a cached (e.g. "not found yet") answer.
        val fresh = url + (if ('?' in url) "&" else "?") + "t=" + System.currentTimeMillis()
        val c = URL(fresh).openConnection() as HttpURLConnection
        c.connectTimeout = 15_000
        c.readTimeout = 30_000
        c.useCaches = false
        c.setRequestProperty("Cache-Control", "no-cache")
        c.setRequestProperty("User-Agent", "TeleTVShare-TV/${BuildConfig.VERSION_NAME}")
        return try {
            val code = c.responseCode
            code to (if (code in 200..299) c.inputStream.bufferedReader(Charsets.UTF_8).readText() else "")
        } finally {
            c.disconnect()
        }
    }

    fun putJson(url: String, json: String): Int {
        val c = URL(url).openConnection() as HttpURLConnection
        c.requestMethod = "PUT"
        c.doOutput = true
        c.connectTimeout = 15_000
        c.readTimeout = 30_000
        c.setRequestProperty("Content-Type", "application/json")
        return try {
            c.outputStream.use { it.write(json.toByteArray()) }
            c.responseCode
        } finally {
            c.disconnect()
        }
    }
}

object Api {
    private const val CODE_ABC = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"

    fun newCode(): String {
        val r = SecureRandom()
        return (1..8).map { CODE_ABC[r.nextInt(CODE_ABC.length)] }.joinToString("")
    }

    fun isCode(s: String) = s.length == 8 && s.all { it in CODE_ABC }

    fun pairLink(code: String) = "https://t.me/${BuildConfig.BOT_USERNAME}?start=tv_$code"

    /** Returns the manifest URL once the user has confirmed the code in Telegram, else null. */
    suspend fun pollPair(code: String): String? = withContext(Dispatchers.IO) {
        val (status, body) = Net.get("${BuildConfig.ARVAN_URL}/p/$code.json")
        if (status == 200) JSONObject(body).optString("manifest").takeIf { it.startsWith("http") } else null
    }

    suspend fun manifest(url: String): Manifest = withContext(Dispatchers.IO) {
        val (status, body) = Net.get(url)
        android.util.Log.i("TeleTVShare", "manifest HTTP $status")
        if (status == 403 || status == 404) throw UnlinkedException()
        if (status != 200) throw RuntimeException("HTTP $status")
        val j = JSONObject(body)
        val u = j.optJSONObject("user")
        val w = j.optJSONObject("watch")
        val arr = j.getJSONArray("files")
        Manifest(
            userName = u?.optString("name") ?: "",
            plan = u?.optString("plan") ?: "",
            expiresAt = u?.takeIf { !it.isNull("expires_at") }?.optLong("expires_at"),
            used = j.optLong("used"),
            quota = if (j.isNull("quota")) null else j.optLong("quota"),
            blocked = w?.optBoolean("blocked") ?: false,
            reportUrl = j.optString("report_url").takeIf { it.startsWith("http") },
            files = (0 until arr.length()).map { i ->
                val f = arr.getJSONObject(i)
                FileItem(
                    id = f.getString("id"), name = f.getString("name"), size = f.optLong("size"),
                    kind = f.optString("kind", "file"), duration = f.optInt("duration", 0),
                    createdAt = f.optLong("created_at"), url = f.getString("url"),
                    thumb = if (f.isNull("thumb")) null else f.optString("thumb"),
                )
            },
        )
    }
}

/** Counts bytes streamed by the player this month and reports them through the presigned URL. */
object Usage {
    private fun month(): String {
        val f = SimpleDateFormat("yyyy-MM", Locale.US)
        f.timeZone = TimeZone.getTimeZone("Asia/Tehran")
        return f.format(Date())
    }

    @Synchronized
    fun add(ctx: Context, bytes: Long) {
        val p = ctx.getSharedPreferences("usage", Context.MODE_PRIVATE)
        val m = month()
        val cur = if (p.getString("month", "") == m) p.getLong("bytes", 0) else 0
        p.edit().putString("month", m).putLong("bytes", cur + bytes).apply()
    }

    suspend fun report(ctx: Context) = withContext(Dispatchers.IO) {
        val url = Prefs.reportUrl(ctx) ?: return@withContext
        val p = ctx.getSharedPreferences("usage", Context.MODE_PRIVATE)
        val m = month()
        val bytes = if (p.getString("month", "") == m) p.getLong("bytes", 0) else 0
        if (bytes == 0L || p.getLong("reported", -1) == bytes) return@withContext
        runCatching {
            if (Net.putJson(url, JSONObject().put("month", m).put("bytes", bytes).toString()) in 200..299) {
                p.edit().putLong("reported", bytes).apply()
            }
        }
    }
}

object Fmt {
    fun size(n: Long): String = when {
        n < 1_000 -> "$n B"
        n < 1_000_000 -> String.format(Locale.US, "%.0f KB", n / 1e3)
        n < 1_000_000_000 -> String.format(Locale.US, "%.1f MB", n / 1e6)
        else -> String.format(Locale.US, "%.2f GB", n / 1e9)
    }

    fun duration(sec: Int): String {
        if (sec <= 0) return ""
        val h = sec / 3600
        val m = (sec % 3600) / 60
        val s = sec % 60
        return if (h > 0) String.format(Locale.US, "%d:%02d:%02d", h, m, s) else String.format(Locale.US, "%d:%02d", m, s)
    }

    /** Persian (Jalali) date like ۱۴۰۵/۰۸/۱۴. */
    fun date(ms: Long): String {
        val c = Calendar.getInstance(TimeZone.getTimeZone("Asia/Tehran")).apply { timeInMillis = ms }
        val (y, m, d) = toJalali(c.get(Calendar.YEAR), c.get(Calendar.MONTH) + 1, c.get(Calendar.DAY_OF_MONTH))
        return fa(String.format(Locale.US, "%04d/%02d/%02d", y, m, d))
    }

    fun fa(s: String) = s.map { if (it in '0'..'9') '۰' + (it - '0') else it }.joinToString("")

    private fun toJalali(gy: Int, gm: Int, gd: Int): Triple<Int, Int, Int> {
        val gdm = intArrayOf(0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334)
        val gy2 = if (gm > 2) gy + 1 else gy
        var days = 355666 + 365 * gy + (gy2 + 3) / 4 - (gy2 + 99) / 100 + (gy2 + 399) / 400 + gd + gdm[gm - 1]
        var jy = -1595 + 33 * (days / 12053)
        days %= 12053
        jy += 4 * (days / 1461)
        days %= 1461
        if (days > 365) {
            jy += (days - 1) / 365
            days = (days - 1) % 365
        }
        val jm = if (days < 186) 1 + days / 31 else 7 + (days - 186) / 30
        val jd = 1 + if (days < 186) days % 31 else (days - 186) % 30
        return Triple(jy, jm, jd)
    }
}
