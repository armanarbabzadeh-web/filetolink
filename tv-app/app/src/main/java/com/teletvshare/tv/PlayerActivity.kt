package com.teletvshare.tv

import android.os.Bundle
import android.view.KeyEvent
import android.view.View
import android.widget.TextView
import android.widget.Toast
import androidx.annotation.OptIn
import androidx.appcompat.app.AppCompatActivity
import androidx.lifecycle.lifecycleScope
import androidx.media3.common.MediaItem
import androidx.media3.common.PlaybackException
import androidx.media3.common.Player
import androidx.media3.common.util.UnstableApi
import androidx.media3.datasource.DataSource
import androidx.media3.datasource.DataSpec
import androidx.media3.datasource.DefaultHttpDataSource
import androidx.media3.datasource.TransferListener
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.exoplayer.source.DefaultMediaSourceFactory
import androidx.media3.ui.PlayerView
import kotlinx.coroutines.launch

@OptIn(UnstableApi::class)
class PlayerActivity : AppCompatActivity() {

    private var player: ExoPlayer? = null
    private lateinit var view: PlayerView
    private var position = 0L

    // Counts streamed bytes for the fair-use report.
    private val counter = object : TransferListener {
        override fun onTransferInitializing(source: DataSource, dataSpec: DataSpec, isNetwork: Boolean) {}
        override fun onTransferStart(source: DataSource, dataSpec: DataSpec, isNetwork: Boolean) {}
        override fun onBytesTransferred(source: DataSource, dataSpec: DataSpec, isNetwork: Boolean, bytes: Int) {
            if (isNetwork) Usage.add(this@PlayerActivity, bytes.toLong())
        }
        override fun onTransferEnd(source: DataSource, dataSpec: DataSpec, isNetwork: Boolean) {}
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_player)
        view = findViewById(R.id.playerView)
        view.keepScreenOn = true
        position = savedInstanceState?.getLong("pos") ?: 0L
        val title = findViewById<TextView>(R.id.title)
        title.text = Fmt.title(intent.getStringExtra("title") ?: "")
        if (intent.getBooleanExtra("audio", false)) {
            findViewById<View>(R.id.audioArt).visibility = View.VISIBLE
            view.controllerShowTimeoutMs = 0
        }
        view.setControllerVisibilityListener(PlayerView.ControllerVisibilityListener { v -> title.visibility = v })
    }

    override fun onStart() {
        super.onStart()
        val http = DefaultHttpDataSource.Factory()
            .setUserAgent("TeleTVShare-TV/${BuildConfig.VERSION_NAME}")
            .setConnectTimeoutMs(20_000)
            .setReadTimeoutMs(30_000)
            .setTransferListener(counter)
        val p = ExoPlayer.Builder(this)
            .setMediaSourceFactory(DefaultMediaSourceFactory(http))
            .setSeekBackIncrementMs(10_000)
            .setSeekForwardIncrementMs(10_000)
            .build()
        p.addListener(object : Player.Listener {
            override fun onPlayerError(error: PlaybackException) {
                Toast.makeText(this@PlayerActivity, "خطا در پخش: ${error.errorCodeName}", Toast.LENGTH_LONG).show()
            }
        })
        view.player = p
        p.setMediaItem(MediaItem.fromUri(intent.getStringExtra("url") ?: return))
        p.seekTo(position)
        p.playWhenReady = true
        p.prepare()
        player = p
        view.requestFocus()
    }

    override fun onStop() {
        super.onStop()
        player?.let { position = it.currentPosition; it.release() }
        player = null
        view.player = null
        lifecycleScope.launch { Usage.report(applicationContext) }
    }

    override fun onSaveInstanceState(outState: Bundle) {
        super.onSaveInstanceState(outState)
        outState.putLong("pos", player?.currentPosition ?: position)
    }

    override fun dispatchKeyEvent(event: KeyEvent): Boolean =
        view.dispatchKeyEvent(event) || super.dispatchKeyEvent(event)
}
