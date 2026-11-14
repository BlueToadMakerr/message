package app.quickmessage.chat

import android.content.Context
import android.os.Bundle
import com.google.firebase.analytics.FirebaseAnalytics

/**
 * Usage statistics for the app itself (the website inside it reports its own screens / errors through the web SDK).
 * Account based: the website tells us the account's choice (QMApp.setAnalytics) and we remember it; until it has said "on",
 * and whenever it says "off", nothing is collected (collection is switched off in the manifest as well).
 * Sent: which kind of push event happened (delivered / fallback / failed), crashes by exception class and file, app version
 * (Analytics adds it by itself). Never message text, names or ids.
 */
object AppAnalytics {
    private var an: FirebaseAnalytics? = null
    private var hooked = false
    private fun prefs(ctx: Context) = ctx.getSharedPreferences("quickmessage", Context.MODE_PRIVATE)

    private fun get(ctx: Context): FirebaseAnalytics? {
        if (an == null && Push.available(ctx)) an = try { FirebaseAnalytics.getInstance(ctx.applicationContext) } catch (_: Throwable) { null }
        return an
    }

    /** Call once from the activity / services: applies the saved choice and installs the crash hook. */
    fun init(ctx: Context) {
        try {
            val a = get(ctx) ?: return
            val on = prefs(ctx).getBoolean("analytics_on", false)
            a.setAnalyticsCollectionEnabled(on)
            a.setUserId(if (on) prefs(ctx).getString("analytics_uid", null) else null)
            if (!hooked) {
                hooked = true
                val old = Thread.getDefaultUncaughtExceptionHandler()
                Thread.setDefaultUncaughtExceptionHandler { t, e ->
                    try { log(ctx, "app_crash", "kind" to e.javaClass.simpleName, "file" to (e.stackTrace.firstOrNull { it.className.startsWith("app.quickmessage") }?.let { "${it.fileName}:${it.lineNumber}" } ?: "")) } catch (_: Throwable) {}
                    old?.uncaughtException(t, e)
                }
            }
        } catch (_: Throwable) { /* analytics must never break the app */ }
    }

    fun setEnabled(ctx: Context, on: Boolean) {
        try {
            prefs(ctx).edit().putBoolean("analytics_on", on).apply(); get(ctx)?.setAnalyticsCollectionEnabled(on)
            get(ctx)?.setUserId(if (on) prefs(ctx).getString("analytics_uid", null) else null)
        } catch (_: Throwable) {}
    }

    /** The account's own random id (what the website uses as user_id) so the app's events belong to the same user; forgotten when it is switched off. */
    fun setUser(ctx: Context, id: String) {
        try {
            prefs(ctx).edit().putString("analytics_uid", id.take(128)).apply()
            if (prefs(ctx).getBoolean("analytics_on", false)) get(ctx)?.setUserId(id.take(128))
        } catch (_: Throwable) {}
    }

    fun log(ctx: Context, name: String, vararg params: Pair<String, String>) {
        try {
            if (!prefs(ctx).getBoolean("analytics_on", false)) return
            val b = Bundle(); for ((k, v) in params) b.putString(k.take(40), v.take(100))
            get(ctx)?.logEvent(name.take(40), b)
        } catch (_: Throwable) {}
    }
}
