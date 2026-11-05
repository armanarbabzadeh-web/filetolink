package com.filetolink.tv

import android.view.KeyEvent
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.widget.ImageView
import android.widget.TextView
import androidx.recyclerview.widget.RecyclerView
import coil.load

class FileAdapter(
    private val onOpen: (FileItem) -> Unit,
    private val onDelete: (FileItem) -> Unit,
) : RecyclerView.Adapter<FileAdapter.VH>() {

    var items: List<FileItem> = emptyList()
        private set

    fun submit(list: List<FileItem>) {
        items = list
        notifyDataSetChanged()
    }

    init { setHasStableIds(true) }

    override fun getItemId(position: Int): Long = items[position].id.hashCode().toLong()

    override fun getItemCount() = items.size

    override fun onCreateViewHolder(parent: ViewGroup, viewType: Int): VH =
        VH(LayoutInflater.from(parent.context).inflate(R.layout.item_file, parent, false))

    override fun onBindViewHolder(h: VH, position: Int) = h.bind(items[position])

    inner class VH(v: View) : RecyclerView.ViewHolder(v) {
        private val thumb: ImageView = v.findViewById(R.id.thumb)
        private val badge: ImageView = v.findViewById(R.id.badge)
        private val name: TextView = v.findViewById(R.id.name)
        private val meta: TextView = v.findViewById(R.id.meta)
        private val duration: TextView = v.findViewById(R.id.duration)

        fun bind(f: FileItem) {
            name.text = f.name
            meta.text = "${Fmt.size(f.size)} · ${Fmt.date(f.createdAt)}"
            val d = Fmt.duration(f.duration)
            duration.text = d
            duration.visibility = if (d.isEmpty()) View.GONE else View.VISIBLE

            val icon = when (f.kind) {
                "video" -> R.drawable.ic_play
                "audio" -> R.drawable.ic_audio
                "image" -> R.drawable.ic_image
                else -> R.drawable.ic_file
            }
            if (f.thumb != null) {
                thumb.load(f.thumb) { crossfade(true) }
                badge.setImageResource(if (f.kind == "video") R.drawable.ic_play else 0)
            } else {
                thumb.setImageDrawable(null)
                badge.setImageResource(icon)
            }

            itemView.setOnClickListener { onOpen(f) }
            itemView.setOnLongClickListener { onDelete(f); true }
            itemView.setOnKeyListener { _, keyCode, e ->
                if (keyCode == KeyEvent.KEYCODE_MENU && e.action == KeyEvent.ACTION_UP) {
                    onDelete(f); true
                } else false
            }
            itemView.setOnFocusChangeListener { view, focused ->
                val s = if (focused) 1.07f else 1f
                view.animate().scaleX(s).scaleY(s).setDuration(120).start()
                view.elevation = if (focused) 8f else 0f
            }
        }
    }
}
