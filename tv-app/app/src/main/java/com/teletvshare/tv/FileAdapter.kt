package com.teletvshare.tv

import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.widget.ImageView
import android.widget.TextView
import androidx.recyclerview.widget.RecyclerView
import coil.load
import coil.transform.RoundedCornersTransformation

class FileAdapter(private val onOpen: (FileItem) -> Unit) : RecyclerView.Adapter<FileAdapter.VH>() {

    var items: List<FileItem> = emptyList()
        private set

    fun submit(list: List<FileItem>) {
        items = list
        notifyDataSetChanged()
    }

    init { setHasStableIds(true) }

    override fun getItemId(position: Int) = items[position].id.hashCode().toLong()
    override fun getItemCount() = items.size
    override fun onCreateViewHolder(parent: ViewGroup, viewType: Int) =
        VH(LayoutInflater.from(parent.context).inflate(R.layout.item_file, parent, false))
    override fun onBindViewHolder(h: VH, position: Int) = h.bind(items[position])

    inner class VH(v: View) : RecyclerView.ViewHolder(v) {
        private val thumb: ImageView = v.findViewById(R.id.thumb)
        private val center: ImageView = v.findViewById(R.id.center)
        private val badge: ImageView = v.findViewById(R.id.badge)
        private val name: TextView = v.findViewById(R.id.name)
        private val meta: TextView = v.findViewById(R.id.meta)
        private val duration: TextView = v.findViewById(R.id.duration)

        fun bind(f: FileItem) {
            name.text = Fmt.title(f.name)
            meta.text = "${Fmt.faSize(f.size)}  •  ${Fmt.date(f.createdAt)}"
            val d = Fmt.fa(Fmt.duration(f.duration))
            duration.text = d
            duration.visibility = if (d.isEmpty()) View.GONE else View.VISIBLE
            val icon = when (f.kind) {
                "video" -> R.drawable.ic_movie
                "audio" -> R.drawable.ic_audio
                "image" -> R.drawable.ic_image
                else -> R.drawable.ic_file
            }
            badge.setImageResource(icon)
            if (f.thumb != null) {
                thumb.load(f.thumb) { crossfade(true); transformations(RoundedCornersTransformation(28f)) }
                center.setImageResource(if (f.kind == "video") R.drawable.ic_play_big else 0)
            } else {
                thumb.setImageDrawable(null)
                center.setImageResource(icon)
                center.alpha = 0.55f
            }
            itemView.setOnClickListener { onOpen(f) }
            itemView.setOnFocusChangeListener { view, focused ->
                val s = if (focused) 1.08f else 1f
                view.animate().scaleX(s).scaleY(s).setDuration(140).start()
                view.elevation = if (focused) 16f else 0f
            }
        }
    }
}
