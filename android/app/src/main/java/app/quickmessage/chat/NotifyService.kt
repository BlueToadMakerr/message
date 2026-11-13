package app.quickmessage.chat

import android.app.*
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import org.json.JSONObject
import java.util.concurrent.ConcurrentHashMap

/**
 * Native notifications, independent of the page being open (a WebView can't receive web push reliably):
 *   - incoming calls: a full-screen alert (live/{you}/rings) that opens the app on the call
 *   - new messages: a notification per chat, woken by a ping at live/{you}/pings, only while the app isn't on screen
 * It talks to the database directly with the signed-in account's token, handed over by the website (js/app-bridge.js).
 */
class NotifyService : Service() {
    companion object {
        private const val CH_RUN = "run"
        private const val CH_MSG = "messages"
        private const val CH_CALL = "calls2"
        private const val ACT_REPLY = "app.quickmessage.REPLY"
        const val ACT_DECLINE = "app.quickmessage.DECLINE"
        private const val ACT_READ = "app.quickmessage.READ"
        private const val ACT_PUSH = "app.quickmessage.PUSH"
        private const val ACT_SYNC = "app.quickmessage.SYNC"
        private const val KEY_REPLY = "reply"
        private const val ID_FG = 1
        private const val MAX_CHATS = 40

        @Volatile var inCall = false
        @Volatile var callTitle = ""
        @Volatile var callWho = ""
        @Volatile var callMuted = false
        @Volatile var callScreen = false
        @Volatile var callCanScreen = false
        @Volatile var callStart = 0L
        @Volatile var callPhoto = ""
        @Volatile var callBmp: android.graphics.Bitmap? = null
        @Volatile var callDeaf = false
        @Volatile var callUseDeaf = false          // the notification's 3rd button is "Deafen" instead of "Share screen" (Android allows 3 buttons, one is taken by Hang up)
        private const val ACT_DEAF = "app.quickmessage.CALL_DEAF"
        private const val ACT_SCREEN = "app.quickmessage.CALL_SCREEN"
        const val ACT_MIC = "app.quickmessage.CALL_MIC"
        const val ACT_HANGUP = "app.quickmessage.CALL_HANGUP"

        /** The call page reports its name and mic / screen-share state; the ongoing-call notification follows it. */
        fun setCallInfo(ctx: Context, title: String, muted: Boolean, screen: Boolean, canScreen: Boolean, photo: String, startMs: Long) {
            if (title == callTitle && muted == callMuted && screen == callScreen && canScreen == callCanScreen && photo == callPhoto && startMs == callStart) return
            val photoChanged = photo != callPhoto || title != callTitle
            callTitle = title; callMuted = muted; callScreen = screen; callCanScreen = canScreen; callStart = startMs; callPhoto = photo
            val refresh = { if (inCall) { val i = Intent(ctx, NotifyService::class.java).putExtra("call", true)
                try { if (Build.VERSION.SDK_INT >= 26) ctx.startForegroundService(i) else ctx.startService(i) } catch (_: Exception) {} } }
            // load the picture even if the call-state flag hasn't arrived yet (the two bridge calls can come in either order)
            if (photoChanged || callBmp == null) Thread { callBmp = Avatars.load(photo.ifBlank { null }, title.ifBlank { "Call" }); refresh() }.start() else refresh()
        }

        /** Group calls: the names of the people in the call, shown instead of the default "Ongoing call" text. */
        fun setCallWho(ctx: Context, who: String) {
            if (who == callWho) return
            callWho = who
            if (inCall) { val i = Intent(ctx, NotifyService::class.java).putExtra("call", true)
                try { if (Build.VERSION.SDK_INT >= 26) ctx.startForegroundService(i) else ctx.startService(i) } catch (_: Exception) {} }
        }

        fun setCallDeaf(ctx: Context, deaf: Boolean, useDeaf: Boolean) {
            if (deaf == callDeaf && useDeaf == callUseDeaf) return
            callDeaf = deaf; callUseDeaf = useDeaf
            if (inCall) { val i = Intent(ctx, NotifyService::class.java).putExtra("call", true)
                try { if (Build.VERSION.SDK_INT >= 26) ctx.startForegroundService(i) else ctx.startService(i) } catch (_: Exception) {} }
        }

        /** Tells the service a call is up, so it can hold the camera/microphone foreground types (Android blocks background capture otherwise). */
        fun setCall(ctx: Context, on: Boolean) {
            inCall = on
            if (on) Telecomm.active(ctx, callTitle) else Telecomm.end(null, rejected = false)       // the system's call list (and Android Auto) follow the call
            if (!on) { callBmp = null; callPhoto = ""; callTitle = ""; callWho = "" }
            else if (callBmp == null && callTitle.isNotBlank()) Thread { callBmp = Avatars.load(callPhoto.ifBlank { null }, callTitle); setCall(ctx, true) }.start()
            val i = Intent(ctx, NotifyService::class.java).putExtra("call", on)
            try { if (Build.VERSION.SDK_INT >= 26) ctx.startForegroundService(i) else ctx.startService(i) } catch (_: Exception) {}
        }

        // ---- uploads: the page reports how many files are being uploaded; the ongoing notification shows the progress, so the app can be closed meanwhile
        @Volatile var uploadCount = 0
        @Volatile var uploadPct = -1          // 0..100, or -1 when the progress can't be measured
        @Volatile var uploadText = ""

        // Several pages can upload at once: the page in front, and one that was closed with the app but is still uploading in the background (MainActivity "headless").
        // Each reports under its own [source]; the notification adds them up.
        private val upSources = java.util.concurrent.ConcurrentHashMap<Int, Triple<Int, Int, String>>()      // source -> (files, percent or -1, names)
        fun uploadsFrom(source: Int): Int = upSources[source]?.first ?: 0

        /** A page reports its running uploads (count 0 = none left). */
        fun setUploads(ctx: Context, source: Int, count: Int, pct: Int, text: String) {
            if (count <= 0) upSources.remove(source) else upSources[source] = Triple(count, pct, text)
            var n = 0; var sum = 0; var known = 0; var names = ""
            for (v in upSources.values) { n += v.first; if (v.second >= 0) { sum += v.second * v.first; known += v.first }; if (names.isEmpty()) names = v.third }
            val p = if (n > 0 && known == n) sum / n else -1
            if (n == uploadCount && p == uploadPct && names == uploadText) return
            val was = uploadCount
            uploadCount = n; uploadPct = p; uploadText = names
            if (uploadCount == 0 && was == 0) return
            val i = Intent(ctx, NotifyService::class.java)
            try { if (Build.VERSION.SDK_INT >= 26) ctx.startForegroundService(i) else ctx.startService(i) } catch (_: Exception) {}
        }

        /** An upload failed: a normal notification that opens the app (where the message shows Retry). */
        fun uploadFailed(ctx: Context, text: String) {
            try {
                val nm = ctx.getSystemService(NOTIFICATION_SERVICE) as NotificationManager
                if (Build.VERSION.SDK_INT >= 26) nm.createNotificationChannel(NotificationChannel(CH_MSG, "Messages", NotificationManager.IMPORTANCE_HIGH))
                val pi = PendingIntent.getActivity(ctx, 920, Intent(ctx, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP), PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
                @Suppress("DEPRECATION")
                val b = if (Build.VERSION.SDK_INT >= 26) Notification.Builder(ctx, CH_MSG) else Notification.Builder(ctx)
                b.setSmallIcon(android.R.drawable.stat_notify_error).setContentTitle("Upload failed").setContentText(text.ifBlank { "A file couldn't be sent." })
                    .setStyle(Notification.BigTextStyle().bigText(text.ifBlank { "A file couldn't be sent." })).setContentIntent(pi).setAutoCancel(true)
                nm.notify("upload-failed", (System.currentTimeMillis() % 100000).toInt() + 3000, b.build())
            } catch (_: Exception) { /* ignore */ }
        }

        @Volatile var instance: NotifyService? = null

        /** A push arrived (see [Push]): wake the service, which fetches what it needs and shows the notification. */
        fun push(ctx: Context, data: HashMap<String, String>) {
            val i = Intent(ctx, NotifyService::class.java).setAction(ACT_PUSH)
            for ((k, v) in data) i.putExtra("d_$k", v)
            if (Build.VERSION.SDK_INT >= 26) ctx.startForegroundService(i) else ctx.startService(i)
        }

        /** The page sent / read something in [chat] (null = the app was just left): refresh its notification (and bubble) so it matches the database. */
        fun sync(ctx: Context, chat: String?) {
            val st = Store(ctx)
            if (!st.signedIn || !st.notify) return
            // nothing to refresh unless a notification / bubble of this chat (or any chat) is showing: don't wake the service for nothing
            try {
                val nmgr = ctx.getSystemService(NOTIFICATION_SERVICE) as NotificationManager
                val any = if (chat != null) nmgr.activeNotifications.any { it.id == chat.hashCode() } else nmgr.activeNotifications.any { it.notification.extras.getString("qm_chat") != null }
                if (!any) return
            } catch (_: Exception) { return }
            val i = Intent(ctx, NotifyService::class.java).setAction(ACT_SYNC)
            if (chat != null) i.putExtra("chat", chat)
            try { if (Build.VERSION.SDK_INT >= 26) ctx.startForegroundService(i) else ctx.startService(i) } catch (_: Exception) {}
        }

        /** Push has just become usable (token saved): a running live connection can end. */
        fun recheck(ctx: Context) { instance?.applyMode() }

        fun start(ctx: Context) {
            val st = Store(ctx)
            if (!st.signedIn || (!st.notify && !inCall)) return
            if (!inCall && uploadCount == 0 && Push.active(ctx, st)) { instance?.applyMode(); return }      // push does the waking: nothing to keep running
            val i = Intent(ctx, NotifyService::class.java)
            try { if (Build.VERSION.SDK_INT >= 26) ctx.startForegroundService(i) else ctx.startService(i) } catch (_: Exception) {}
        }
        fun stop(ctx: Context) { ctx.stopService(Intent(ctx, NotifyService::class.java)); cancelAll(ctx, keepBubbles = false) }
        /** Clears notifications (when the app opens). Chats that are showing as bubbles stay: opening the app must not close them. */
        fun cancelAll(ctx: Context, keepBubbles: Boolean = true) {
            val nm = ctx.getSystemService(NOTIFICATION_SERVICE) as NotificationManager
            if (!keepBubbles || Build.VERSION.SDK_INT < 29) { nm.cancelAll(); return }
            try {
                for (sbn in nm.activeNotifications) {
                    if (sbn.id == ID_FG) continue
                    if (sbn.notification.bubbleMetadata == null) nm.cancel(sbn.tag, sbn.id)
                }
            } catch (_: Exception) { nm.cancelAll() }
        }
    }

    @Volatile private var running = false
    private var wake: android.os.PowerManager.WakeLock? = null
    private lateinit var store: Store
    private lateinit var fb: Firebase
    private val names = ConcurrentHashMap<String, String>()
    private val seenRings = HashSet<String>()
    private class Msg(val id: String, val text: String, val ts: Long, val from: String?)   // from == null → me
    private val history = ConcurrentHashMap<String, MutableList<Msg>>()
    private val titles = ConcurrentHashMap<String, String>()
    private val personBmp = ConcurrentHashMap<String, android.graphics.Bitmap>()    // uid -> round profile picture
    private val chatBmp = ConcurrentHashMap<String, android.graphics.Bitmap>()      // chat -> picture shown on the notification / bubble
    private val chatLabel = ConcurrentHashMap<String, String>()                     // chat -> name shown on the bubble
    private val chatSq = ConcurrentHashMap<String, android.graphics.Bitmap>()       // chat -> full-bleed square picture (bubble icon)
    private val pfpUrl = ConcurrentHashMap<String, String>()
    private val chatGroup = ConcurrentHashMap<String, Boolean>()

    /** Loads (once) a member's name and picture. Network: never call on the main thread. */
    private fun ensurePerson(uid: String) {
        if (personBmp.containsKey(uid)) return
        val pfp = try { fb.get("accsettings/$uid/settings/pfp") as? String } catch (_: Exception) { null }
        if (!pfp.isNullOrBlank()) pfpUrl[uid] = pfp
        personBmp[uid] = Avatars.load(pfp, nameOf(uid))
    }
    private fun personOf(uid: String): android.app.Person {
        val b = android.app.Person.Builder().setName(nameOf(uid))
        personBmp[uid]?.let { b.setIcon(android.graphics.drawable.Icon.createWithBitmap(it)) }
        return b.build()
    }
    /** Picture of a chat: the group photo; else the other person's photo (1:1); else a letter. */
    private fun ensureChatLook(chatId: String, titleIn: String) {
        val me = store.uid ?: return
        val title = titleIn.ifBlank { try { (fb.get("privateChats/$chatId/chatData/name") as? String).orEmpty() } catch (_: Exception) { "" } }
        val parts = try { (fb.get("privateChats/$chatId/participants") as? JSONObject)?.keys()?.asSequence()?.toList() } catch (_: Exception) { null } ?: emptyList()
        val others = parts.filter { it != me }
        val photo = try { (fb.get("privateChats/$chatId/chatData/photo") as? String)?.takeIf { it.isNotBlank() } } catch (_: Exception) { null }
        val label: String; val url: String?
        if (others.size == 1 && title.isBlank()) {
            ensurePerson(others[0])
            label = nameOf(others[0]); url = photo ?: pfpUrl[others[0]]
        } else {
            label = title.ifBlank { "Group chat" }; url = photo
        }
        chatBmp[chatId] = Avatars.load(url, label)
        chatSq[chatId] = Avatars.load(url, label, 432, round = false)
        chatLabel[chatId] = label
        chatGroup[chatId] = !(others.size == 1 && title.isBlank())
        if (title.isNotBlank()) titles[chatId] = title                 // a freshly woken service doesn't know the group's name until now: without this the rebuilt notification lost it
    }

    override fun onBind(i: Intent?): IBinder? = null
    private fun ic(res: Int) = android.graphics.drawable.Icon.createWithResource(this, res)
    private fun nm() = getSystemService(NOTIFICATION_SERVICE) as NotificationManager

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        store = Store(this)
        fb = Firebase(store)
        when (intent?.action) {
            ACT_PUSH -> { foreground(); holdWake(); handlePush(intent); return START_NOT_STICKY }
            ACT_SYNC -> { foreground(); holdWake(); handleSync(intent); return START_NOT_STICKY }
            ACT_REPLY -> { handleReply(intent); scheduleIdle(30_000); return if (pushMode()) START_NOT_STICKY else START_STICKY }
            ACT_DECLINE -> { handleDecline(intent); scheduleIdle(30_000); return if (pushMode()) START_NOT_STICKY else START_STICKY }
            ACT_READ -> { handleRead(intent); scheduleIdle(30_000); return if (pushMode()) START_NOT_STICKY else START_STICKY }
            ACT_MIC -> { MainActivity.instance?.runJs("window.QM&&QM.toggleMute&&QM.toggleMute()"); return START_STICKY }
            ACT_HANGUP -> { MainActivity.instance?.runJs("window.QM&&QM.hangup&&QM.hangup()"); return START_STICKY }
            ACT_SCREEN -> { MainActivity.instance?.runJs("window.QM&&QM.toggleScreen&&QM.toggleScreen()"); return START_STICKY }
            ACT_DEAF -> { MainActivity.instance?.runJs("window.QM&&QM.toggleDeafen&&QM.toggleDeafen()"); return START_STICKY }
        }
        if (intent?.hasExtra("call") == true) inCall = intent.getBooleanExtra("call", false)
        if (!store.signedIn && !inCall) { stopSelf(); return START_NOT_STICKY }
        fb = Firebase(store)
        foreground()
        holdWake()
        if (!inCall && uploadCount == 0 && busy.get() == 0 && (!store.notify || pushMode())) { running = false; stopForeground(STOP_FOREGROUND_REMOVE); releaseWake(); stopSelf(); return START_NOT_STICKY }
        // With push working there is no standing connection at all. The live stream + polling below are the fallback for builds without
        // google-services.json, private servers, phones without Google Play services, or until the push token is registered.
        if (!running && store.signedIn && store.notify && !pushMode()) {
            running = true
            Thread({ liveLoop() }, "live").start()
            Thread({ pollLoop() }, "poll").start()
        }
        return START_STICKY
    }

