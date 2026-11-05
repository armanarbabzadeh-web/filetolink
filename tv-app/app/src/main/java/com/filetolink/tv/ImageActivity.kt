package com.filetolink.tv

import android.os.Bundle
import android.view.KeyEvent
import android.view.View
import android.widget.ImageView
import android.widget.ProgressBar
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity
import coil.load

class ImageActivity : AppCompatActivity() {

    private lateinit var urls: Array<String>
    private lateinit var names: Array<String>
    private var index = 0
    private lateinit var image: ImageView
    private lateinit var progress: ProgressBar
    private lateinit var caption: TextView

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_image)
        urls = intent.getStringArrayExtra("urls") ?: emptyArray()
        names = intent.getStringArrayExtra("names") ?: emptyArray()
        index = savedInstanceState?.getInt("index") ?: intent.getIntExtra("index", 0)
        image = findViewById(R.id.image)
        progress = findViewById(R.id.progress)
        caption = findViewById(R.id.caption)
        show()
    }

    private fun show() {
        if (urls.isEmpty()) return finish()
        index = index.coerceIn(0, urls.size - 1)
        caption.text = "${names.getOrNull(index) ?: ""}   (${index + 1} / ${urls.size})"
        progress.visibility = View.VISIBLE
        image.load(urls[index]) {
            crossfade(true)
            listener(
                onSuccess = { _, _ -> progress.visibility = View.GONE },
                onError = { _, _ -> progress.visibility = View.GONE; caption.text = "خطا در بارگذاری عکس" },
            )
        }
    }

    // The grid is right-to-left, so LEFT moves to the next photo and RIGHT to the previous one.
    override fun onKeyDown(keyCode: Int, event: KeyEvent?): Boolean {
        when (keyCode) {
            KeyEvent.KEYCODE_DPAD_LEFT, KeyEvent.KEYCODE_MEDIA_NEXT, KeyEvent.KEYCODE_MEDIA_FAST_FORWARD -> {
                if (index < urls.size - 1) { index++; show() }
                return true
            }
            KeyEvent.KEYCODE_DPAD_RIGHT, KeyEvent.KEYCODE_MEDIA_PREVIOUS, KeyEvent.KEYCODE_MEDIA_REWIND -> {
                if (index > 0) { index--; show() }
                return true
            }
        }
        return super.onKeyDown(keyCode, event)
    }

    override fun onSaveInstanceState(outState: Bundle) {
        super.onSaveInstanceState(outState)
        outState.putInt("index", index)
    }
}
