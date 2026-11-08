package app.quickmessage.chat

import android.content.Context
import android.net.ConnectivityManager
import android.os.Build
import org.json.JSONObject

/**
 * Data Saver: when it is active the app stops downloading things nobody asked for (pictures in notifications, remote profile photos).
 * The mode is chosen on the website (Account → Data Saver) and handed over here, so notifications obey it too:
 *   off | on | saver (follow Android's Data Saver) | metered (follow "metered connection", e.g. a Wi-Fi marked as metered) | either (one of those two)
 */
object DataSaver {
    @Volatile var ctx: Context? = null

    private fun cm() = ctx?.getSystemService(Context.CONNECTIVITY_SERVICE) as? ConnectivityManager
    private fun prefs() = ctx?.getSharedPreferences("quickmessage", Context.MODE_PRIVATE)

    var mode: String
        get() = prefs()?.getString("datasaver", "off")?.takeIf { it in setOf("off", "on", "saver", "metered", "either") } ?: "off"
        set(v) { if (v in setOf("off", "on", "saver", "metered", "either")) prefs()?.edit()?.putString("datasaver", v)?.apply() }

    /** Android's own Data Saver (Settings → Network → Data Saver); an app that is exempt from it still counts as "on" for the phone. */
    fun systemSaver(): Boolean = try {
        Build.VERSION.SDK_INT >= 24 && (cm()?.restrictBackgroundStatus ?: ConnectivityManager.RESTRICT_BACKGROUND_STATUS_DISABLED) != ConnectivityManager.RESTRICT_BACKGROUND_STATUS_DISABLED
    } catch (_: Exception) { false }

    /** The connection in use is metered (mobile data, or a Wi-Fi network marked as metered). */
    fun metered(): Boolean = try { cm()?.isActiveNetworkMetered ?: false } catch (_: Exception) { false }

    fun active(): Boolean = when (mode) {
        "on" -> true
        "saver" -> systemSaver()
        "metered" -> metered()
        "either" -> systemSaver() || metered()
        else -> false
    }

    fun state(): String = JSONObject()
        .put("saverAvailable", Build.VERSION.SDK_INT >= 24).put("saver", systemSaver())
        .put("meteredAvailable", true).put("metered", metered())
        .put("mode", mode).put("active", active()).toString()
}