    // Live-connection fallback: keeps the CPU awake so the stream keeps running with the screen off. With push, the lock is held only while a push is handled.
    private fun holdWake() {
        if (wake == null) wake = (getSystemService(POWER_SERVICE) as android.os.PowerManager).newWakeLock(android.os.PowerManager.PARTIAL_WAKE_LOCK, "quickmessage:listen").also { it.setReferenceCounted(false) }
        val w = wake ?: return
        if (pushMode() && !inCall) w.acquire(30_000) else if (!w.isHeld) w.acquire()
    }
    private fun releaseWake() { try { if (wake?.isHeld == true) wake?.release() } catch (_: Exception) {} }

    private fun pushMode() = ::store.isInitialized && Push.active(this, store)
    private val busy = java.util.concurrent.atomic.AtomicInteger(0)
    private val idleH by lazy { android.os.Handler(mainLooper) }

    /** Push mode: when nothing is being handled, no call and no upload, stop the service (and its notification) until the next push. */
    private fun scheduleIdle(ms: Long) { idleH.removeCallbacks(idleCheck); idleH.postDelayed(idleCheck, ms) }
    private val idleCheck = Runnable {
        if (busy.get() == 0 && pushMode() && !inCall && uploadCount == 0) { running = false; try { stopForeground(STOP_FOREGROUND_REMOVE) } catch (_: Exception) {}; releaseWake(); stopSelf() }
        else if (busy.get() > 0) scheduleIdle(5_000)
    }
    /** Called when push becomes usable while the live connection is running: let the connection end. */
    fun applyMode() { if (pushMode() && !inCall && uploadCount == 0) { running = false; scheduleIdle(500) } }

