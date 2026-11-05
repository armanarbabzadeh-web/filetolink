package com.filetolink.tv

import android.content.Intent
import android.graphics.Bitmap
import android.graphics.Color
import android.os.Build
import android.os.Bundle
import android.widget.ImageView
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity
import androidx.lifecycle.lifecycleScope
import com.google.zxing.BarcodeFormat
import com.google.zxing.EncodeHintType
import com.google.zxing.qrcode.QRCodeWriter
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch

/** Shows a 6-digit code + QR. The user confirms it in the Telegram bot, then this TV gets its token. */
class PairActivity : AppCompatActivity() {

    private lateinit var code: TextView
    private lateinit var qr: ImageView
    private lateinit var status: TextView
    private var job: Job? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_pair)
        code = findViewById(R.id.code)
        qr = findViewById(R.id.qr)
        status = findViewById(R.id.status)
        findViewById<TextView>(R.id.botName).text = getString(R.string.pair_step2, BuildConfig.BOT_USERNAME)
        intent.getStringExtra("reason")?.let { status.text = it }
    }

    override fun onResume() {
        super.onResume()
        job = lifecycleScope.launch { pairLoop() }
    }

    override fun onPause() {
        super.onPause()
        job?.cancel()
    }

    private suspend fun kotlinx.coroutines.CoroutineScope.pairLoop() {
        val name = (Build.MANUFACTURER + " " + Build.MODEL).trim().ifBlank { "Android TV" }
        while (isActive) {
            val info = try {
                Api.pairStart(name)
            } catch (e: Exception) {
                status.text = getString(R.string.error, e.message ?: "")
                delay(5_000)
                continue
            }
            code.text = info.code.chunked(3).joinToString(" ")
            qr.setImageBitmap(qrBitmap(info.link, 480))
            val deadline = System.currentTimeMillis() + info.expiresIn * 1000L - 5_000
            while (isActive && System.currentTimeMillis() < deadline) {
                delay(3_000)
                val res = try { Api.pairPoll(info.secret) } catch (e: Exception) { null }
                if (res == "expired") break
                if (res != null) {
                    Session.save(this@PairActivity, res)
                    startActivity(Intent(this@PairActivity, MainActivity::class.java))
                    finish()
                    return
                }
            }
            // code expired: loop and show a fresh one
        }
    }

    private fun qrBitmap(text: String, size: Int): Bitmap {
        val m = QRCodeWriter().encode(text, BarcodeFormat.QR_CODE, size, size, mapOf(EncodeHintType.MARGIN to 1))
        val px = IntArray(size * size) { i -> if (m[i % size, i / size]) Color.BLACK else Color.WHITE }
        return Bitmap.createBitmap(px, size, size, Bitmap.Config.RGB_565)
    }
}
