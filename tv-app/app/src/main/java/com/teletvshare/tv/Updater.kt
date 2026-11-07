package com.teletvshare.tv

import android.content.ActivityNotFoundException
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.provider.Settings
import androidx.appcompat.app.AlertDialog
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.FileProvider
import androidx.lifecycle.lifecycleScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.json.JSONObject
import java.io.File
import java.net.HttpURLConnection
import java.net.URL

/**
 * In-app updates. app/version.json on Arvan says which build is current:
 *   {"code": 8, "name": "3.5", "url": ".../app/TeleTVShare.apk", "size": 6500000,
 *    "min_code": 7, "notes": "..."}
 * code > ours  -> update offered ("later" allowed)
 * ours < min_code -> update required (the app can't be used until it is installed)
 * The APK is downloaded inside the app and handed to Android's installer; Android only accepts it
 * when it is signed with the same key as the installed app.
 */
object Updater {
    private const val VERSION_URL = "${BuildConfig.ARVAN_URL}/app/version.json"
    private var lastCheck = 0L
    private var skipped = 0   // version code the user chose "later" for, in this run of the app
    private var showing = false

    data class Info(val code: Int, val name: String, val url: String, val size: Long, val minCode: Int, val notes: String)

    fun checkForUpdate(a: AppCompatActivity) {
        if (showing) return
        val now = System.currentTimeMillis()
        if (now - lastCheck < 30 * 60_000L && lastCheck != 0L) return
        lastCheck = now
        a.lifecycleScope.launch {
            val info = runCatching { fetch() }.onFailure { android.util.Log.w("TeleTVShare", "update check failed", it) }.getOrNull()
                ?: return@launch
            val mine = BuildConfig.VERSION_CODE
            if (info.code <= mine || a.isFinishing) return@launch
            val required = mine < info.minCode
            if (!required && skipped == info.code) return@launch
            offer(a, info, required)
        }
    }

    private suspend fun fetch(): Info = withContext(Dispatchers.IO) {
        val (status, body) = Net.get(VERSION_URL)
        check(status == 200) { "HTTP $status" }
        val j = JSONObject(body)
        Info(j.getInt("code"), j.optString("name"), j.getString("url"), j.optLong("size"), j.optInt("min_code", 0), j.optString("notes"))
    }

    private fun offer(a: AppCompatActivity, info: Info, required: Boolean) {
        showing = true
        val msg = buildString {
            append(a.getString(if (required) R.string.update_required_msg else R.string.update_msg, info.name))
            if (info.notes.isNotBlank()) append("\n\n").append(info.notes)
            if (info.size > 0) append("\n\n").append(a.getString(R.string.update_size, Fmt.faSize(info.size)))
        }
        val b = AlertDialog.Builder(a, R.style.AppDialog)
            .setTitle(if (required) R.string.update_required_title else R.string.update_title)
            .setMessage(msg)
            .setCancelable(false)
            .setPositiveButton(R.string.update_now) { _, _ -> showing = false; download(a, info, required) }
        if (required) {
            b.setNegativeButton(R.string.update_exit) { _, _ -> showing = false; a.finishAffinity() }
        } else {
            b.setNegativeButton(R.string.update_later) { _, _ -> showing = false; skipped = info.code }
        }
        b.show()
    }

    private fun download(a: AppCompatActivity, info: Info, required: Boolean) {
        val progress = AlertDialog.Builder(a, R.style.AppDialog)
            .setTitle(R.string.update_downloading)
            .setMessage("۰٪")
            .setCancelable(false)
            .show()
        showing = true
        a.lifecycleScope.launch {
            val file = runCatching {
                withContext(Dispatchers.IO) {
                    // API 24+: private cache + FileProvider. Older Android: the installer reads a file:// path.
                    val dir = if (Build.VERSION.SDK_INT >= 24) File(a.cacheDir, "update") else (a.externalCacheDir ?: a.cacheDir)
                    dir.mkdirs()
                    val out = File(dir, "TeleTVShare.apk")
                    val c = URL(info.url + "?t=" + System.currentTimeMillis()).openConnection() as HttpURLConnection
                    c.connectTimeout = 15_000
                    c.readTimeout = 60_000
                    c.setRequestProperty("User-Agent", "TeleTVShare-TV/${BuildConfig.VERSION_NAME}")
                    try {
                        check(c.responseCode == 200) { "HTTP ${c.responseCode}" }
                        val total = c.contentLengthLong.takeIf { it > 0 } ?: info.size
                        var done = 0L
                        var shown = -1
                        c.inputStream.use { inp ->
                            out.outputStream().use { o ->
                                val buf = ByteArray(64 * 1024)
                                while (true) {
                                    val n = inp.read(buf)
                                    if (n < 0) break
                                    o.write(buf, 0, n)
                                    done += n
                                    val pct = if (total > 0) (done * 100 / total).toInt() else 0
                                    if (pct != shown) {
                                        shown = pct
                                        withContext(Dispatchers.Main) { progress.setMessage(Fmt.fa(pct.toString()) + "٪") }
                                    }
                                }
                            }
                        }
                        if (Build.VERSION.SDK_INT < 24) out.setReadable(true, false)
                    } finally {
                        c.disconnect()
                    }
                    out
                }
            }.getOrNull()
            progress.dismiss()
            showing = false
            if (file == null) {
                failed(a, info, required)
                return@launch
            }
            install(a, file, info, required)
        }
    }

    private fun install(a: AppCompatActivity, file: File, info: Info, required: Boolean) {
        // Android 8+: the user must allow this app to install updates once.
        if (Build.VERSION.SDK_INT >= 26 && !a.packageManager.canRequestPackageInstalls()) {
            showing = true
            AlertDialog.Builder(a, R.style.AppDialog)
                .setTitle(R.string.update_title)
                .setMessage(R.string.update_allow)
                .setCancelable(false)
                .setPositiveButton(R.string.update_open_settings) { _, _ ->
                    showing = false
                    runCatching {
                        a.startActivity(Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:" + a.packageName)))
                    }
                    lastCheck = 0L // ask again when the user comes back
                }
                .setNegativeButton(if (required) R.string.update_exit else R.string.update_later) { _, _ ->
                    showing = false
                    if (required) a.finishAffinity() else skipped = info.code
                }
                .show()
            return
        }
        val uri = if (Build.VERSION.SDK_INT >= 24) FileProvider.getUriForFile(a, a.packageName + ".files", file) else Uri.fromFile(file)
        val i = Intent(Intent.ACTION_VIEW)
            .setDataAndType(uri, "application/vnd.android.package-archive")
            .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK)
        try {
            a.startActivity(i)
            lastCheck = 0L // if the install is cancelled, offer it again next time
        } catch (e: ActivityNotFoundException) {
            failed(a, info, required)
        }
    }

    private fun failed(a: AppCompatActivity, info: Info, required: Boolean) {
        showing = true
        AlertDialog.Builder(a, R.style.AppDialog)
            .setTitle(R.string.update_title)
            .setMessage(R.string.update_failed)
            .setCancelable(false)
            .setPositiveButton(R.string.update_retry) { _, _ -> showing = false; download(a, info, required) }
            .setNegativeButton(if (required) R.string.update_exit else R.string.update_later) { _, _ ->
                showing = false
                if (required) a.finishAffinity() else skipped = info.code
            }
            .show()
    }
}
