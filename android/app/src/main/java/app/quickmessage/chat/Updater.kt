package app.quickmessage.chat

import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.PackageInstaller
import android.os.Build
import org.json.JSONObject
import java.io.File
import java.net.HttpURLConnection
import java.net.URL

/**
 * In-app updates: downloads the new APK from the site and installs it over this app with Android's PackageInstaller.
 * Needs "Install unknown apps" to be allowed for QuickMessage once (the page sends you to that setting). The update can only be installed if it is signed
 * with the same key as the installed app. On Android 12+ later updates can install without another confirmation tap.
 */
object Updater {
    private const val ACTION = "app.quickmessage.chat.INSTALL_RESULT"
    @Volatile private var busy = false

    private fun report(obj: JSONObject) {
        MainActivity.instance?.runJs("window.__qmUpdate&&window.__qmUpdate(${obj})")
    }

    fun download(ctx: Context, url: String) {
        if (busy) return
        if (!url.startsWith(Config.SITE_URL)) { report(JSONObject().put("state", "failed").put("message", "The update has to come from your own site.")); return }
        busy = true
        Thread {
            val app = ctx.applicationContext
            try {
                val file = File(app.cacheDir, "update.apk")
                if (file.exists()) file.delete()
                val c = URL(url).openConnection() as HttpURLConnection
                c.connectTimeout = 15000; c.readTimeout = 30000; c.instanceFollowRedirects = true
                // some free hosts only answer browsers (they set a cookie from JavaScript): send the web view's cookies like the page would
                try { android.webkit.CookieManager.getInstance().getCookie(url)?.let { c.setRequestProperty("Cookie", it) } } catch (_: Exception) {}
                c.setRequestProperty("User-Agent", System.getProperty("http.agent") ?: "QuickMessage")
                if (c.responseCode !in 200..299) throw RuntimeException("The server answered ${c.responseCode}")
                val total = c.contentLengthLong
                var done = 0L; var lastPct = -1
                c.inputStream.use { i -> file.outputStream().use { o ->
                    val buf = ByteArray(64 * 1024)
                    while (true) {
                        val n = i.read(buf); if (n < 0) break
                        o.write(buf, 0, n); done += n
                        if (total > 0) { val p = (done * 100 / total).toInt(); if (p != lastPct) { lastPct = p; report(JSONObject().put("state", "downloading").put("pct", p)) } }
                    }
                } }
                if (file.length() < 100_000) throw RuntimeException("The downloaded file is too small to be the app")
                report(JSONObject().put("state", "installing"))
                install(app, file)
            } catch (e: Exception) {
                busy = false
                report(JSONObject().put("state", "failed").put("message", e.message ?: "Download failed"))
            }
        }.start()
    }

    private fun install(ctx: Context, file: File) {
        val pi = ctx.packageManager.packageInstaller
        val params = PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL)
        params.setAppPackageName(ctx.packageName)
        if (Build.VERSION.SDK_INT >= 31) params.setRequireUserAction(PackageInstaller.SessionParams.USER_ACTION_NOT_REQUIRED)
        val id = pi.createSession(params)
        pi.openSession(id).use { s ->
            file.inputStream().use { i -> s.openWrite("update", 0, file.length()).use { o -> i.copyTo(o); s.fsync(o) } }
            val intent = Intent(ctx, Result::class.java).setAction(ACTION).setPackage(ctx.packageName)
            val flags = PendingIntent.FLAG_UPDATE_CURRENT or (if (Build.VERSION.SDK_INT >= 31) PendingIntent.FLAG_MUTABLE else 0)
            s.commit(PendingIntent.getBroadcast(ctx, id, intent, flags).intentSender)
        }
    }

    /** Android's answer: asks for the confirmation screen when it needs one, or reports why the update failed. */
    class Result : BroadcastReceiver() {
        override fun onReceive(ctx: Context, i: Intent) {
            when (val status = i.getIntExtra(PackageInstaller.EXTRA_STATUS, -1)) {
                PackageInstaller.STATUS_PENDING_USER_ACTION -> {
                    @Suppress("DEPRECATION") val confirm = i.getParcelableExtra<Intent>(Intent.EXTRA_INTENT)
                    if (confirm != null) { confirm.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK); try { ctx.startActivity(confirm) } catch (_: Exception) {} }
                    report(JSONObject().put("state", "confirm"))
                }
                PackageInstaller.STATUS_SUCCESS -> { busy = false }
                else -> {
                    busy = false
                    val raw = i.getStringExtra(PackageInstaller.EXTRA_STATUS_MESSAGE) ?: "Install failed ($status)"
                    val msg = if (status == PackageInstaller.STATUS_FAILURE_CONFLICT || raw.contains("signature", true) || raw.contains("INSTALL_FAILED_UPDATE_INCOMPATIBLE"))
                        "This update is signed with a different key than the installed app. Uninstall QuickMessage once and install the new one; later updates will work." else raw
                    report(JSONObject().put("state", "failed").put("message", msg))
                }
            }
        }
    }
}
