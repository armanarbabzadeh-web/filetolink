package com.teletvshare.tv

import android.app.UiModeManager
import android.content.Context
import android.content.pm.PackageManager
import android.content.res.Configuration

/** Phone (or tablet) vs TV. TV boxes that don't report themselves as a TV still have no touchscreen. */
object Device {
    @Volatile private var cached: Boolean? = null

    fun isPhone(ctx: Context): Boolean = cached ?: run {
        val pm = ctx.packageManager
        val ui = ctx.getSystemService(Context.UI_MODE_SERVICE) as? UiModeManager
        val tv = ui?.currentModeType == Configuration.UI_MODE_TYPE_TELEVISION || pm.hasSystemFeature(PackageManager.FEATURE_LEANBACK)
        val touch = pm.hasSystemFeature(PackageManager.FEATURE_TOUCHSCREEN)
        (!tv && touch).also { cached = it }
    }

    /** Grid columns: 4 on a TV; on a phone as many ~170dp cards as fit (2 in portrait). */
    fun columns(ctx: Context): Int {
        if (!isPhone(ctx)) return 4
        val w = ctx.resources.configuration.screenWidthDp
        return maxOf(2, w / 170)
    }
}
