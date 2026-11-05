package com.filetolink.tv

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

data class FileList(val used: Long, val quota: Long, val files: List<FileItem>)

object Api {
    private fun open(path: String, method: String = "GET"): HttpURLConnection {
        val c = URL(BuildConfig.BASE_URL + path).openConnection() as HttpURLConnection
        c.requestMethod = method
        c.connectTimeout = 15_000
        c.readTimeout = 30_000
        c.setRequestProperty("Authorization", "Bearer ${BuildConfig.API_KEY}")
        return c
    }

    suspend fun list(): FileList = withContext(Dispatchers.IO) {
        val c = open("/api/files?limit=500")
        try {
            if (c.responseCode != 200) throw RuntimeException("HTTP ${c.responseCode}")
            val j = JSONObject(c.inputStream.bufferedReader(Charsets.UTF_8).readText())
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
            FileList(j.optLong("used"), j.optLong("quota"), files)
        } finally {
            c.disconnect()
        }
    }

    suspend fun delete(id: String) = withContext(Dispatchers.IO) {
        val c = open("/api/files/$id", "DELETE")
        try {
            if (c.responseCode != 200) throw RuntimeException("HTTP ${c.responseCode}")
        } finally {
            c.disconnect()
        }
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
