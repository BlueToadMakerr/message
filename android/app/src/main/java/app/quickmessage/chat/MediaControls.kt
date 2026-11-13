package app.quickmessage.chat

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.media.session.MediaSession
import android.media.session.PlaybackState
import android.os.Build

/**
 * Media controls for audio and video played by the page (chat audio messages, videos, the built-in floating player): a media notification
 * with play/pause and ±10 s, also on the lock screen and for headset buttons. The page reports its state with QMApp.mediaState(...);
 * a button press goes back to the page as window.__qmMediaCtl(op). Nothing here plays sound by itself.
 */
object MediaControls {
    private const val CH = "media"
    private const val ID = 7421
    private const val ACTION = "app.quickmessage.MEDIA_OP"
    private var session: MediaSession? = null
    private var receiverOn = false

    private fun send(op: String, arg: String = "") {
        val a = MainActivity.instance ?: return
        a.runJs("window.__qmMediaCtl&&window.__qmMediaCtl('$op'${if (arg.isEmpty()) "" else ",$arg"})")
    }

    private val receiver = object : BroadcastReceiver() {
        override fun onReceive(c: Context?, i: Intent?) {
            val op = i?.getStringExtra("op") ?: return
            if (op in setOf("toggle", "back", "fwd", "stop")) send(op)
        }
    }

    private fun ensure(ctx: Context) {
        val app = ctx.applicationContext
        if (!receiverOn) {
            val f = IntentFilter(ACTION)
            if (Build.VERSION.SDK_INT >= 33) app.registerReceiver(receiver, f, Context.RECEIVER_NOT_EXPORTED) else app.registerReceiver(receiver, f)
            receiverOn = true
        }
        if (session == null) {
            session = MediaSession(app, "QuickMessage").apply {
                setCallback(object : MediaSession.Callback() {
                    override fun onPlay() = send("toggle")
                    override fun onPause() = send("toggle")
                    override fun onSkipToNext() = send("fwd")
                    override fun onSkipToPrevious() = send("back")
                    override fun onFastForward() = send("fwd")
                    override fun onRewind() = send("back")
                    override fun onStop() = send("stop")
                    override fun onSeekTo(pos: Long) = send("seek", (pos / 1000.0).toString())
                })
            }
        }
        if (Build.VERSION.SDK_INT >= 26) {
            val nm = app.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
            nm.createNotificationChannel(NotificationChannel(CH, "Media playback", NotificationManager.IMPORTANCE_LOW).apply { setShowBadge(false) })
        }
    }

    private fun pi(ctx: Context, op: String, code: Int) = PendingIntent.getBroadcast(
        ctx, code, Intent(ACTION).setPackage(ctx.packageName).putExtra("op", op), PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)

    fun update(ctx: Context, title: String, playing: Boolean, posMs: Long, durMs: Long, video: Boolean) {
        try {
            ensure(ctx)
            val s = session ?: return
            val app = ctx.applicationContext
            val name = title.ifBlank { if (video) "Video" else "Audio message" }
            s.setMetadata(android.media.MediaMetadata.Builder()
                .putString(android.media.MediaMetadata.METADATA_KEY_TITLE, name)
                .putString(android.media.MediaMetadata.METADATA_KEY_ARTIST, "QuickMessage")
                .putLong(android.media.MediaMetadata.METADATA_KEY_DURATION, if (durMs > 0) durMs else -1L).build())
            val acts = PlaybackState.ACTION_PLAY or PlaybackState.ACTION_PAUSE or PlaybackState.ACTION_PLAY_PAUSE or PlaybackState.ACTION_SEEK_TO or
                PlaybackState.ACTION_REWIND or PlaybackState.ACTION_FAST_FORWARD or PlaybackState.ACTION_STOP
            s.setPlaybackState(PlaybackState.Builder().setActions(acts)
                .setState(if (playing) PlaybackState.STATE_PLAYING else PlaybackState.STATE_PAUSED, posMs, if (playing) 1f else 0f).build())
            s.isActive = true
            val b = if (Build.VERSION.SDK_INT >= 26) Notification.Builder(app, CH) else @Suppress("DEPRECATION") Notification.Builder(app)
            val open = PendingIntent.getActivity(app, 0, Intent(app, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_REORDER_TO_FRONT),
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
            fun act(icon: Int, label: String, op: String, code: Int) = Notification.Action.Builder(android.graphics.drawable.Icon.createWithResource(app, icon), label, pi(app, op, code)).build()
            b.setSmallIcon(if (playing) android.R.drawable.ic_media_play else android.R.drawable.ic_media_pause)
                .setContentTitle(name).setContentText("QuickMessage")
                .setContentIntent(open).setOnlyAlertOnce(true).setOngoing(playing).setShowWhen(false).setVisibility(Notification.VISIBILITY_PUBLIC)
                .setDeleteIntent(pi(app, "stop", 4))
                .addAction(act(android.R.drawable.ic_media_rew, "Back 10 s", "back", 1))
                .addAction(act(if (playing) android.R.drawable.ic_media_pause else android.R.drawable.ic_media_play, if (playing) "Pause" else "Play", "toggle", 2))
                .addAction(act(android.R.drawable.ic_media_ff, "Forward 10 s", "fwd", 3))
                .setStyle(Notification.MediaStyle().setMediaSession(s.sessionToken).setShowActionsInCompactView(0, 1, 2))
            (app.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager).notify(ID, b.build())
        } catch (_: Throwable) { /* media controls are a nicety: never break playback */ }
    }

    fun clear(ctx: Context) {
        try {
            session?.isActive = false
            (ctx.applicationContext.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager).cancel(ID)
        } catch (_: Throwable) { /* ignore */ }
    }
}
