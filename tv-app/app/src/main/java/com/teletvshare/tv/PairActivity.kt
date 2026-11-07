package com.teletvshare.tv

import android.content.Intent
import android.graphics.Bitmap
import android.graphics.Color
import android.os.Bundle
import android.text.SpannableString
import android.text.Spanned
import android.text.style.ForegroundColorSpan
import android.widget.ImageView
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import androidx.lifecycle.lifecycleScope
import com.google.zxing.BarcodeFormat
import com.google.zxing.EncodeHintType
import com.google.zxing.qrcode.QRCodeWriter
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch

/**
 * First screen: shows an 8-character code and a QR (t.me/<bot>?start=tv_<CODE>).
 * When the user confirms in Telegram, the bot writes p/<CODE>.json on Arvan with the manifest URL.
 */
class PairActivity : AppCompatActivity() {

    private var job: Job? = null
    private var code: String? = null
    private var codeUntil = 0L

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        if (Prefs.manifest(this) != null) {
            openMain()
            return
        }
        code = savedInstanceState?.getString("code")
        codeUntil = savedInstanceState?.getLong("until") ?: 0L
        setContentView(R.layout.activity_pair)
        findViewById<TextView>(R.id.brand).text = brand(this)
        findViewById<TextView>(R.id.step2).text = getString(R.string.pair_step2, BuildConfig.BOT_USERNAME)
        Prefs.takeReason(this)?.let { findViewById<TextView>(R.id.status).text = it }
    }

    override fun onResume() {
        super.onResume()
        if (Prefs.manifest(this) != null) return
        Updater.checkForUpdate(this)
        job = lifecycleScope.launch {
            val codeView = findViewById<TextView>(R.id.code)
            val qr = findViewById<ImageView>(R.id.qr)
            while (isActive) {
                // Keep the same code while the user switches to Telegram and back; renew it only when it expires.
                if (code == null || System.currentTimeMillis() > codeUntil) {
                    code = Api.newCode()
                    codeUntil = System.currentTimeMillis() + 14 * 60_000L
                }
                val code = code!!
                val until = codeUntil
                codeView.text = code.substring(0, 4) + " " + code.substring(4)
                qr.setImageBitmap(qrBitmap(Api.pairLink(code), 600))
                // check right away, then every 3 seconds
                val first = poll(code)
                if (first != null) {
                    Prefs.setManifest(this@PairActivity, first)
                    openMain()
                    return@launch
                }
                while (isActive && System.currentTimeMillis() < until) {
                    delay(3_000)
                    val manifest = poll(code)
                    if (manifest != null) {
                        Prefs.setManifest(this@PairActivity, manifest)
                        openMain()
                        return@launch
                    }
                }
            }
        }
    }

    override fun onPause() {
        super.onPause()
        job?.cancel()
    }

    override fun onSaveInstanceState(outState: Bundle) {
        super.onSaveInstanceState(outState)
        outState.putString("code", code)
        outState.putLong("until", codeUntil)
    }

    private var failures = 0

    /** One check for the pairing answer. Shows a clear hint on screen when the server can't be reached. */
    private suspend fun poll(code: String): String? {
        val status = findViewById<TextView>(R.id.status)
        return runCatching { Api.pollPair(code) }
            .onSuccess {
                if (failures > 0) status.setText(R.string.pair_wait)
                failures = 0
            }
            .onFailure {
                android.util.Log.w("TeleTVShare", "pair poll failed", it)
                failures++
                if (failures >= 2) {
                    val tls = generateSequence(it as Throwable?) { e -> e.cause }.any { e -> e is javax.net.ssl.SSLException || e is java.security.cert.CertificateException }
                    status.text = if (tls) getString(R.string.pair_err_tls) else getString(R.string.pair_err_net)
                }
            }
            .getOrNull()
    }

    private fun openMain() {
        startActivity(Intent(this, MainActivity::class.java))
        finish()
    }

    private fun qrBitmap(text: String, size: Int): Bitmap {
        val m = QRCodeWriter().encode(text, BarcodeFormat.QR_CODE, size, size, mapOf(EncodeHintType.MARGIN to 0))
        val px = IntArray(size * size) { i -> if (m[i % size, i / size]) Color.rgb(10, 20, 64) else Color.WHITE }
        return Bitmap.createBitmap(px, size, size, Bitmap.Config.RGB_565)
    }

    companion object {
        /** "TeleTV" in white + "Share" in cyan. */
        fun brand(ctx: android.content.Context): SpannableString {
            val s = SpannableString("TeleTVShare")
            s.setSpan(ForegroundColorSpan(ContextCompat.getColor(ctx, R.color.accent)), 6, 11, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
            return s
        }
    }
}
