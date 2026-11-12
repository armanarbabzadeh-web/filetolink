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
    private lateinit var ring: UsageRing
    private lateinit var sortBtn: TextView
    private var lastManifest: Manifest? = null
    /** Owner's hidden switch (hold OK on the "All" tab): show every storage. Off again each time the app opens. */
    private var showAll = false
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
        setContentView(if (Device.isPhone(this)) R.layout.activity_main_phone else R.layout.activity_main)
        findViewById<TextView>(R.id.brand).text = PairActivity.brand(this)
        grid = findViewById(R.id.grid)
        empty = findViewById(R.id.empty)
        userChip = findViewById(R.id.userChip)
        ring = findViewById(R.id.usageRing)
        sortBtn = findViewById(R.id.btnSort)
        sortBtn.text = getString(SORTS[Prefs.sort(this).coerceIn(0, SORTS.size - 1)])
        sortBtn.setOnClickListener { chooseSort() }
        userChip.setOnClickListener { showUsage() }
        warn = findViewById(R.id.warn)
        findViewById<TextView>(R.id.emptyBody).text = getString(R.string.empty_body, BuildConfig.BOT_USERNAME)

        adapter = FileAdapter(::open, ::menu)
        grid.layoutManager = GridLayoutManager(this, Device.columns(this))
        grid.adapter = adapter

        tabs = listOf(
            findViewById<TextView>(R.id.tabAll) to null,
            findViewById<TextView>(R.id.tabVideo) to "video",
            findViewById<TextView>(R.id.tabImage) to "image",
            findViewById<TextView>(R.id.tabAudio) to "audio",
            findViewById<TextView>(R.id.tabFile) to "file",
        )
        tabs.forEach { (v, kind) -> v.setOnClickListener { setFilter(kind) } }
        tabs.first().first.setOnLongClickListener {
            if (lastManifest?.ownerView != true) return@setOnLongClickListener false
            showAll = !showAll
            toast(getString(if (showAll) R.string.view_all else R.string.view_normal))
            render(focusFirst = true)
            true
        }
        findViewById<View>(R.id.btnRefresh).setOnClickListener { refresh(true) }
        findViewById<View>(R.id.btnLogout).setOnClickListener { confirmLogout() }
        setFilter(intent.getStringExtra("filter"))
    }

    override fun onResume() {
        super.onResume()
        android.util.Log.i("TeleTVShare", "main onResume url=${manifestUrl.isNotEmpty()}")
        Updater.checkForUpdate(this)
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

    // subtitle files are not shown on their own: they appear as subtitle tracks of the videos
    private fun visible(): List<FileItem> {
        val gone = Prefs.pendingDeletes(this)
        val list = all.filter { it.id !in gone && !Subs.isSub(it) && (filter == null || it.kind == filter) && shown(it) }
        val byName = java.text.Collator.getInstance(java.util.Locale("fa"))
        return when (Prefs.sort(this)) {
            1 -> list.sortedBy { it.createdAt }
            2 -> list.sortedWith { a, b -> byName.compare(Fmt.title(a.name), Fmt.title(b.name)) }
            3 -> list.sortedWith { a, b -> byName.compare(Fmt.title(b.name), Fmt.title(a.name)) }
            4 -> list.sortedByDescending { it.size }
            5 -> list.sortedBy { it.size }
            6 -> list.sortedByDescending { it.duration }
            else -> list.sortedByDescending { it.createdAt }
        }
    }

    /** Owner in normal view: only files kept on Arvan. */
    private fun shown(f: FileItem) = showAll || lastManifest?.ownerView != true || f.storage == null || f.storage == "arvan"

    private fun chooseSort() {
        val cur = Prefs.sort(this).coerceIn(0, SORTS.size - 1)
        AlertDialog.Builder(this, R.style.AppDialog)
            .setTitle(R.string.sort_title)
            .setSingleChoiceItems(SORTS.map { getString(it) }.toTypedArray(), cur) { d, which ->
                Prefs.setSort(this, which)
                sortBtn.text = getString(SORTS[which])
                render(focusFirst = true)
                d.dismiss()
            }
            .show()
    }

    /** Usage details: one bar per storage (the owner has three), or the plan's space for users. */
    private fun showUsage() {
        val m = lastManifest ?: return
        val box = android.widget.LinearLayout(this).apply {
            orientation = android.widget.LinearLayout.VERTICAL
            val p = (24 * resources.displayMetrics.density).toInt()
            setPadding(p, p / 2, p, 0)
        }
        val rows = if (m.stores.isNotEmpty()) m.stores.filter { showAll || !m.ownerView || it.key == "arvan" } else listOf(Store("plan", m.used, m.quota))
        for (s in rows) {
            val name = getString(when (s.key) { "cf" -> R.string.store_cf; "vps" -> R.string.store_vps; "arvan" -> R.string.store_arvan; else -> R.string.store_plan })
            val txt = android.widget.TextView(this).apply {
                textSize = 18f
                setTextColor(0xFFFFFFFF.toInt())
                text = if (s.cap != null && s.cap > 0) {
                    val pct = (s.used * 100 / s.cap).toInt()
                    "$name: ${Fmt.faSize(s.used)} از ${Fmt.faSize(s.cap)} (${Fmt.fa(pct.toString())}٪) — آزاد: ${Fmt.faSize(maxOf(0, s.cap - s.used))}"
                } else "$name: ${Fmt.faSize(s.used)} — ${getString(R.string.unlimited)}"
                setPadding(0, (14 * resources.displayMetrics.density).toInt(), 0, (6 * resources.displayMetrics.density).toInt())
            }
            val bar = android.widget.ProgressBar(this, null, android.R.attr.progressBarStyleHorizontal).apply {
                max = 1000
                progress = if (s.cap != null && s.cap > 0) (s.used * 1000 / s.cap).toInt().coerceIn(0, 1000) else 1000
                val f = progress / 1000f
                val col = if (s.cap == null) 0xFF8B5CF6.toInt() else if (f >= 0.9f) 0xFFEF4444.toInt() else if (f >= 0.7f) 0xFFFFB547.toInt() else 0xFF22C55E.toInt()
                progressTintList = android.content.res.ColorStateList.valueOf(col)
                progressBackgroundTintList = android.content.res.ColorStateList.valueOf(0x33FFFFFF)
                minimumHeight = (10 * resources.displayMetrics.density).toInt()
            }
            box.addView(txt)
            box.addView(bar, android.widget.LinearLayout.LayoutParams(android.widget.LinearLayout.LayoutParams.MATCH_PARENT, (10 * resources.displayMetrics.density).toInt()))
        }
        AlertDialog.Builder(this, R.style.AppDialog)
            .setTitle(R.string.usage_title)
            .setView(box)
            .setPositiveButton(android.R.string.ok, null)
            .show()
    }

    companion object {
        private val SORTS = intArrayOf(
            R.string.sort_newest, R.string.sort_oldest, R.string.sort_name_az, R.string.sort_name_za,
            R.string.sort_big, R.string.sort_small, R.string.sort_long,
        )
    }

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
            Prefs.setDeleteUrl(this, m.deleteUrl)
            // forget deletes the server has done; keep hiding (and re-sending) the others
            val pending = Prefs.pendingDeletes(this)
            if (pending.isNotEmpty()) {
                val ids = m.files.map { it.id }.toSet()
                val left = pending.intersect(ids)
                Prefs.setPendingDeletes(this, left)
                if (left.isNotEmpty()) sendDeletes(left)
            }
            blocked = m.blocked
            warn.visibility = if (blocked) View.VISIBLE else View.GONE
            lastManifest = m
            ring.fraction = if (m.quota != null && m.quota > 0) m.used.toFloat() / m.quota else if (m.stores.isNotEmpty()) null else 0f
            val quota = m.quota?.let { "‏ از ‏${Fmt.faSize(it)}" } ?: ""
            // isolate the (possibly Latin) name so it doesn't reorder the Persian text around it
            userChip.text = "‏${Fmt.faSize(m.used)}$quota‏   •   ⁨${m.userName}⁩"
            Prefs.setOwnerChannel(this, m.ownerView)
            val ids = m.files.map { it.id }.toSet()
            val prev = known
            if (prev != null) {
                val added = m.files.count { it.id !in prev && shown(it) }
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
            "video", "audio" -> if (Prefs.external(this)) playExternal(f) else play(f)
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

    private fun play(f: FileItem) {
        PlayerActivity.pendingSubs = if (f.kind == "video") Subs.forVideo(f, all) else emptyList()
        startActivity(
            Intent(this, PlayerActivity::class.java)
                .putExtra("url", f.url).putExtra("title", f.name).putExtra("audio", f.kind == "audio")
        )
    }

    private fun playExternal(f: FileItem) {
        if (External.open(this, f, Subs.forVideo(f, all))) {
            Usage.add(this, f.size) // an outside player streams the whole file; count it for fair use
            lifecycleScope.launch { Usage.report(applicationContext) }
        } else {
            toast(getString(R.string.no_external))
            Prefs.setExternal(this, false)
            play(f)
        }
    }

    /** Long press (or hold OK) on a video: choose the player. */
    /** Long press (or hold OK): player choice for videos, and delete for every file. */
    private fun menu(f: FileItem) {
        val media = f.kind == "video" || f.kind == "audio"
        val always = Prefs.external(this)
        val actions = mutableListOf<Pair<String, () -> Unit>>()
        if (media && !blocked) {
            actions += getString(R.string.play_here) to { play(f) }
            actions += getString(R.string.play_external) to { playExternal(f) }
            actions += getString(if (always) R.string.always_here else R.string.always_external) to {
                Prefs.setExternal(this, !always)
                toast(getString(if (always) R.string.now_here else R.string.now_external))
            }
        } else if (!media) {
            actions += getString(R.string.open_file) to { open(f) }
        }
        if (Prefs.deleteUrl(this) != null) actions += getString(R.string.delete_file) to { confirmDelete(f) }
        AlertDialog.Builder(this, R.style.AppDialog)
            .setTitle(Fmt.title(f.name))
            .setItems(actions.map { it.first }.toTypedArray()) { _, which -> actions[which].second() }
            .show()
    }

    private fun confirmDelete(f: FileItem) {
        AlertDialog.Builder(this, R.style.AppDialog)
            .setTitle(R.string.delete_q)
            .setMessage(Fmt.title(f.name) + "\n\n" + getString(R.string.delete_msg))
            .setPositiveButton(R.string.delete_yes) { _, _ ->
                val ids = Prefs.pendingDeletes(this) + f.id
                Prefs.setPendingDeletes(this, ids)
                render(focusFirst = false)
                sendDeletes(ids)
                toast(getString(R.string.deleted))
            }
            .setNegativeButton(R.string.cancel, null)
            .show()
    }

    private fun sendDeletes(ids: Set<String>) {
        val url = Prefs.deleteUrl(this) ?: return
        val body = org.json.JSONObject().put("ids", org.json.JSONArray(ids.toList())).toString()
        lifecycleScope.launch(kotlinx.coroutines.Dispatchers.IO) { runCatching { Net.putJson(url, body) } }
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
