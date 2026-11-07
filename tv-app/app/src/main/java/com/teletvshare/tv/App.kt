package com.teletvshare.tv

import android.app.Application
import android.content.Context
import coil.ImageLoader
import coil.ImageLoaderFactory
import okhttp3.OkHttpClient
import java.security.KeyStore
import java.security.cert.CertificateException
import java.security.cert.CertificateFactory
import java.security.cert.X509Certificate
import javax.net.ssl.HttpsURLConnection
import javax.net.ssl.SSLContext
import javax.net.ssl.SSLSocketFactory
import javax.net.ssl.TrustManagerFactory
import javax.net.ssl.X509TrustManager

/**
 * Arvan's HTTPS certificate chains up to Let's Encrypt "ISRG Root X1", which Android TVs older than
 * 7.1 don't have. Without it every request fails and pairing never finishes. The root is bundled
 * (res/raw/isrg_root_x1.pem) and trusted next to the system's own roots, for every connection:
 * HttpURLConnection (pairing, manifests, ExoPlayer) and Coil's OkHttp (thumbnails, photos).
 */
class App : Application(), ImageLoaderFactory {

    override fun onCreate() {
        super.onCreate()
        runCatching { Tls.install(this) }
            .onFailure { android.util.Log.w("TeleTVShare", "TLS setup failed", it) }
    }

    override fun newImageLoader(): ImageLoader {
        val b = OkHttpClient.Builder()
        Tls.socketFactory?.let { sf -> Tls.trustManager?.let { tm -> b.sslSocketFactory(sf, tm) } }
        return ImageLoader.Builder(this).okHttpClient(b.build()).build()
    }
}

object Tls {
    var socketFactory: SSLSocketFactory? = null
    var trustManager: X509TrustManager? = null

    fun install(ctx: Context) {
        val system = defaultTrustManager(null)
        val ks = KeyStore.getInstance(KeyStore.getDefaultType()).apply { load(null, null) }
        val cf = CertificateFactory.getInstance("X.509")
        ctx.resources.openRawResource(R.raw.isrg_root_x1).use { ks.setCertificateEntry("isrg_root_x1", cf.generateCertificate(it)) }
        val bundled = defaultTrustManager(ks)
        val tm = object : X509TrustManager {
            override fun checkClientTrusted(chain: Array<X509Certificate>, authType: String) = system.checkClientTrusted(chain, authType)
            override fun checkServerTrusted(chain: Array<X509Certificate>, authType: String) {
                try {
                    system.checkServerTrusted(chain, authType)
                } catch (e: CertificateException) {
                    bundled.checkServerTrusted(chain, authType) // throws if this root doesn't help either
                }
            }
            override fun getAcceptedIssuers(): Array<X509Certificate> = system.acceptedIssuers + bundled.acceptedIssuers
        }
        val ssl = SSLContext.getInstance("TLS").apply { init(null, arrayOf(tm), null) }
        socketFactory = ssl.socketFactory
        trustManager = tm
        HttpsURLConnection.setDefaultSSLSocketFactory(ssl.socketFactory)
    }

    private fun defaultTrustManager(ks: KeyStore?): X509TrustManager {
        val f = TrustManagerFactory.getInstance(TrustManagerFactory.getDefaultAlgorithm())
        f.init(ks)
        return f.trustManagers.filterIsInstance<X509TrustManager>().first()
    }
}
