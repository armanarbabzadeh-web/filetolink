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

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        // A manifest URL can be handed over directly (used for automated screenshots).
        intent.getStringExtra("manifest")?.takeIf { it.startsWith("http") }?.let {
            Prefs.setManifest(this, it)
            openMain()
            return
        }
        if (Prefs.manifest(this) != null) {
            openMain()
            return
        }
        setContentView(R.layout.activity_pair)
        findViewById<TextView>(R.id.brand).text = brand(this)
        findViewById<TextView>(R.id.step2).text = getString(R.string.pair_step2, BuildConfig.BOT_USERNAME)
        intent.getStringExtra("reason")?.let { findViewById<TextView>(R.id.status).text = it }
    }

    override fun onResume() {
        super.onResume()
        if (Prefs.manifest(this) != null) return
        job = lifecycleScope.launch {
            val codeView = findViewById<TextView>(R.id.code)
            val qr = findViewById<ImageView>(R.id.qr)
            while (isActive) {
                val code = Api.newCode()
                codeView.text = code.substring(0, 4) + " " + code.substring(4)
                qr.setImageBitmap(qrBitmap(Api.pairLink(code), 600))
                val until = System.currentTimeMillis() + 14 * 60_000L
                while (isActive && System.currentTimeMillis() < until) {
                    delay(3_000)
                    val manifest = runCatching { Api.pollPair(code) }.getOrNull()
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

    private fun openMain() {
        startActivity(Intent(this, MainActivity::class.java).putExtras(intent))
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
