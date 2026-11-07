package com.teletvshare.tv

import android.content.Intent
import android.os.Bundle
import android.view.View
import android.widget.TextView
import android.widget.Toast
import androidx.appcompat.app.AlertDialog
import androidx.appcompat.app.AppCompatActivity
import androidx.lifecycle.lifecycleScope
import androidx.recyclerview.widget.GridLayoutManager
import androidx.recyclerview.widget.RecyclerView
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch

class MainActivity : AppCompatActivity() {

    private lateinit var grid: RecyclerView
    private lateinit var empty: View
    private lateinit var userChip: TextView
    private lateinit var warn: View
    private lateinit var adapter: FileAdapter
    private lateinit var tabs: List<Pair<TextView, String?>>

    private var manifestUrl = ""
    private var all: List<FileItem> = emptyList()
    private var known: Set<String>? = null
    private var filter: String? = null
    private var blocked = false
    private var pollJob: Job? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        android.util.Log.i("TeleTVShare", "main onCreate manifest=${Prefs.manifest(this) != null}")
        manifestUrl = Prefs.manifest(this) ?: return unlinked(null)
        setContentView(R.layout.activity_main)
        findViewById<TextView>(R.id.brand).text = PairActivity.brand(this)
        grid = findViewById(R.id.grid)
        empty = findViewById(R.id.empty)
        userChip = findViewById(R.id.userChip)
        warn = findViewById(R.id.warn)
        findViewById<TextView>(R.id.emptyBody).text = getString(R.string.empty_body, BuildConfig.BOT_USERNAME)

        adapter = FileAdapter(::open)
        grid.layoutManager = GridLayoutManager(this, 4)
        grid.adapter = adapter

        tabs = listOf(
            findViewById<TextView>(R.id.tabAll) to null,
            findViewById<TextView>(R.id.tabVideo) to "video",
            findViewById<TextView>(R.id.tabImage) to "image",
            findViewById<TextView>(R.id.tabAudio) to "audio",
            findViewById<TextView>(R.id.tabFile) to "file",
        )
        tabs.forEach { (v, kind) -> v.setOnClickListener { setFilter(kind) } }
        findViewById<View>(R.id.btnRefresh).setOnClickListener { refresh(true) }
        findViewById<View>(R.id.btnLogout).setOnClickListener { confirmLogout() }
        setFilter(intent.getStringExtra("filter"))
    }

    override fun onResume() {
        super.onResume()
        android.util.Log.i("TeleTVShare", "main onResume url=${manifestUrl.isNotEmpty()}")
        if (manifestUrl.isEmpty()) return
        pollJob = lifecycleScope.launch {
            while (isActive) {
                load(false)
                Usage.report(this@MainActivity)
                delay(20_000)
            }
        }
    }

    override fun onPause() {
        super.onPause()
        pollJob?.cancel()
    }

    private fun setFilter(kind: String?) {
        filter = kind
        tabs.forEach { (v, k) -> v.isSelected = k == kind }
        render(focusFirst = false)
    }

    private fun visible() = if (filter == null) all else all.filter { it.kind == filter }

    private fun render(focusFirst: Boolean) {
        val list = visible()
        adapter.submit(list)
        empty.visibility = if (list.isEmpty() && known != null) View.VISIBLE else View.GONE
        if (focusFirst && list.isNotEmpty()) grid.post { grid.getChildAt(0)?.requestFocus() }
    }

    private suspend fun load(manual: Boolean) {
        try {
            val m = Api.manifest(manifestUrl)
            Prefs.setReportUrl(this, m.reportUrl)
            blocked = m.blocked
            warn.visibility = if (blocked) View.VISIBLE else View.GONE
            val quota = m.quota?.let { "‏ از ‏${Fmt.faSize(it)}" } ?: ""
            // isolate the (possibly Latin) name so it doesn't reorder the Persian text around it
            userChip.text = "‏${Fmt.faSize(m.used)}$quota‏   •   ⁨${m.userName}⁩"
            val ids = m.files.map { it.id }.toSet()
            val prev = known
            if (prev != null) {
                val added = ids.count { it !in prev }
                if (added > 0) toast(getString(R.string.new_files, Fmt.fa(added.toString())))
            }
            val first = prev == null
            known = ids
            if (first || m.files.map { it.id } != all.map { it.id }) {
                all = m.files
                render(focusFirst = first)
            }
        } catch (e: UnlinkedException) {
            unlinked(getString(R.string.unlinked))
        } catch (e: Exception) {
            android.util.Log.w("TeleTVShare", "manifest load failed", e)
            if (manual || known == null) toast(getString(R.string.error))
        }
    }

    private fun refresh(manual: Boolean) { lifecycleScope.launch { load(manual) } }

    private fun open(f: FileItem) {
        if (blocked && (f.kind == "video" || f.kind == "audio")) {
            toast(getString(R.string.blocked))
            return
        }
        when (f.kind) {
            "video", "audio" -> startActivity(
                Intent(this, PlayerActivity::class.java)
                    .putExtra("url", f.url).putExtra("title", f.name).putExtra("audio", f.kind == "audio")
            )
            "image" -> {
                val images = visible().filter { it.kind == "image" }
                startActivity(
                    Intent(this, ImageActivity::class.java)
                        .putExtra("urls", images.map { it.url }.toTypedArray())
                        .putExtra("names", images.map { it.name }.toTypedArray())
                        .putExtra("sizes", images.map { it.size }.toLongArray())
                        .putExtra("index", images.indexOfFirst { it.id == f.id }.coerceAtLeast(0))
                )
            }
            else -> AlertDialog.Builder(this, R.style.AppDialog)
                .setTitle(Fmt.title(f.name))
                .setMessage(Fmt.faSize(f.size) + "\n\n" + getString(R.string.file_info))
                .setPositiveButton(android.R.string.ok, null)
                .show()
        }
    }

    private fun confirmLogout() {
        AlertDialog.Builder(this, R.style.AppDialog)
            .setTitle(R.string.logout_q)
            .setMessage(R.string.logout_msg)
            .setPositiveButton(R.string.yes_logout) { _, _ ->
                Prefs.setManifest(this, null)
                Prefs.setReportUrl(this, null)
                startActivity(Intent(this, PairActivity::class.java))
                finish()
            }
            .setNegativeButton(R.string.cancel, null)
            .show()
    }

    private fun unlinked(reason: String?) {
        Prefs.setManifest(this, null)
        Prefs.setReportUrl(this, null)
        Prefs.setReason(this, reason)
        startActivity(Intent(this, PairActivity::class.java))
        finish()
    }

    private fun toast(s: String) = Toast.makeText(this, s, Toast.LENGTH_LONG).show()
}
