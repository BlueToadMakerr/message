package app.quickmessage.chat

import android.app.*
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.graphics.Bitmap
import android.graphics.PixelFormat
import android.hardware.display.DisplayManager
import android.hardware.display.VirtualDisplay
import android.media.ImageReader
import android.media.projection.MediaProjection
import android.media.projection.MediaProjectionManager
import android.os.Build
import android.media.AudioAttributes
import android.media.AudioFormat
import android.media.AudioPlaybackCaptureConfiguration
import android.media.AudioRecord
import android.os.Handler
import android.os.HandlerThread
import android.os.IBinder
import android.util.Base64
import android.util.DisplayMetrics
import android.view.WindowManager
import java.io.ByteArrayOutputStream

/**
 * Captures the screen for the website's screen share. The WebView can't do this, so frames are sent (as small JPEGs) into
 * the page, which turns them into the screen-share track (js/call/media.js). Needs the mediaProjection foreground type.
 */
class ScreenService : Service() {
    companion object {
        @Volatile var onFrame: ((String) -> Unit)? = null
        @Volatile var onAudio: ((String) -> Unit)? = null
        @Volatile var onState: ((String) -> Unit)? = null
        private const val EXTRA_CODE = "code"
        private const val EXTRA_DATA = "data"
        private const val ID = 21
        @Volatile private var running: ScreenService? = null
        /** Capture quality chosen in Account → Screen sharing (longest edge in px, JPEG quality, frames per second). */
        @Volatile var maxEdge = 1024
        @Volatile var jpegQuality = 55
        @Volatile var fps = 5

        fun start(ctx: Context, code: Int, data: Intent) {
            val i = Intent(ctx, ScreenService::class.java).putExtra(EXTRA_CODE, code).putExtra(EXTRA_DATA, data)
            if (Build.VERSION.SDK_INT >= 26) ctx.startForegroundService(i) else ctx.startService(i)
        }
        fun stop(ctx: Context) { running?.shutdown(false) ?: ctx.stopService(Intent(ctx, ScreenService::class.java)) }
    }

    private var projection: MediaProjection? = null
    private var display: VirtualDisplay? = null
    private var reader: ImageReader? = null
    private var thread: HandlerThread? = null
    private var lastSent = 0L
    @Volatile private var closed = false

    override fun onBind(i: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, id: Int): Int {
        val data = intent?.let { @Suppress("DEPRECATION") it.getParcelableExtra<Intent>(EXTRA_DATA) }
        if (data == null) { onState?.invoke("denied"); stopSelf(); return START_NOT_STICKY }
        running = this
        val ch = "screen"
        val nm = getSystemService(NOTIFICATION_SERVICE) as NotificationManager
        if (Build.VERSION.SDK_INT >= 26) nm.createNotificationChannel(NotificationChannel(ch, "Screen sharing", NotificationManager.IMPORTANCE_LOW))
        val open = PendingIntent.getActivity(this, 0, Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP), PendingIntent.FLAG_IMMUTABLE)
        @Suppress("DEPRECATION")
        val n = (if (Build.VERSION.SDK_INT >= 26) Notification.Builder(this, ch) else Notification.Builder(this))
            .setContentTitle("Sharing your screen").setContentText("Tap to return to QuickMessage").setSmallIcon(R.drawable.ic_screen)
            .setOngoing(true).setContentIntent(open).build()
        try {
            if (Build.VERSION.SDK_INT >= 29) startForeground(ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION) else startForeground(ID, n)
        } catch (e: Exception) { onState?.invoke("denied"); stopSelf(); return START_NOT_STICKY }

        val mpm = getSystemService(MEDIA_PROJECTION_SERVICE) as MediaProjectionManager
        val mp = try { mpm.getMediaProjection(intent.getIntExtra(EXTRA_CODE, Activity.RESULT_OK), data) } catch (e: Exception) { null }
        if (mp == null) { onState?.invoke("denied"); stopSelf(); return START_NOT_STICKY }
        projection = mp
        val t = HandlerThread("screen-capture").also { it.start() }; thread = t
        val h = Handler(t.looper)
        mp.registerCallback(object : MediaProjection.Callback() { override fun onStop() { shutdown(true) } }, h)