    private fun work(body: () -> Unit) {
        busy.incrementAndGet()
        Thread {
            try { body() } catch (_: Exception) {}
            finally { busy.decrementAndGet(); if (pushMode()) scheduleIdle(4_000) }
        }.start()
    }

    override fun onCreate() { super.onCreate(); instance = this }
    override fun onDestroy() { releaseWake(); running = false; if (instance === this) instance = null; super.onDestroy() }

    @Suppress("DEPRECATION")
    private fun builder(ch: String) = if (Build.VERSION.SDK_INT >= 26) Notification.Builder(this, ch) else Notification.Builder(this)

    private fun foreground() {
        if (Build.VERSION.SDK_INT >= 26) {
            nm().createNotificationChannel(NotificationChannel(CH_RUN, "Running in background", NotificationManager.IMPORTANCE_MIN))
            nm().createNotificationChannel(NotificationChannel(CH_MSG, "Messages", NotificationManager.IMPORTANCE_HIGH))
            nm().deleteNotificationChannel("calls")
            nm().createNotificationChannel(NotificationChannel(CH_CALL, "Incoming calls", NotificationManager.IMPORTANCE_HIGH).apply {
                lockscreenVisibility = Notification.VISIBILITY_PUBLIC; enableVibration(true)
                vibrationPattern = longArrayOf(0, 800, 600, 800, 600)
                setSound(android.media.RingtoneManager.getDefaultUri(android.media.RingtoneManager.TYPE_RINGTONE),
                    android.media.AudioAttributes.Builder().setUsage(android.media.AudioAttributes.USAGE_NOTIFICATION_RINGTONE).setContentType(android.media.AudioAttributes.CONTENT_TYPE_SONIFICATION).build())
                setBypassDnd(true) })
        }
        // in a call the status-bar icon is the same mic / screen-share icon as in the web interface (crossed out when muted)
        val uploading = uploadCount > 0 && !inCall
        val small = if (uploading) android.R.drawable.stat_sys_upload else if (inCall) (if (callDeaf) R.drawable.ic_headphones_off else if (callScreen) R.drawable.ic_screen else if (callMuted) R.drawable.ic_mic_off else R.drawable.ic_mic) else android.R.drawable.stat_notify_chat
        val b = builder(CH_RUN).setSmallIcon(small).setOngoing(true).setContentIntent(open(null, false, 0))
        if (inCall) {
            // An ongoing call shows like a call: who it is, how long, and mic / screen share / hang up right from the notification.
            val svc = { act: String, rq: Int -> PendingIntent.getService(this, rq, Intent(this, NotifyService::class.java).setAction(act), PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE) }
            val hang = svc(ACT_HANGUP, 910)
            val mic = svc(ACT_MIC, 911)
            val screenI = if (callScreen) svc(ACT_SCREEN, 912)   // stop: no prompt needed
                else PendingIntent.getActivity(this, 912, Intent(this, ScreenShareActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_NO_ANIMATION), PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)   // start: a small invisible activity shows the system prompt, the app stays where it is
            val title = callTitle.ifBlank { "In a call" }
            b.setCategory(Notification.CATEGORY_CALL).setUsesChronometer(true).setWhen(if (callStart > 0) callStart else System.currentTimeMillis()).setVisibility(Notification.VISIBILITY_PUBLIC)
            b.addAction(Notification.Action.Builder(ic(if (callMuted) R.drawable.ic_mic_off else R.drawable.ic_mic), if (callMuted) "Unmute" else "Mute", mic).build())
            if (callUseDeaf) b.addAction(Notification.Action.Builder(ic(if (callDeaf) R.drawable.ic_headphones_off else R.drawable.ic_headphones), if (callDeaf) "Undeafen" else "Deafen", svc(ACT_DEAF, 913)).build())
            else if (callCanScreen) b.addAction(Notification.Action.Builder(ic(if (callScreen) R.drawable.ic_screen_off else R.drawable.ic_screen), if (callScreen) "Stop sharing" else "Share screen", screenI).build())
            if (callDeaf) b.setSubText("Deafened")                 // together with the headphones status icon
            if (Build.VERSION.SDK_INT >= 31) {
                b.setStyle(Notification.CallStyle.forOngoingCall(android.app.Person.Builder().setName(title).setImportant(true).apply { callBmp?.let { setIcon(android.graphics.drawable.Icon.createWithBitmap(it)) } }.build(), hang))
                callBmp?.let { b.setLargeIcon(it) }
                if (callWho.isNotBlank()) b.setContentText(callWho)      // replaces the system's default "Ongoing call" line
            } else {
                b.setContentTitle(title).setContentText(callWho.ifBlank { "Ongoing call" }).addAction(Notification.Action.Builder(ic(android.R.drawable.ic_menu_close_clear_cancel), "Hang up", hang).build())
            }
        } else if (uploading) {
            b.setContentTitle(if (uploadCount == 1) "Uploading a file" else "Uploading $uploadCount files").setContentText(uploadText.ifBlank { "Keep going in the background" }).setOnlyAlertOnce(true)
            if (uploadPct >= 0) b.setProgress(100, uploadPct.coerceIn(0, 100), false) else b.setProgress(0, 0, true)
        } else if (pushMode()) b.setContentTitle("QuickMessage").setContentText("Checking for new messages…")
        else b.setContentTitle("QuickMessage").setContentText("Listening for messages and calls")
        val n = b.build()
        if (Build.VERSION.SDK_INT >= 34) {
            var t = ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE
            if (inCall) {   // keep the call's microphone/camera alive while the app is in the background
                if (checkSelfPermission(android.Manifest.permission.RECORD_AUDIO) == android.content.pm.PackageManager.PERMISSION_GRANTED) t = t or ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE
                if (checkSelfPermission(android.Manifest.permission.CAMERA) == android.content.pm.PackageManager.PERMISSION_GRANTED) t = t or ServiceInfo.FOREGROUND_SERVICE_TYPE_CAMERA
            }
            try { startForeground(ID_FG, n, t) } catch (e: Exception) { startForeground(ID_FG, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE) }
        } else startForeground(ID_FG, n)
    }

