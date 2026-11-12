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

    /** A plain notification built only from the push's own data (no database, no service): used when the service can't start or the database can't be reached. */
    fun fallback(ctx: Context, d: Map<String, String>) {
        try {
            val chat = d["chatId"].orEmpty(); if (chat.isEmpty()) return
            val nm = ctx.getSystemService(android.content.Context.NOTIFICATION_SERVICE) as android.app.NotificationManager
            if (android.os.Build.VERSION.SDK_INT >= 26) nm.createNotificationChannel(android.app.NotificationChannel("messages", "Messages", android.app.NotificationManager.IMPORTANCE_HIGH))
            val open = Intent(ctx, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP).putExtra(MainActivity.EXTRA_CHAT, chat)
            val pi = android.app.PendingIntent.getActivity(ctx, chat.hashCode(), open, android.app.PendingIntent.FLAG_UPDATE_CURRENT or android.app.PendingIntent.FLAG_IMMUTABLE)
            @Suppress("DEPRECATION")
            val b = if (android.os.Build.VERSION.SDK_INT >= 26) android.app.Notification.Builder(ctx, "messages") else android.app.Notification.Builder(ctx)
            val title = d["title"].orEmpty().ifBlank { "QuickMessage" }; val body = d["body"].orEmpty().ifBlank { "New message" }
            b.setSmallIcon(android.R.drawable.stat_notify_chat).setContentTitle(title).setContentText(body).setStyle(android.app.Notification.BigTextStyle().bigText(body))
                .setContentIntent(pi).setAutoCancel(true).setCategory(android.app.Notification.CATEGORY_MESSAGE).setWhen(System.currentTimeMillis())
            nm.notify(chat.hashCode(), b.build())          // same id as the full notification, which replaces this one when the service gets to run
            Diag.add(ctx, "msg", chat, "fallback notification shown")
        } catch (e: Exception) { Diag.add(ctx, "msg", d["chatId"].orEmpty(), "fallback failed: ${e.javaClass.simpleName}") }
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
        // What actually arrived (shown in Settings → Calls & notifications → "Recent pushes on this device"): how late it was, and whether the system
        // had already demoted it from high to normal priority (a demoted push is delivered late and may not be allowed to start the service).
        val late = if (m.sentTime > 0) ((System.currentTimeMillis() - m.sentTime) / 1000).toString() + "s late" else "?"
        Diag.add(applicationContext, d["type"] ?: "?", d["chatId"] ?: "", "received · $late · priority ${m.priority}/${m.originalPriority}")
        if (!st.signedIn || !st.notify || d["type"].isNullOrEmpty()) { Diag.add(applicationContext, d["type"] ?: "?", d["chatId"] ?: "", "ignored (signed out or notifications off)"); return }
        // Hand over to the service (allowed from the background because this is a high priority push).
        // If the system refuses, show the notification right here from what the push carries; opening the app catches up on the rest.
        try { NotifyService.push(applicationContext, HashMap(d)) }
        catch (e: Exception) {
            Diag.add(applicationContext, d["type"] ?: "?", d["chatId"] ?: "", "service refused: ${e.javaClass.simpleName} → showing it directly")
            if (d["type"] == "msg") Push.fallback(applicationContext, d)
        }
    }
}

/** A short log of what push did on this device (the last 20 events), read by the Settings page to explain missing or late notifications. */
object Diag {
    private const val KEY = "pdiag"
    @Synchronized fun add(ctx: Context, type: String, chat: String, what: String) {
        try {
            val sp = ctx.getSharedPreferences("quickmessage", Context.MODE_PRIVATE)
            val arr = org.json.JSONArray(sp.getString(KEY, "[]"))
            val out = org.json.JSONArray()
            val start = maxOf(0, arr.length() - 19)
            for (i in start until arr.length()) out.put(arr.get(i))
            out.put(JSONObject().put("t", System.currentTimeMillis()).put("type", type).put("chat", chat.take(12)).put("what", what))
            sp.edit().putString(KEY, out.toString()).apply()
        } catch (_: Exception) { /* diagnostics only */ }
    }
    fun json(ctx: Context): String = ctx.getSharedPreferences("quickmessage", Context.MODE_PRIVATE).getString(KEY, "[]") ?: "[]"
}
