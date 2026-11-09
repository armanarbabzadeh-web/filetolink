package com.teletvshare.tv

import android.content.Context
import android.net.Uri
import androidx.media3.common.C
import androidx.media3.common.MediaItem
import androidx.media3.common.MimeTypes
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.withTimeoutOrNull
import java.io.File
import java.net.HttpURLConnection
import java.net.URL
import java.nio.ByteBuffer
import java.nio.charset.CharacterCodingException
import java.nio.charset.Charset
import java.nio.charset.CodingErrorAction

/**
 * Subtitle files the user sent to the bot (.srt .vtt .ass .ssa). They are not shown in the file grid;
 * when a video plays they are added to it as subtitle tracks, so the player's own subtitle (CC) button
 * can turn them on/off or switch language, next to subtitles embedded in the video file.
 * A file whose name starts with the video's name (movie.srt, movie.fa.srt) is turned on by default.
 */
object Subs {
    private val EXT = setOf("srt", "vtt", "ass", "ssa")
    private val LANG = mapOf(
        "fa" to "فارسی", "per" to "فارسی", "fas" to "فارسی", "farsi" to "فارسی", "persian" to "فارسی",
        "en" to "English", "eng" to "English", "english" to "English",
        "ar" to "العربية", "ara" to "العربية", "arabic" to "العربية", "tr" to "Türkçe", "tur" to "Türkçe",
    )

    data class Track(val file: FileItem, val matched: Boolean, val label: String, val lang: String?)

    fun ext(name: String) = name.substringAfterLast('.', "").lowercase()
    fun isSub(f: FileItem) = ext(f.name) in EXT
    private fun base(name: String) = name.substringBeforeLast('.').lowercase().trim()

    /** Subtitle tracks for this video: name matches first (and the first of them on by default). */
    fun forVideo(video: FileItem, all: List<FileItem>): List<Track> {
        val vb = base(video.name)
        return all.filter(::isSub).map { s ->
            val sb = base(s.name)
            val matched = vb.isNotEmpty() && sb.startsWith(vb)
            val tag = if (matched) sb.removePrefix(vb).trim('.', '-', '_', ' ', '[', ']', '(', ')') else ""
            val lang = LANG.keys.firstOrNull { tag == it || tag.endsWith(".$it") || tag.endsWith("_$it") }
                ?: LANG.keys.firstOrNull { sb.endsWith(".$it") || sb.endsWith("_$it") || sb.endsWith("-$it") }
            val label = when {
                lang != null && matched -> LANG.getValue(lang)
                matched -> "زیرنویس"
                else -> Fmt.title(s.name)
            }
            Track(s, matched, label, lang?.let { if (LANG[it] == "فارسی") "fa" else if (LANG[it] == "English") "en" else it })
        }.sortedWith(compareByDescending<Track> { it.matched }.thenByDescending { it.lang == "fa" }).take(15)
    }

    /** Download the files (in parallel, a few seconds at most), fix their text encoding, build the tracks. */
    suspend fun configurations(ctx: Context, tracks: List<Track>): List<MediaItem.SubtitleConfiguration> = coroutineScope {
        var defaultSet = false
        val local = tracks.map { t ->
            async(Dispatchers.IO) { withTimeoutOrNull(8_000) { runCatching { local(ctx, t.file) }.getOrNull() } }
        }.awaitAll()
        tracks.mapIndexedNotNull { i, t ->
            val f = local[i] ?: return@mapIndexedNotNull null
            val b = MediaItem.SubtitleConfiguration.Builder(Uri.fromFile(f))
                .setMimeType(mime(t.file.name))
                .setLabel(t.label)
                .setId("sub-" + t.file.id)
            t.lang?.let { b.setLanguage(it) }
            if (t.matched && !defaultSet) {
                defaultSet = true
                b.setSelectionFlags(C.SELECTION_FLAG_DEFAULT)
            }
            b.build()
        }
    }

    private fun mime(name: String) = when (ext(name)) {
        "vtt" -> MimeTypes.TEXT_VTT
        "ass", "ssa" -> MimeTypes.TEXT_SSA
        else -> MimeTypes.APPLICATION_SUBRIP
    }

    /** Cached UTF-8 copy. Persian subtitles are often Windows-1256 (Arabic) encoded; those are converted. */
    private fun local(ctx: Context, f: FileItem): File {
        val dir = File(ctx.cacheDir, "subs").apply { mkdirs() }
        val out = File(dir, f.id + "." + ext(f.name))
        if (out.exists() && out.length() > 0) return out
        val c = URL(f.url).openConnection() as HttpURLConnection
        c.connectTimeout = 10_000
        c.readTimeout = 15_000
        c.setRequestProperty("User-Agent", "TeleTVShare-TV/${BuildConfig.VERSION_NAME}")
        val bytes = try {
            check(c.responseCode == 200) { "HTTP ${c.responseCode}" }
            c.inputStream.use { it.readBytes() }
        } finally {
            c.disconnect()
        }
        check(bytes.size < 5_000_000) { "subtitle too big" }
        out.writeText(decode(bytes), Charsets.UTF_8)
        return out
    }

    fun decode(b: ByteArray): String {
        if (b.size >= 2 && b[0] == 0xFF.toByte() && b[1] == 0xFE.toByte()) return String(b, 2, b.size - 2, Charsets.UTF_16LE)
        if (b.size >= 2 && b[0] == 0xFE.toByte() && b[1] == 0xFF.toByte()) return String(b, 2, b.size - 2, Charsets.UTF_16BE)
        val utf8 = Charsets.UTF_8.newDecoder().onMalformedInput(CodingErrorAction.REPORT).onUnmappableCharacter(CodingErrorAction.REPORT)
        return try {
            utf8.decode(ByteBuffer.wrap(b)).toString().removePrefix("﻿")
        } catch (e: CharacterCodingException) {
            String(b, Charset.forName("windows-1256"))
        }
    }
}

/** Plays a video in VLC (if installed) or any other player the TV has. */
object External {
    private const val VLC = "org.videolan.vlc"

    fun open(a: android.app.Activity, f: FileItem, subs: List<Subs.Track>): Boolean {
        val i = android.content.Intent(android.content.Intent.ACTION_VIEW)
            .setDataAndType(Uri.parse(f.url), if (f.kind == "audio") "audio/*" else "video/*")
            .putExtra("title", Fmt.title(f.name))
        subs.firstOrNull { it.matched }?.let { i.putExtra("subtitles_location", it.file.url) }
        val vlc = runCatching { a.packageManager.getPackageInfo(VLC, 0) }.isSuccess
        return try {
            if (vlc) a.startActivity(android.content.Intent(i).setPackage(VLC))
            else a.startActivity(android.content.Intent.createChooser(i, a.getString(R.string.open_with)))
            true
        } catch (e: android.content.ActivityNotFoundException) {
            false
        }
    }
}