    private fun open(chat: String?, ring: Boolean, req: Int, answer: Boolean = false): PendingIntent {
        val i = Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
        if (chat != null) i.putExtra(MainActivity.EXTRA_CHAT, chat)
        if (ring) i.putExtra(MainActivity.EXTRA_RING, true)
        if (answer) i.putExtra(MainActivity.EXTRA_ANSWER, true)
        return PendingIntent.getActivity(this, req, i, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
    }

    /** A person's display name. A failed lookup shows "Someone" this once but is NOT remembered (it used to be, so one hiccup meant "Someone" for good). */
    private fun nameOf(uid: String): String {
        names[uid]?.let { return it }
        val n = try { (fb.get("accsettings/$uid/settings/displayName") as? String)?.takeIf { it.isNotBlank() } } catch (_: Exception) { null }
        if (n != null) names[uid] = n
        return n ?: "Someone"
    }

    private fun nap(ms: Long): Boolean = try { Thread.sleep(ms); true } catch (_: InterruptedException) { false }

    /** Runs [body] again (with a growing pause) whenever the stream ends or fails; stops when the service stops or we sign out. */
    private fun forever(body: () -> Unit) {
        var backoff = 2000L
        while (running && store.signedIn && store.notify && !pushMode()) {
            try { body(); backoff = 2000L }
            catch (e: ApiException) { if (e.code == 401 || e.code == 403) backoff = 60_000L }
            catch (_: Exception) {}
            if (!nap(backoff)) return
            backoff = (backoff * 2).coerceAtMost(60_000L)
        }
    }

    // ------------------------------------------------------------------ incoming calls
    // ONE stream (live/{you}) carries both rings and "new message" pings. It is the app's only background database connection.
    private fun liveLoop() = forever {
        val me = store.uid ?: return@forever
        var primed = false
        fb.stream("live/$me", { running }) { _, path, data ->
            val parts = path.trim('/').split('/').filter { it.isNotEmpty() }
            if (parts.isEmpty()) {                                       // the first event: everything that is there right now
                val o = data as? JSONObject
                o?.optJSONObject("rings")?.let { r -> r.keys().forEach { k -> r.optJSONObject(k)?.let { ring(k, it) } } }
                o?.optJSONObject("pings")?.let { pg -> pg.keys().forEach { k -> pg.optJSONObject(k)?.let { ping(k, it, first = true) } } }
                o?.optJSONObject("declines")?.let { d -> d.keys().forEach { k -> d.optJSONObject(k)?.let { declined(k, it) } } }
                primed = true
                return@stream
            }
            when (parts[0]) {
                "rings" -> when {
                    parts.size == 1 && data is JSONObject -> data.keys().forEach { k -> data.optJSONObject(k)?.let { ring(k, it) } }
                    parts.size == 2 && data is JSONObject -> ring(parts[1], data)
                    parts.size == 2 && data == null -> nm().cancel(("ring" + parts[1]).hashCode())
                }
                "declines" -> when {
                    parts.size == 1 && data is JSONObject -> data.keys().forEach { k -> data.optJSONObject(k)?.let { declined(k, it) } }
                    parts.size == 2 && data is JSONObject -> declined(parts[1], data)
                }
                "pings" -> when {
                    parts.size == 1 && data is JSONObject -> data.keys().forEach { k -> data.optJSONObject(k)?.let { ping(k, it, first = !primed) } }
                    parts.size == 2 && data is JSONObject -> ping(parts[1], data, first = false)
                }
            }
        }
    }

    private val baselines = ConcurrentHashMap<String, String>()
    private val encChats = ConcurrentHashMap<String, Boolean>()

    /** A ping says "chat X has a newer message"; the text itself is fetched with one plain request (not a connection). */
    private fun ping(chatId: String, p: JSONObject, first: Boolean) {
        val id = p.optString("id")
        if (id.isEmpty() || baselines[chatId] == id) return
        if (first && baselines[chatId] == null) { baselines[chatId] = id; return }     // what was already there when we connected
        if (p.optString("from") == store.uid || MainActivity.visible) { baselines[chatId] = id; return }
        Thread {
            try { (fb.get("privateChats/$chatId/lastMessage") as? JSONObject)?.let { consider(chatId, it, false) } } catch (_: Exception) {}
        }.start()
    }

    /** Shows a notification for [m] unless it is already known / mine / the app is on screen. */
    @Synchronized private fun consider(chatId: String, m: JSONObject, first: Boolean) {
        val id = m.optString("id")
        if (id.isEmpty() || baselines[chatId] == id) return
        val old = baselines.put(chatId, id)
        if (first && old == null) return
        try { message(chatId, m) } catch (e: Exception) { if (old == null) baselines.remove(chatId) else baselines[chatId] = old; throw e }      // a failed attempt must not count as handled
    }

    // Safety net next to the live stream (plain requests, not connections): every so often look at each chat's newest message, so a
    // missed or never-sent ping can't mean a missed notification.
    private fun pollLoop() {
        var first = true
        while (running && store.signedIn && store.notify && !pushMode()) {
            if (!MainActivity.visible) {
                try {
                    val me = store.uid ?: return
                    // ONE small request for everything (rings + one "newest message" marker per chat) instead of one request per chat
                    val live = fb.get("live/$me") as? JSONObject
                    live?.optJSONObject("rings")?.let { r -> r.keys().forEach { k -> r.optJSONObject(k)?.let { ring(k, it) } } }
                    live?.optJSONObject("pings")?.let { pg -> pg.keys().forEach { k -> pg.optJSONObject(k)?.let { ping(k, it, first) } } }
                    first = false
                } catch (_: Exception) {}
            }
            if (!nap(if (inCall) 120_000L else 60_000L)) return
        }
    }

    private fun ring(chatId: String, r: JSONObject) {
        if (!store.notify) return
        val me = store.uid ?: return
        val id = r.optString("ringId"); val from = r.optString("fromUid")
        if (id.isEmpty() || from == me || !seenRings.add(id)) return
        if (System.currentTimeMillis() - r.optLong("createdAt", 0) > 90_000) return     // an old ring left behind
        if (MainActivity.visible) return                                                // the page shows its own call overlay
        if (mutedNow(chatId, "c")) return
        val who = nameOf(from)
        try { ensurePerson(from); ensureChatLook(chatId, "") } catch (_: Exception) {}
        val rid = ("ring$chatId").hashCode()
        val pi = open(chatId, true, rid)
        val answer = open(chatId, true, rid + 1, answer = true)
        val decline = PendingIntent.getService(this, rid + 2, Intent(this, NotifyService::class.java).setAction(ACT_DECLINE).putExtra("chat", chatId),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
        val b = builder(CH_CALL).setSmallIcon(android.R.drawable.sym_action_call).setCategory(Notification.CATEGORY_CALL)
            .setPriority(Notification.PRIORITY_MAX).setOngoing(true).setAutoCancel(false).setContentIntent(pi).setFullScreenIntent(pi, true)
            .setTimeoutAfter(60_000).setVisibility(Notification.VISIBILITY_PUBLIC)
        if (Build.VERSION.SDK_INT >= 31) {
            val person = android.app.Person.Builder().setName(if (chatGroup[chatId] == true) "$who · ${chatLabel[chatId]}" else who).setImportant(true).apply { (chatBmp[chatId] ?: personBmp[from])?.let { setIcon(android.graphics.drawable.Icon.createWithBitmap(it)) } }.build()
            b.setStyle(Notification.CallStyle.forIncomingCall(person, decline, answer))
        } else {
            b.setContentTitle("Incoming call").setContentText("$who is calling you")
                .addAction(Notification.Action.Builder(ic(android.R.drawable.ic_menu_close_clear_cancel), "Decline", decline).build())
                .addAction(Notification.Action.Builder(ic(android.R.drawable.ic_menu_call), "Answer", answer).build())
            chatBmp[chatId]?.let { b.setLargeIcon(it) }
        }
        val n = b.build()
        n.flags = n.flags or Notification.FLAG_INSISTENT or Notification.FLAG_NO_CLEAR        // the ringtone keeps looping until you act
        nm().notify(rid, n)
        Telecomm.incoming(this, chatId, if (chatGroup[chatId] == true) "$who · ${chatLabel[chatId]}" else who)       // tells the system (and the car) about the call
    }

    private val seenDeclines = java.util.Collections.newSetFromMap(ConcurrentHashMap<String, Boolean>())
    /** "X declined your call": shown on this phone, and the marker is cleared. */
    private fun declined(chatId: String, d: JSONObject) {
        val me = store.uid ?: return
        val by = d.optString("by"); val ts = d.optLong("ts", 0)
        Thread { try { fb.delete("live/$me/declines/$chatId") } catch (_: Exception) {} }.start()
        if (by.isEmpty() || System.currentTimeMillis() - ts > 120_000 || !seenDeclines.add("$chatId:$ts") || !store.notify) return
        Thread {
            try { ensurePerson(by) } catch (_: Exception) {}
            val b = builder(CH_MSG).setSmallIcon(android.R.drawable.sym_call_missed).setCategory(Notification.CATEGORY_STATUS)
                .setContentTitle("Call declined").setContentText("${nameOf(by)} declined your call").setAutoCancel(true)
                .setContentIntent(open(chatId, false, ("decl$chatId").hashCode()))
            personBmp[by]?.let { b.setLargeIcon(it) }
            nm().notify(("decl$chatId").hashCode(), b.build())
        }.start()
    }

    private fun handleDecline(i: Intent) {
        val chat = i.getStringExtra("chat") ?: return
        nm().cancel(("ring$chat").hashCode())
        Telecomm.end(chat, rejected = true)
        val me = store.uid ?: return
        Thread {
            try {
                val from = (fb.get("live/$me/rings/$chat") as? JSONObject)?.optString("fromUid").orEmpty()
                if (from.isNotEmpty() && from != me) {
                    val now = System.currentTimeMillis()
                    try { fb.put("live/$from/declines/$chat", JSONObject().put("by", me).put("chatId", chat).put("ts", now).toString()) } catch (_: Exception) {}
                }
            } catch (_: Exception) {}
            try { fb.delete("live/$me/rings/$chat") } catch (_: Exception) {}
            try { fb.delete("calls/$chat/ringing/$me") } catch (_: Exception) {}
        }.start()
    }

    // ------------------------------------------------------------------ push
    /** A push from the Cloud Function: one short burst of plain requests, then the service goes back to sleep. */
    private fun handlePush(i: Intent) {
        val type = i.getStringExtra("d_type") ?: ""
        val chat = i.getStringExtra("d_chatId") ?: ""
        if (chat.isEmpty() || !store.signedIn || !store.notify) { scheduleIdle(1_000); return }
        work {
            when (type) {
                "ring" -> {
                    val ringId = i.getStringExtra("d_ringId").orEmpty(); val from = (i.getStringExtra("d_fromUid") ?: i.getStringExtra("d_from")).orEmpty()
                    i.getStringExtra("d_name")?.takeIf { it.isNotBlank() && from.isNotEmpty() }?.let { names.putIfAbsent(from, it) }      // the caller's name travels with the push: never "Someone"
                    val created = i.getStringExtra("d_createdAt")?.toLongOrNull() ?: System.currentTimeMillis()
                    // the push is the ring: no need to read it from the database first
                    ring(chat, JSONObject().put("ringId", ringId).put("fromUid", from).put("createdAt", created))
                }
                "msg" -> {
                    // The database can be unreachable for a moment right after the phone wakes (Doze, network not up yet): try a few times, and if it still
                    // can't be reached show what the push itself carries rather than nothing.
                    var ok = false; var lastErr = ""
                    for (a in 0 until 4) {
                        try {
                            val last = fb.get("privateChats/$chat/lastMessage") as? JSONObject
                            if (last != null) consider(chat, last, false)
                            ok = true; break
                        } catch (e: Exception) { lastErr = e.javaClass.simpleName; try { Thread.sleep(1500L * (a + 1)) } catch (_: InterruptedException) {} }
                    }
                    if (!ok) {
                        Diag.add(this, "msg", chat, "retry-failed: $lastErr")
                        Push.fallback(this, i.extras?.keySet()?.associate { it.removePrefix("d_") to (i.getStringExtra(it) ?: "") } ?: emptyMap())
                    } else Diag.add(this, "msg", chat, "handled (shown, or already read / muted)")
                }
            }
        }
    }

    /** The page sent or read something (or the app was left): make the notification / bubble match what the database says now. */
    private fun handleSync(i: Intent) {
        val only = i.getStringExtra("chat")
        work {
            val nmgr = nm()
            val chats = ArrayList<String>()
            if (only != null) chats.add(only)
            else try { for (sbn in nmgr.activeNotifications) sbn.notification.extras.getString("qm_chat")?.let { chats.add(it) } } catch (_: Exception) {}
            for (c in chats.distinct()) {
                // only chats that are showing right now (a notification or bubble): this never creates a new one
                val showing = try { nmgr.activeNotifications.any { it.id == c.hashCode() } } catch (_: Exception) { false }
                if (!showing) continue
                try { settle(c, null) } catch (_: Exception) {}
            }
        }
    }

    // ------------------------------------------------------------------ messages
    /**
     * Rebuilds the thread shown in a chat's notification from the DATABASE (the newest messages, yours included), instead of trusting what
     * earlier notifications happened to add. A missed push, a message that arrived while the app was open, or a reply typed in the app
     * can therefore no longer leave the notification showing a thread that doesn't match the chat.
     * Also refreshes [readIds] from messageRead (what you have marked read, possibly in the app or on another device).
     */
    private fun refreshThread(chatId: String, m: JSONObject?) {
        val me = store.uid ?: return
        val fresh = ArrayList<Msg>()
        try {
            fb.recent("privateChats/$chatId/messages", 14).filter { it.second.optString("type") != "event" }.takeLast(8).forEach { (k, o) ->
                val f = o.optString("fromUid"); fresh.add(Msg(k, textOf(chatId, o), o.optLong("timestamp"), if (f == me) null else f))
            }
        } catch (_: Exception) { return }                         // offline: keep what we have
        val list = history.getOrPut(chatId) { java.util.Collections.synchronizedList(ArrayList<Msg>()) }
        synchronized(list) {
            val pending = list.filter { it.id.startsWith("local") && fresh.none { f -> f.from == null && f.text == it.text } }
            list.clear(); list.addAll(fresh); list.addAll(pending)
            if (m != null) { val id = m.optString("id"); if (id.isNotEmpty() && list.none { it.id == id }) list.add(Msg(id, textOf(chatId, m, preview = true), m.optLong("timestamp", System.currentTimeMillis()), m.optString("fromUid").takeIf { it != me })) }
            while (list.size > 8) list.removeAt(0)
        }
        try { (fb.get("privateChats/$chatId/messageRead/$me") as? String)?.let { readIds[chatId] = it } } catch (_: Exception) {}
    }

    /**
     * After the thread was refreshed: nothing left to answer (you already read the newest message, or the newest message is yours) means the
     * notification goes away, unless it is a bubble, which stays and just shows the up-to-date thread.
     */
    private fun settle(chatId: String, m: JSONObject?): Boolean {
        refreshThread(chatId, m)
        val list = history[chatId] ?: return false
        val newest = synchronized(list) { list.lastOrNull() }
        val lastIncoming = synchronized(list) { list.lastOrNull { it.from != null } }
        val handled = newest == null || newest.from == null || (lastIncoming != null && readIds[chatId] == lastIncoming.id)
        if (!handled) { postMessages(chatId, quiet = true); return false }
        val isBubble = try { nm().activeNotifications.any { it.id == chatId.hashCode() && it.notification.bubbleMetadata != null } } catch (_: Exception) { false }
        if (isBubble) postMessages(chatId, quiet = true) else nm().cancel(chatId.hashCode())
        return true
    }

    /** Notification text for a message. [preview] = the chat's lastMessage (whose encrypted text is the preview itself). */
    private fun textOf(chatId: String, m: JSONObject, preview: Boolean = false): String {
        val locked = "🔒 New message"
        var t = m.optString("text")
        val type = m.optString("type")
        if (m.optBoolean("enc", false)) {
            val key = Crypt.chatKey(fb, store, chatId) ?: return locked        // no key on this phone: the text stays hidden
            if (preview) return Crypt.decrypt(key, chatId, t) ?: run { Crypt.drop(chatId); Crypt.chatKey(fb, store, chatId)?.let { k2 -> Crypt.decrypt(k2, chatId, t) } } ?: locked
            if (type == "event") return "📞 " + (m.optString("event").ifBlank { "Call" })
            if (type == "image" || type == "video" || type == "audio") t = ""
            else {
                val plain = Crypt.decrypt(key, chatId, t) ?: run { Crypt.drop(chatId); Crypt.chatKey(fb, store, chatId)?.let { k2 -> Crypt.decrypt(k2, chatId, t) } } ?: return locked
                t = if (type == "file") (try { JSONObject(plain).optString("name") } catch (_: Exception) { "" }) else plain
            }
        }
        return when (type) {
            "image" -> "📷 Photo"; "video" -> "🎥 Video"; "audio" -> "🎵 Audio"
            "file" -> "📎 " + t.ifBlank { "File" }
            "event" -> "📞 " + t.ifBlank { "Call" }
            else -> t.ifBlank { "Sent an attachment" }
        }
    }

    /** The person muted this chat (messages "m" or calls "c") in its options; stored in the database so it holds on every device. */
    private fun mutedNow(chatId: String, kind: String): Boolean = try {
        val me = store.uid ?: return false
        val mu = fb.get("privateChats/$chatId/mutes/$me") as? JSONObject
        (mu?.optDouble(kind, 0.0) ?: 0.0) > System.currentTimeMillis()
    } catch (_: Exception) { false }

    private fun message(chatId: String, m: JSONObject) {
        if (!store.notify) return
        val me = store.uid ?: return
        val from = m.optString("fromUid")
        if (from == me || MainActivity.visible) return
        if (mutedNow(chatId, "m")) return
        var title = ""
        try {
            val chatName = fb.get("privateChats/$chatId/chatData/name") as? String
            if (!chatName.isNullOrBlank()) title = chatName
        } catch (_: Exception) {}
        titles[chatId] = title
        encChats[chatId] = m.optBoolean("enc", false)
        // The thread comes from the database every time (see refreshThread); if you already read it or answered it somewhere else, no notification.
        refreshThread(chatId, m)
        val list = history[chatId] ?: return
        run {
            val lastIn = synchronized(list) { list.lastOrNull { it.from != null } }
            val newest = synchronized(list) { list.lastOrNull() }
            if (newest != null && (newest.from == null || (lastIn != null && readIds[chatId] == lastIn.id))) { settle(chatId, null); return }
        }
        try {
            ensureChatLook(chatId, title)
            ensurePerson(from)
            store.uid?.let { ensurePerson(it) }
            synchronized(list) { list.mapNotNull { it.from } }.distinct().forEach { ensurePerson(it) }
        } catch (_: Exception) {}
        val id = m.optString("id")
        // a photo is shown big in the notification (decoded here: from the media node, or decrypted when the chat is encrypted)
        if (Build.VERSION.SDK_INT < 28 && !DataSaver.active() && (m.optString("type") == "image" || m.optString("type") == "file")) { val bmp = try { loadImage(chatId, id) } catch (_: Exception) { null }; if (bmp != null) imgBmp[chatId] = bmp else imgBmp.remove(chatId) } else imgBmp.remove(chatId)
        if (list.none { it.id == id }) list.add(Msg(id, textOf(chatId, m, preview = true), m.optLong("timestamp", System.currentTimeMillis()), from))
        while (list.size > 8) list.removeAt(0)
        postMessages(chatId)
    }

    private val imgBmp = ConcurrentHashMap<String, android.graphics.Bitmap>()

    private fun loadImage(chatId: String, id: String): android.graphics.Bitmap? {
        val rec = fb.get("privateChats/$chatId/messages/$id") as? JSONObject ?: return null
        var content = rec.optString("content")
        val isFileImage = rec.optString("type") == "file" && (rec.optString("kind") == "image" || rec.optString("mime").startsWith("image/")) && !rec.optBoolean("enc")
        if (rec.optString("type") != "image" && !isFileImage) return null
        if (isFileImage) content = rec.optString("url").ifBlank { return null }            // an uploaded picture: a link to the file
        else if (rec.optBoolean("big")) content = (fb.get("privateChats/$chatId/media/$id") as? String) ?: return null
        if (rec.optBoolean("enc")) { val key = Crypt.chatKey(fb, store, chatId) ?: return null; content = Crypt.decrypt(key, chatId, content) ?: return null }
        val bytes: ByteArray = when {
            content.startsWith("data:") -> android.util.Base64.decode(content.substringAfter("base64,"), android.util.Base64.DEFAULT)
            content.startsWith("https://") -> (java.net.URL(content).openConnection() as java.net.HttpURLConnection).apply { connectTimeout = 8000; readTimeout = 12000 }.inputStream.use { it.readBytes() }
            else -> return null
        }
        val o = android.graphics.BitmapFactory.Options().apply { inJustDecodeBounds = true }
        android.graphics.BitmapFactory.decodeByteArray(bytes, 0, bytes.size, o)
        var sample = 1
        while (o.outWidth / sample > 1200) sample *= 2
        return android.graphics.BitmapFactory.decodeByteArray(bytes, 0, bytes.size, android.graphics.BitmapFactory.Options().apply { inSampleSize = sample })
    }

    /** chat -> id of the newest message already marked as read (the "Mark as read" button is hidden for it). */
    private val readIds = ConcurrentHashMap<String, String>()

    private val imgUri = ConcurrentHashMap<String, android.net.Uri>()     // message id -> the photo as a content:// link the notification can show inline
    private val imgFail = java.util.Collections.newSetFromMap(ConcurrentHashMap<String, Boolean>())

    /** A photo of the thread saved as a small file, served by [NotifImgProvider]; systemui gets read access to that one link. */
    private fun photoUri(chatId: String, id: String): android.net.Uri? {
        if (id.isEmpty() || imgFail.contains(id)) return null
        return try {
            val dir = java.io.File(cacheDir, "qmimg").apply { mkdirs() }
            val f = java.io.File(dir, id.replace(Regex("[^A-Za-z0-9_-]"), "_") + ".jpg")
            if (!f.exists()) {
                val bmp = loadImage(chatId, id)
                if (bmp == null) { imgFail.add(id); Diag.add(this, "img", chatId, "no picture to show for $id"); return null }
                f.outputStream().use { bmp.compress(android.graphics.Bitmap.CompressFormat.JPEG, 82, it) }
                dir.listFiles()?.sortedByDescending { it.lastModified() }?.drop(30)?.forEach { it.delete() }
            }
            val u = android.net.Uri.parse("content://$packageName.notifimg/${f.name}")
            try { grantUriPermission("com.android.systemui", u, Intent.FLAG_GRANT_READ_URI_PERMISSION) } catch (_: Exception) {}
            u
        } catch (e: Exception) { imgFail.add(id); Diag.add(this, "img", chatId, "failed: ${e.javaClass.simpleName}"); null }
    }

    /** Everything a notification needs (group name, group picture, member pictures). A freshly started service knows none of it, so every rebuild calls this first. */
    private fun ensureLook(chatId: String, list: List<Msg>) {
        try {
            if (!titles.containsKey(chatId)) titles[chatId] = (fb.get("privateChats/$chatId/chatData/name") as? String).orEmpty()
            if (!chatBmp.containsKey(chatId) || !chatLabel.containsKey(chatId)) ensureChatLook(chatId, titles[chatId] ?: "")
            store.uid?.let { ensurePerson(it) }
            list.mapNotNull { it.from }.distinct().forEach { ensurePerson(it) }
        } catch (_: Exception) {}
    }

    private fun postMessages(chatId: String, quiet: Boolean = false) {
        val list = history[chatId] ?: return
        ensureLook(chatId, synchronized(list) { list.toList() })
        if (!DataSaver.active()) synchronized(list) { list.toList() }.filter { it.text == "📷 Photo" }.takeLast(3).forEach { m -> if (!imgUri.containsKey(m.id)) photoUri(chatId, m.id)?.let { imgUri[m.id] = it } }
        val title = titles[chatId] ?: ""
        val last = synchronized(list) { list.lastOrNull { it.from != null } }
        val lastText = last?.text ?: ""
        val b = builder(CH_MSG).setSmallIcon(android.R.drawable.stat_notify_chat).setAutoCancel(false).setCategory(Notification.CATEGORY_MESSAGE)
            .setContentIntent(open(chatId, false, chatId.hashCode())).setOnlyAlertOnce(quiet)
        b.setShowWhen(true).setWhen(last?.ts?.takeIf { it > 0 } ?: System.currentTimeMillis())          // the notification's age is the age of the newest message, not of the moment it was (re)built
        b.addExtras(android.os.Bundle().apply { putString("qm_chat", chatId) })          // lets handleSync find the chat of an active notification
        chatBmp[chatId]?.let { b.setLargeIcon(it) }
        if (Build.VERSION.SDK_INT >= 28) {
            val meP = android.app.Person.Builder().setName("You").apply { store.uid?.let { personBmp[it] }?.let { setIcon(android.graphics.drawable.Icon.createWithBitmap(it)) } }.build()
            val style = Notification.MessagingStyle(meP)
            if (title.isNotBlank()) style.setConversationTitle(title)
            style.setGroupConversation(true)             // shows each sender's picture next to their messages, like Discord (cars read "Name: text")
            synchronized(list) { list.toList() }.forEach { msg ->
                val p = if (msg.from == null) meP else personOf(msg.from)
                val mo = Notification.MessagingStyle.Message(msg.text, msg.ts, p)
                imgUri[msg.id]?.let { mo.setData("image/jpeg", it) }          // the picture itself, inside the conversation
                style.addMessage(mo)
            }
            b.setStyle(style)
        } else {
            val who = last?.from?.let { nameOf(it) } ?: "New message"
            b.setContentTitle(if (title.isNotBlank()) "$who · $title" else who).setContentText(lastText).setStyle(Notification.BigTextStyle().bigText(lastText))
        }
        imgBmp[chatId]?.let { bmp ->
            if (Build.VERSION.SDK_INT < 28 && lastText == "📷 Photo") {
                val who = last?.from?.let { nameOf(it) } ?: "New photo"
                b.setStyle(Notification.BigPictureStyle().bigPicture(bmp).setSummaryText(lastText)).setContentTitle(if (title.isNotBlank()) "$who · $title" else who).setContentText(lastText)
            }
        }
        if (Build.VERSION.SDK_INT >= 30) bubbleFor(chatId, chatLabel[chatId] ?: title.ifBlank { last?.from?.let { nameOf(it) } ?: "Chat" })?.let { (sid, meta) -> b.setShortcutId(sid); b.setBubbleMetadata(meta) }
        // reply straight from the notification (not in encrypted chats: this app can't encrypt from the background)
        val readPi = PendingIntent.getService(this, ("read$chatId").hashCode(), Intent(this, NotifyService::class.java).setAction(ACT_READ).putExtra("chat", chatId), PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
        // Android Auto reads the messages aloud and then uses these two "semantic" actions (reply by voice, mark as read) without opening the app
        val readB = Notification.Action.Builder(ic(android.R.drawable.ic_menu_view), "Mark as read", readPi)
        if (Build.VERSION.SDK_INT >= 28) readB.setSemanticAction(Notification.Action.SEMANTIC_ACTION_MARK_AS_READ)
        val readAct = readB.build()
        val isRead = last?.id != null && readIds[chatId] == last.id     // already read: nothing left to mark
        if (encChats[chatId] == true && Crypt.cached(chatId) == null) { if (!isRead) b.addAction(readAct); nm().notify(chatId.hashCode(), b.build()); return }   // encrypted and no key here: no reply
        val ri = android.app.RemoteInput.Builder(KEY_REPLY).setLabel("Reply").build()
        val flags = PendingIntent.FLAG_UPDATE_CURRENT or (if (Build.VERSION.SDK_INT >= 31) PendingIntent.FLAG_MUTABLE else 0)
        val pi = PendingIntent.getService(this, chatId.hashCode(), Intent(this, NotifyService::class.java).setAction(ACT_REPLY).putExtra("chat", chatId), flags)
        val act = Notification.Action.Builder(android.graphics.drawable.Icon.createWithResource(this, android.R.drawable.ic_menu_send), "Reply", pi)
            .addRemoteInput(ri).setAllowGeneratedReplies(true)
        if (Build.VERSION.SDK_INT >= 28) act.setSemanticAction(Notification.Action.SEMANTIC_ACTION_REPLY)
        b.addAction(act.build())
        if (!isRead) b.addAction(readAct)
        nm().notify(chatId.hashCode(), b.build())
    }

    /** Chat bubble: a long-lived shortcut for the chat + metadata pointing at BubbleActivity (which shows only that chat). */
    private fun bubbleFor(chatId: String, label: String): Pair<String, Notification.BubbleMetadata>? = try {
        val sid = "chat_$chatId"
        val icon = chatSq[chatId]?.let { android.graphics.drawable.Icon.createWithAdaptiveBitmap(it) } ?: android.graphics.drawable.Icon.createWithResource(this, applicationInfo.icon)
        val sm = getSystemService(android.content.pm.ShortcutManager::class.java)
        val sc = android.content.pm.ShortcutInfo.Builder(this, sid).setLongLived(true).setShortLabel(label.take(24)).setIcon(icon)
            .setIntent(Intent(this, MainActivity::class.java).setAction(Intent.ACTION_VIEW).putExtra(MainActivity.EXTRA_CHAT, chatId))
            .setLocusId(android.content.LocusId(sid))
            .setPerson(android.app.Person.Builder().setName(label).build()).build()
        sm.pushDynamicShortcut(sc)
        val bi = PendingIntent.getActivity(this, ("bubble$chatId").hashCode(),
            Intent(this, BubbleActivity::class.java).putExtra(MainActivity.EXTRA_CHAT, chatId).addFlags(Intent.FLAG_ACTIVITY_NEW_DOCUMENT or Intent.FLAG_ACTIVITY_MULTIPLE_TASK),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_MUTABLE)
        val meta = Notification.BubbleMetadata.Builder(bi, icon).setDesiredHeight(4000).setAutoExpandBubble(false).setSuppressNotification(false).build()
        sid to meta
    } catch (_: Exception) { null }

    /** "Mark as read": tells the server you've seen the newest message (so senders get their read receipt). The notification stays. */
    private fun handleRead(i: Intent) {
        val chat = i.getStringExtra("chat") ?: return
        val me = store.uid ?: return
        Thread {
            try {
                val id = baselines[chat] ?: (fb.get("privateChats/$chat/lastMessage") as? JSONObject)?.optString("id") ?: return@Thread
                if (id.isNotEmpty()) {
                    fb.put("privateChats/$chat/messageRead/$me", JSONObject.quote(id))
                    readIds[chat] = id
                    // this service may have just been woken (push mode) and know nothing about the chat: rebuild what the notification needs
                    if (history[chat] == null) {
                        refreshThread(chat, null)
                    }
                    postMessages(chat, quiet = true)                  // same notification, without the button
                }
            } catch (_: Exception) {}
        }.start()
    }

    private fun handleReply(i: Intent) {
        val chat = i.getStringExtra("chat") ?: return
        val text = android.app.RemoteInput.getResultsFromIntent(i)?.getCharSequence(KEY_REPLY)?.toString()?.trim()
        val me = store.uid
        if (text.isNullOrEmpty() || me == null) { nm().cancel(chat.hashCode()); return }
        val ts = System.currentTimeMillis()
        busy.incrementAndGet()
        Thread {
            try {
                // start from the real thread (this service may have just been woken and know nothing yet), then show your reply in it right away
                refreshThread(chat, null)
                val list = history.getOrPut(chat) { java.util.Collections.synchronizedList(ArrayList<Msg>()) }
                val incoming = synchronized(list) { list.lastOrNull { it.from != null }?.id }
                synchronized(list) { list.add(Msg("local$ts", text, ts, null)); while (list.size > 8) list.removeAt(0) }
                try { ensureChatLook(chat, titles[chat] ?: ""); store.uid?.let { ensurePerson(it) }; synchronized(list) { list.mapNotNull { it.from } }.distinct().forEach { ensurePerson(it) } } catch (_: Exception) {}
                postMessages(chat, quiet = true)
                try {
                    val enc = encChats[chat] == true
                    val ck = if (enc) (Crypt.chatKey(fb, store, chat) ?: throw IllegalStateException("no key")) else null
                    fun wire(t: String) = if (ck != null) Crypt.encrypt(ck, chat, t) else t
                    val msg = JSONObject().put("fromUid", me).put("text", wire(text.take(4000))).put("timestamp", ts).put("deliveredAt", JSONObject().put(".sv", "timestamp"))
                    if (enc) msg.put("enc", true)
                    val key = fb.post("privateChats/$chat/messages", msg.toString())
                    val last = JSONObject().put("fromUid", me).put("text", wire(text.take(300))).put("timestamp", ts).put("id", key)
                    if (enc) last.put("enc", true)
                    fb.put("privateChats/$chat/lastMessage", last.toString())
                    baselines[chat] = key
                    // answering means you've seen what you answered
                    if (!incoming.isNullOrEmpty() && !incoming.startsWith("local")) { try { fb.put("privateChats/$chat/messageRead/$me", JSONObject.quote(incoming)); readIds[chat] = incoming } catch (_: Exception) {} }
                    // wake the other members (the web app does the same when it sends); a push from the Cloud Function reaches the apps
                    try {
                        (fb.get("privateChats/$chat/participants") as? JSONObject)?.keys()?.forEach { u ->
                            if (u != me) fb.put("live/$u/pings/$chat", JSONObject().put("id", key).put("ts", ts).put("from", me).toString())
                        }
                    } catch (_: Exception) {}
                    synchronized(list) { list.removeAll { it.id == "local$ts" }; list.add(Msg(key, text, ts, null)) }
                } catch (_: Exception) {
                    android.os.Handler(mainLooper).post { android.widget.Toast.makeText(this, "Couldn't send your reply", android.widget.Toast.LENGTH_SHORT).show() }
                }
                postMessages(chat, quiet = true)
            } finally { busy.decrementAndGet(); if (pushMode()) scheduleIdle(4_000) }
        }.start()
    }
}