        handler = h
        val (w, hgt, dpi) = captureSize()
        val r = newReader(w, hgt); reader = r
        curW = w; curH = hgt
        display = mp.createVirtualDisplay("qm-screen", w, hgt, dpi, DisplayManager.VIRTUAL_DISPLAY_FLAG_AUTO_MIRROR, r.surface, null, h)
        // Rotating the phone changes the screen's shape: resize the capture to match, otherwise the shared picture ends up
        // letterboxed with huge bars and tiny content.
        val cb = object : android.content.ComponentCallbacks {
            override fun onConfigurationChanged(c: android.content.res.Configuration) { h.post { rebuild() }; h.postDelayed({ rebuild() }, 400) }
            @Suppress("OVERRIDE_DEPRECATION") override fun onLowMemory() {}
        }
        callbacks = cb; registerComponentCallbacks(cb)
        startAudio(mp)
        onState?.invoke("started")
        return START_NOT_STICKY
    }

    private var handler: Handler? = null
    private var curW = 0
    private var curH = 0
    private var callbacks: android.content.ComponentCallbacks? = null

    /** Capture size (long edge ≤ 1024 px, even numbers) of the screen in its current orientation. */
    private fun captureSize(): Triple<Int, Int, Int> {
        val dm = DisplayMetrics()
        @Suppress("DEPRECATION") (getSystemService(WINDOW_SERVICE) as WindowManager).defaultDisplay.getRealMetrics(dm)
        val scale = (maxEdge.toFloat() / maxOf(dm.widthPixels, dm.heightPixels).coerceAtLeast(1)).coerceAtMost(1f)
        val w = ((dm.widthPixels * scale).toInt() and 1.inv()).coerceAtLeast(2)
        val h = ((dm.heightPixels * scale).toInt() and 1.inv()).coerceAtLeast(2)
        return Triple(w, h, dm.densityDpi)
    }

    private fun newReader(w: Int, hgt: Int): ImageReader {
        val r = ImageReader.newInstance(w, hgt, PixelFormat.RGBA_8888, 2)
        r.setOnImageAvailableListener({ rd ->
            val img = try { rd.acquireLatestImage() } catch (_: Exception) { null } ?: return@setOnImageAvailableListener
            try {
                val now = System.currentTimeMillis()
                if (closed || now - lastSent < 1000L / fps.coerceIn(1, 30)) return@setOnImageAvailableListener      // ~5 frames a second is plenty for a share
                lastSent = now
                val p = img.planes[0]
                val rowPad = p.rowStride - p.pixelStride * w
                val bmp = Bitmap.createBitmap(w + rowPad / p.pixelStride, hgt, Bitmap.Config.ARGB_8888)
                bmp.copyPixelsFromBuffer(p.buffer)
                val out = ByteArrayOutputStream()
                Bitmap.createBitmap(bmp, 0, 0, w, hgt).compress(Bitmap.CompressFormat.JPEG, jpegQuality, out)
                bmp.recycle()
                onFrame?.invoke(Base64.encodeToString(out.toByteArray(), Base64.NO_WRAP))
            } finally { img.close() }
        }, handler)
        return r
    }

    private var audio: AudioRecord? = null

    /** Sound from other apps (not QuickMessage's own call audio, which would echo) goes along with the shared screen. Android 10+. */
    private fun startAudio(mp: MediaProjection) {
        if (Build.VERSION.SDK_INT < 29 || checkSelfPermission(android.Manifest.permission.RECORD_AUDIO) != android.content.pm.PackageManager.PERMISSION_GRANTED) return
        try {
            val cfg = AudioPlaybackCaptureConfiguration.Builder(mp)
                .addMatchingUsage(AudioAttributes.USAGE_MEDIA).addMatchingUsage(AudioAttributes.USAGE_GAME).addMatchingUsage(AudioAttributes.USAGE_UNKNOWN)
                .excludeUid(android.os.Process.myUid()).build()
            val fmt = AudioFormat.Builder().setEncoding(AudioFormat.ENCODING_PCM_16BIT).setSampleRate(24000).setChannelMask(AudioFormat.CHANNEL_IN_MONO).build()
            val rec = AudioRecord.Builder().setAudioFormat(fmt).setAudioPlaybackCaptureConfig(cfg).setBufferSizeInBytes(24000).build()
            audio = rec
            rec.startRecording()
            Thread({
                val buf = ByteArray(4800)                       // 100 ms of 24 kHz mono 16-bit
                while (!closed && rec.recordingState == AudioRecord.RECORDSTATE_RECORDING) {
                    val n = rec.read(buf, 0, buf.size)
                    if (n > 0) onAudio?.invoke(Base64.encodeToString(buf, 0, n, Base64.NO_WRAP)) else if (n < 0) break
                }
            }, "screen-audio").start()
        } catch (_: Exception) { audio = null }
    }

    private fun rebuild() {
        if (closed) return
        val d = display ?: return
        val (w, h, dpi) = captureSize()
        if (w == curW && h == curH) return
        try {
            val old = reader
            val r = newReader(w, h)
            d.resize(w, h, dpi)
            d.surface = r.surface
            reader = r; curW = w; curH = h
            try { old?.close() } catch (_: Exception) {}
        } catch (_: Exception) { /* keep the old size rather than ending the share */ }
    }

    fun shutdown(tell: Boolean) {
        if (closed) return
        closed = true
        callbacks?.let { try { unregisterComponentCallbacks(it) } catch (_: Exception) {} }
        try { audio?.stop(); audio?.release() } catch (_: Exception) {}
        try { display?.release() } catch (_: Exception) {}
        try { reader?.close() } catch (_: Exception) {}
        try { projection?.stop() } catch (_: Exception) {}
        thread?.quitSafely()
        if (tell) onState?.invoke("stopped")
        running = null
        stopForeground(STOP_FOREGROUND_REMOVE); stopSelf()
    }

    override fun onDestroy() { shutdown(true); super.onDestroy() }
}
