package app.quickmessage.chat

import android.content.Context
import android.content.Intent
import com.google.firebase.FirebaseApp
import com.google.firebase.messaging.FirebaseMessaging
import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage
import org.json.JSONObject

/**
 * Push instead of a standing connection.
 *
 * The app registers a Firebase Cloud Messaging token under FCM/{uid}/{token} = "android". When something happens (a new message, a call) a Cloud
 * Function (functions/index.js) sends a DATA-ONLY, high priority push. [PushService] receives it and wakes [NotifyService] for a moment: the service
 * makes the few plain requests it needs (who wrote, the thread, the picture, decrypting), shows the real notification, and goes back to sleep.
 * No stream, no polling and no ever-present "Listening" notification while push works.
 *
 * Push needs google-services.json in android/app/ (Firebase console → Project settings → Your apps → Android, package app.quickmessage.chat).
 * Without it, with a private server, or before the token is registered, the app falls back to the old live connection ([active] is false).
 */
object Push {
    /** Firebase was set up in this build (google-services.json was present). */
    fun available(ctx: Context): Boolean = try { FirebaseApp.getApps(ctx).isNotEmpty() } catch (_: Throwable) { false }

    /** Push is working for the signed-in account: no live connection needed. */
    fun active(ctx: Context, st: Store): Boolean =
        Config.privateServer.isEmpty() && st.signedIn && st.pushOk == (st.uid + "|" + st.pushToken) && !st.pushToken.isNullOrEmpty() && available(ctx)

    /** Gets the device's token and stores it in the database (once per account + token). Safe to call often. */
    fun register(ctx: Context) {
        val app = ctx.applicationContext
        val st = Store(app)
        if (Config.privateServer.isNotEmpty() || !st.signedIn || !available(app)) return
        try {
            FirebaseMessaging.getInstance().token.addOnSuccessListener { tok -> if (!tok.isNullOrEmpty()) save(app, tok) }
        } catch (_: Throwable) { /* no Google Play services: stay on the live connection */ }
    }

    internal fun save(app: Context, tok: String) {
        Thread {
            try {
                val st = Store(app)
                val uid = st.uid ?: return@Thread
                if (!st.signedIn || st.pushOk == "$uid|$tok") return@Thread
                val old = st.pushToken
                val fb = Firebase(st)
                if (!old.isNullOrEmpty() && old != tok) try { fb.delete("FCM/${st.pushUid ?: uid}/$old") } catch (_: Exception) {}
                fb.put("FCM/$uid/$tok", "\"android\"")
                st.pushToken = tok; st.pushUid = uid; st.pushOk = "$uid|$tok"
                NotifyService.recheck(app)                   // the live connection (if any) can stop now
            } catch (_: Exception) { /* tried again next time the page hands over the session */ }
        }.start()
    }

    /** Sign-out: stop pushes for this account. Needs a valid session, so call it before [Store.forget]. */
    fun unregister(ctx: Context) {
        val st = Store(ctx.applicationContext)
        val uid = st.pushUid ?: st.uid; val tok = st.pushToken
        if (uid == null || tok.isNullOrEmpty() || !st.signedIn || Config.privateServer.isNotEmpty()) return
        val fb = Firebase(st)
        try { fb.token() } catch (_: Exception) { return }       // cached for the delete below, which runs after the session is forgotten
        Thread { try { fb.delete("FCM/$uid/$tok") } catch (_: Exception) {} }.start()
        try { if (available(ctx)) FirebaseMessaging.getInstance().deleteToken() } catch (_: Throwable) {}
    }
}

class PushService : FirebaseMessagingService() {
    override fun onNewToken(token: String) { Push.save(applicationContext, token) }

    override fun onMessageReceived(m: RemoteMessage) {
        val d = m.data
        val st = Store(applicationContext)
        if (!st.signedIn || !st.notify || d["type"].isNullOrEmpty()) return
        // Hand over to the service (allowed from the background because this is a high priority push). If the system refuses, do the work right here.
        try { NotifyService.push(applicationContext, HashMap(d)) } catch (_: Exception) { /* the system refused to start the service; the next push or opening the app catches up */ }
    }
}
