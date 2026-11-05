package com.filetolink.tv

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
    private lateinit var status: TextView
    private lateinit var usage: TextView
    private lateinit var adapter: FileAdapter
    private lateinit var tabs: List<Pair<TextView, String?>>

    private var all: List<FileItem> = emptyList()
    private var knownIds: Set<String>? = null
    private var filter: String? = null
    private var pollJob: Job? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)
        grid = findViewById(R.id.grid)
        status = findViewById(R.id.status)
        usage = findViewById(R.id.usage)

        adapter = FileAdapter(::open, ::confirmDelete)
        grid.layoutManager = GridLayoutManager(this, 5)
        grid.adapter = adapter

        tabs = listOf(
            findViewById<TextView>(R.id.tabAll) to null,
            findViewById<TextView>(R.id.tabVideo) to "video",
            findViewById<TextView>(R.id.tabImage) to "image",
            findViewById<TextView>(R.id.tabAudio) to "audio",
            findViewById<TextView>(R.id.tabFile) to "file",
        )
        tabs.forEach { (view, kind) -> view.setOnClickListener { setFilter(kind) } }
        findViewById<View>(R.id.btnRefresh).setOnClickListener { refresh(showLoading = true) }
        setFilter(null)
        tabs[0].first.requestFocus()
    }

    override fun onResume() {
        super.onResume()
        pollJob = lifecycleScope.launch {
            while (isActive) {
                refresh(showLoading = all.isEmpty())
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
        tabs.forEach { (view, k) -> view.isSelected = k == kind }
        render()
    }

    private fun visible(): List<FileItem> =
        if (filter == null) all else all.filter { it.kind == filter }

    private fun render() {
        val list = visible()
        val hadFocusInGrid = grid.hasFocus()
        adapter.submit(list)
        if (list.isEmpty() && status.text.isNullOrEmpty()) status.text = getString(R.string.empty)
        if (list.isNotEmpty()) status.text = ""
        status.visibility = if (list.isEmpty()) View.VISIBLE else View.GONE
        if (hadFocusInGrid && list.isNotEmpty()) grid.post { grid.getChildAt(0)?.requestFocus() }
    }

    private fun refresh(showLoading: Boolean) {
        if (showLoading) {
            status.text = getString(R.string.loading)
            status.visibility = View.VISIBLE
        }
        lifecycleScope.launch {
            try {
                val res = Api.list()
                val ids = res.files.map { it.id }.toSet()
                val prev = knownIds
                if (prev != null) {
                    val added = ids.count { it !in prev }
                    if (added > 0) toast(getString(R.string.new_files, added))
                }
                knownIds = ids
                usage.text = "${Fmt.size(res.used)} از ${Fmt.size(res.quota)} · ${res.files.size} فایل"
                val changed = res.files.map { it.id } != all.map { it.id }
                all = res.files
                status.text = ""
                if (changed || showLoading) render() else status.visibility =
                    if (visible().isEmpty()) View.VISIBLE else View.GONE
                if (visible().isEmpty()) status.text = getString(R.string.empty)
            } catch (e: Exception) {
                if (all.isEmpty()) {
                    status.text = getString(R.string.error, e.message ?: e.javaClass.simpleName)
                    status.visibility = View.VISIBLE
                } else if (showLoading) {
                    toast(getString(R.string.error, e.message ?: ""))
                }
            }
        }
    }

    private fun open(f: FileItem) {
        when (f.kind) {
            "video", "audio" -> startActivity(
                Intent(this, PlayerActivity::class.java)
                    .putExtra("url", f.url).putExtra("title", f.name)
            )
            "image" -> {
                val images = visible().filter { it.kind == "image" }
                startActivity(
                    Intent(this, ImageActivity::class.java)
                        .putExtra("urls", images.map { it.url }.toTypedArray())
                        .putExtra("names", images.map { it.name }.toTypedArray())
                        .putExtra("index", images.indexOfFirst { it.id == f.id }.coerceAtLeast(0))
                )
            }
            else -> AlertDialog.Builder(this)
                .setTitle(f.name)
                .setMessage("${Fmt.size(f.size)} · ${Fmt.date(f.createdAt)}\n\n${getString(R.string.open_link)}\n${f.url}")
                .setPositiveButton(android.R.string.ok, null)
                .show()
        }
    }

    private fun confirmDelete(f: FileItem) {
        AlertDialog.Builder(this)
            .setTitle(R.string.delete_q)
            .setMessage("${f.name}\n${Fmt.size(f.size)}")
            .setPositiveButton(R.string.delete_yes) { _, _ ->
                lifecycleScope.launch {
                    try {
                        Api.delete(f.id)
                        all = all.filter { it.id != f.id }
                        knownIds = knownIds?.minus(f.id)
                        render()
                        toast(getString(R.string.deleted))
                    } catch (e: Exception) {
                        toast(getString(R.string.error, e.message ?: ""))
                    }
                }
            }
            .setNegativeButton(R.string.cancel, null)
            .show()
    }

    private fun toast(s: String) = Toast.makeText(this, s, Toast.LENGTH_SHORT).show()
}
