package com.filetolink.tv

import android.content.Context
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

data class FileItem(
    val id: String,
    val name: String,
    val mime: String,
    val size: Long,
    val kind: String,          // video | image | audio | file
    val duration: Int,
    val createdAt: Long,
    val url: String,
    val thumb: String?,
)

data class FileList(
    val userName: String,
    val plan: String,
    val used: Long,
    val quota: Long,
    val files: List<FileItem>,
)

data class PairInfo(val code: String, val secret: String, val link: String, val expiresIn: Int)

/** Thrown when the server no longer accepts this TV (unlinked or replaced by another TV). */
class UnauthorizedException : RuntimeException("unauthorized")

object Session {
    private const val PREFS = "session"
    fun token(ctx: Context): String? = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString("token", null)
    fun save(ctx: Context, token: String) =
        ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putString("token", token).apply()
    fun clear(ctx: Context) = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().remove("token").apply()
}

object Api {
    private fun open(path: String, method: String = "GET", token: String? = null): HttpURLConnection {
        val c = URL(BuildConfig.BASE_URL + path).openConnection() as HttpURLConnection
        c.requestMethod = method
        c.connectTimeout = 15_000
        c.readTimeout = 30_000
        c.setRequestProperty("User-Agent", "FileToLinkTV/2.0")
        if (token != null) c.setRequestProperty("Authorization", "Bearer $token")
        return c
    }

    private fun HttpURLConnection.json(): JSONObject {
        if (responseCode == 401) throw UnauthorizedException()
        if (responseCode !in 200..299) throw RuntimeException("HTTP $responseCode")
        return JSONObject(inputStream.bufferedReader(Charsets.UTF_8).readText())
    }

    suspend fun pairStart(deviceName: String): PairInfo = withContext(Dispatchers.IO) {
        val c = open("/api/tv/pair", "POST")
        try {
            c.doOutput = true
            c.setRequestProperty("Content-Type", "application/json")
            c.outputStream.use { it.write(JSONObject().put("name", deviceName).toString().toByteArray()) }
            val j = c.json()
            PairInfo(j.getString("code"), j.getString("secret"), j.getString("link"), j.optInt("expires_in", 600))
        } finally {
            c.disconnect()
        }
    }

    /** Returns the device token once the user confirmed the code in Telegram, "expired", or null while waiting. */
    suspend fun pairPoll(secret: String): String? = withContext(Dispatchers.IO) {
        val c = open("/api/tv/pair/$secret")
        try {
            val j = c.json()
            when (j.optString("status")) {
                "linked" -> j.getString("token")
                "expired" -> "expired"
                else -> null
            }
        } finally {
            c.disconnect()
        }
    }

    suspend fun list(token: String): FileList = withContext(Dispatchers.IO) {
        val c = open("/api/files?limit=500", token = token)
        try {
            val j = c.json()
            val arr = j.getJSONArray("files")
            val files = (0 until arr.length()).map { i ->
                val f = arr.getJSONObject(i)
                FileItem(
                    id = f.getString("id"),
                    name = f.getString("name"),
                    mime = f.optString("mime", ""),
                    size = f.optLong("size"),
                    kind = f.optString("kind", "file"),
                    duration = f.optInt("duration", 0),
                    createdAt = f.optLong("created_at"),
                    url = f.getString("url"),
                    thumb = if (f.isNull("thumb")) null else f.optString("thumb"),
                )
            }
            val u = j.optJSONObject("user")
            FileList(u?.optString("name") ?: "", u?.optString("plan") ?: "", j.optLong("used"), j.optLong("quota"), files)
        } finally {
            c.disconnect()
        }
    }

    suspend fun delete(token: String, id: String) = withContext(Dispatchers.IO) {
        val c = open("/api/files/$id", "DELETE", token)
        try { c.json() } finally { c.disconnect() }
    }

    suspend fun unlink(token: String) = withContext(Dispatchers.IO) {
        val c = open("/api/tv/device", "DELETE", token)
        try { runCatching { c.json() } } finally { c.disconnect() }
    }
}

object Fmt {
    fun size(n: Long): String = when {
        n < 1_000 -> "$n B"
        n < 1_000_000 -> String.format(Locale.US, "%.1f KB", n / 1e3)
        n < 1_000_000_000 -> String.format(Locale.US, "%.1f MB", n / 1e6)
        else -> String.format(Locale.US, "%.2f GB", n / 1e9)
    }

    fun date(ms: Long): String =
        SimpleDateFormat("yyyy/MM/dd HH:mm", Locale.US).format(Date(ms))

    fun duration(sec: Int): String {
        if (sec <= 0) return ""
        val h = sec / 3600
        val m = (sec % 3600) / 60
        val s = sec % 60
        return if (h > 0) String.format(Locale.US, "%d:%02d:%02d", h, m, s)
        else String.format(Locale.US, "%d:%02d", m, s)
    }
}
