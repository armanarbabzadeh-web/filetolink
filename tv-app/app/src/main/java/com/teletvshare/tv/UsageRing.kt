package com.teletvshare.tv

import android.content.Context
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.RectF
import android.util.AttributeSet
import android.view.View

/** Ring chart of used space: green below 70 %, orange below 90 %, red above. Unlimited plans show ∞. */
class UsageRing @JvmOverloads constructor(ctx: Context, attrs: AttributeSet? = null) : View(ctx, attrs) {

    private val d = resources.displayMetrics.density
    private val track = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.STROKE; strokeWidth = 6 * d; color = 0x33FFFFFF }
    private val arc = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.STROKE; strokeWidth = 6 * d; strokeCap = Paint.Cap.ROUND }
    private val text = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = Color.WHITE; textAlign = Paint.Align.CENTER; isFakeBoldText = true }
    private val box = RectF()

    /** 0..1, or null for an unlimited plan. */
    var fraction: Float? = 0f
        set(v) { field = v; invalidate() }

    override fun onDraw(c: Canvas) {
        val s = minOf(width, height).toFloat()
        val pad = track.strokeWidth / 2 + 1
        box.set((width - s) / 2 + pad, (height - s) / 2 + pad, (width + s) / 2 - pad, (height + s) / 2 - pad)
        c.drawArc(box, 0f, 360f, false, track)
        val f = fraction
        val label: String
        if (f == null) {
            arc.color = 0xFF8B5CF6.toInt()
            c.drawArc(box, 0f, 360f, false, arc)
            label = "∞"
            text.textSize = s * 0.42f
        } else {
            val p = f.coerceIn(0f, 1f)
            arc.color = when {
                p >= 0.9f -> 0xFFEF4444.toInt()
                p >= 0.7f -> 0xFFFFB547.toInt()
                else -> 0xFF22C55E.toInt()
            }
            if (p > 0f) c.drawArc(box, -90f, maxOf(4f, 360f * p), false, arc)
            label = Fmt.fa((p * 100).toInt().toString()) + "٪"
            text.textSize = s * 0.27f
        }
        c.drawText(label, width / 2f, height / 2f - (text.descent() + text.ascent()) / 2, text)
    }
}
