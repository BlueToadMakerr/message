package app.quickmessage.chat

import android.Manifest
import android.annotation.SuppressLint
import android.app.Activity
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Color
import android.media.projection.MediaProjectionManager
import android.net.Uri
import android.os.Build
import android.os.Message
import android.os.Bundle
import android.view.View
import android.view.ViewGroup
import android.view.WindowInsets
import android.webkit.*
import android.widget.FrameLayout
import android.app.PictureInPictureParams
import android.media.AudioManager
import android.util.Rational
import org.json.JSONObject

/**
 * QuickMessage as an app: the website runs in a WebView and the app adds what a WebView can't do by itself, through the
 * `QMApp` bridge (see js/app-bridge.js, js/bars.js, js/call/media.js):
 *   - screen sharing (captured natively, streamed into the page)
 *   - notifications for messages and full-screen incoming-call alerts (NotifyService)
 *   - status / navigation bars that follow the site's background colour
 *   - clearing the cache from Account → App
 */
class MainActivity : Activity() {
    companion object {
        @Volatile var visible = false
        @Volatile var instance: MainActivity? = null
        const val EXTRA_CHAT = "chatId"
        const val EXTRA_RING = "ring"
        const val EXTRA_ANSWER = "answer"
        const val EXTRA_CALLACT = "callact"
        private const val REQ_PERMS = 1
        private const val REQ_FILE = 2
        private const val REQ_PROJECTION = 3

        /** When the app is closed (swiped away) while files are still uploading, the page that is uploading must not die with the screen:
         *  its WebView is kept running, detached, until its uploads are done (or 30 minutes). The next start is a new page that shows them
         *  as "Uploading…" (js/shell.js + js/message.js read what this one writes to localStorage). Main thread only. */
        private val headless = HashMap<Int, WebView>()          // upload source (that page's bridge) -> its WebView
        private fun keepHeadless(app: Context, source: Int, w: WebView) {
            headless[source] = w
            android.os.Handler(android.os.Looper.getMainLooper()).postDelayed({ releaseHeadless(app, source) }, 30 * 60_000L)
        }
        fun releaseHeadless(app: Context, source: Int) {
            val w = headless.remove(source) ?: return
            try { w.stopLoading(); w.destroy() } catch (_: Exception) {}
            NotifyService.setUploads(app, source, 0, -1, "")
        }
    }

    private lateinit var web: WebView
    private val bridge = Bridge()          // one per activity; its identity is the "source" of this page's uploads
    private val uploadSource get() = System.identityHashCode(bridge)
    private lateinit var root: FrameLayout
    private var pendingWebPerm: PermissionRequest? = null
    private var fileCb: ValueCallback<Array<Uri>>? = null
    private var barColor = Color.WHITE
    private var loaded = false
    @Volatile private var inCall = false
    @Volatile private var callVisible = false
    @Volatile private var pip = false
    /** True while the app was opened over the lock screen by a call: the call is then the only thing reachable (see js/shell.js "protect"). */
    @Volatile private var protectedMode = false
    private fun locked() = (getSystemService(KEYGUARD_SERVICE) as android.app.KeyguardManager).isKeyguardLocked
    @Volatile private var ins = intArrayOf(0, 0, 0, 0)     // top, bottom, left, right in dp
    private var customView: View? = null
    private var customCb: WebChromeClient.CustomViewCallback? = null

    @SuppressLint("SetJavaScriptEnabled", "JavascriptInterface")
    @Suppress("DEPRECATION")
    override fun onCreate(b: Bundle?) {
        Config.init(this)
        super.onCreate(b)
        instance = this
        root = FrameLayout(this).apply { setBackgroundColor(barColor) }
        web = object : WebView(this) {
            // Tells the keyboard this field takes images (Gboard's clipboard / GIF / sticker suggestions say "not supported" otherwise).
            override fun onCreateInputConnection(outAttrs: android.view.inputmethod.EditorInfo): android.view.inputmethod.InputConnection? {
                val ic = super.onCreateInputConnection(outAttrs) ?: return null
                if (Build.VERSION.SDK_INT < 25) return ic
                outAttrs.contentMimeTypes = arrayOf("image/png", "image/jpeg", "image/gif", "image/webp")
                return object : android.view.inputmethod.InputConnectionWrapper(ic, false) {
                    override fun commitContent(info: android.view.inputmethod.InputContentInfo, flags: Int, opts: Bundle?): Boolean {
                        return pasteContent(info, flags)
                    }
                }
            }
        }
        root.addView(web, FrameLayout.LayoutParams(-1, -1))
        setContentView(root)
        // Edge to edge: the page draws under the status and navigation bars and keeps clear of them itself (--sat/--sab, see js/bars.js),
        // so the bars simply show the site's background.
        window.statusBarColor = Color.TRANSPARENT
        window.navigationBarColor = Color.TRANSPARENT
        if (Build.VERSION.SDK_INT >= 29) { window.isNavigationBarContrastEnforced = false; window.isStatusBarContrastEnforced = false }
        if (Build.VERSION.SDK_INT >= 30) window.setDecorFitsSystemWindows(false)
        else run { window.decorView.systemUiVisibility = window.decorView.systemUiVisibility or View.SYSTEM_UI_FLAG_LAYOUT_STABLE or View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN or View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION }
        root.setOnApplyWindowInsetsListener { v, insets ->
            val d = resources.displayMetrics.density
            var top: Int; var bottom: Int; var left: Int; var right: Int; var ime = 0
            if (Build.VERSION.SDK_INT >= 30) {
                val bars = insets.getInsets(WindowInsets.Type.systemBars() or WindowInsets.Type.displayCutout())
                ime = insets.getInsets(WindowInsets.Type.ime()).bottom
                top = bars.top; bottom = bars.bottom; left = bars.left; right = bars.right
            } else run {
                top = insets.systemWindowInsetTop; bottom = insets.systemWindowInsetBottom; left = insets.systemWindowInsetLeft; right = insets.systemWindowInsetRight
            }
            // with the keyboard up, shrink the page to sit above it (and report no bottom inset: the keyboard covers that area)
            v.setPadding(0, 0, 0, if (ime > bottom) ime else 0)
            val bDp = if (ime > bottom) 0 else bottom
            ins = intArrayOf(Math.round(top / d), Math.round(bDp / d), Math.round(left / d), Math.round(right / d))
            insets
        }
        web.settings.apply {
            javaScriptEnabled = true; setSupportZoom(false); builtInZoomControls = false; displayZoomControls = false; domStorageEnabled = true
            @Suppress("DEPRECATION") databaseEnabled = true
            mediaPlaybackRequiresUserGesture = false
            allowFileAccess = false; allowContentAccess = true
            setSupportMultipleWindows(true); javaScriptCanOpenWindowsAutomatically = true
            userAgentString = userAgentString + " QuickMessageApp/1"
        }
        CookieManager.getInstance().apply { setAcceptCookie(true); setAcceptThirdPartyCookies(web, true) }
        web.isLongClickable = false; web.setOnLongClickListener { true }; web.isHapticFeedbackEnabled = false
        web.addJavascriptInterface(bridge, "QMApp")
        // New / removed headsets, Bluetooth and USB audio are picked up straight from Android (no microphone access needed) and pushed to the page.
        try { (getSystemService(AUDIO_SERVICE) as AudioManager).registerAudioDeviceCallback(audioCb, android.os.Handler(android.os.Looper.getMainLooper())) } catch (_: Exception) {}
        web.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(v: WebView, r: WebResourceRequest): Boolean {
                val u = r.url
                val site = Uri.parse(Config.SITE_URL)
                if (u.host == site.host || u.scheme == "blob" || u.scheme == "about" || u.scheme == "file") return false
                if (u.scheme == "quickmessage") { handleAuth(u); return true }
                try { startActivity(Intent(Intent.ACTION_VIEW, u)) } catch (_: Exception) {}
                return true
            }
            override fun onPageFinished(v: WebView, url: String?) { loaded = true }
            // Network errors show the same offline page the website uses (assets/offline.html), with the net:: code.
            override fun onReceivedError(v: WebView, r: WebResourceRequest, e: WebResourceError) {
                if (!r.isForMainFrame || r.url.scheme == "file") return
                val code = (e.description?.toString() ?: "").removePrefix("net::")
                val u = Uri.encode(r.url.toString())
                v.loadUrl("file:///android_asset/offline.html?code=" + Uri.encode(code) + "&url=" + u)
            }
        }
        web.webChromeClient = object : WebChromeClient() {
            override fun onShowCustomView(view: View, cb: CustomViewCallback) {
                if (customView != null) { cb.onCustomViewHidden(); return }
                customView = view; customCb = cb
                root.addView(view, FrameLayout.LayoutParams(-1, -1))
                web.visibility = View.INVISIBLE
                immersive(true)
            }
            override fun onHideCustomView() {
                customView?.let { root.removeView(it) }
                customView = null; customCb?.onCustomViewHidden(); customCb = null
                web.visibility = View.VISIBLE
                immersive(false)
            }
            override fun onPermissionRequest(r: PermissionRequest) { runOnUiThread { askWebPermission(r) } }
            // target="_blank" / window.open: web links open in the browser as usual
            override fun onCreateWindow(view: WebView, isDialog: Boolean, isUserGesture: Boolean, resultMsg: Message): Boolean {
                val tmp = WebView(view.context)
                val site = Uri.parse(Config.SITE_URL)
                val open = { u: Uri? -> if (u != null && (u.scheme == "https" || u.scheme == "http") && u.host != site.host) { try { startActivity(Intent(Intent.ACTION_VIEW, u)) } catch (_: Exception) {} } }
                tmp.webViewClient = object : WebViewClient() {
                    override fun shouldOverrideUrlLoading(v: WebView, r: WebResourceRequest): Boolean { open(r.url); v.destroy(); return true }
                    override fun onPageStarted(v: WebView, url: String?, f: android.graphics.Bitmap?) { if (url != null && url != "about:blank") { open(Uri.parse(url)); v.stopLoading(); v.destroy() } }
                }
                (resultMsg.obj as WebView.WebViewTransport).webView = tmp
                resultMsg.sendToTarget()
                return true
            }
            override fun onShowFileChooser(w: WebView, cb: ValueCallback<Array<Uri>>, p: FileChooserParams): Boolean {
                fileCb?.onReceiveValue(null); fileCb = cb
                return try { startActivityForResult(p.createIntent(), REQ_FILE); true } catch (_: Exception) { fileCb = null; false }
            }
        }
        if (Build.VERSION.SDK_INT >= 33 && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED)
            requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), REQ_PERMS)
        Push.register(this)
        NotifyService.start(this)
        if (b != null) web.restoreState(b) else if (intent?.data?.scheme == "quickmessage") { open(null); web.postDelayed({ handleAuth(intent.data!!) }, 2500) } else open(intent)
    }

    override fun onNewIntent(i: Intent) {
        super.onNewIntent(i); setIntent(i)
        val d = i.data
        if (d != null && d.scheme == "quickmessage") handleAuth(d) else open(i)
    }

    /** quickmessage://auth?idToken=… comes back from the browser sign-in page (app-login.html). */
    private fun handleAuth(u: Uri) {
        val id = u.getQueryParameter("idToken") ?: ""
        val err = u.getQueryParameter("error") ?: ""
        val safe = Regex("^[\\w.\\-]+$")
        if (id.isNotEmpty() && safe.matches(id)) js("window.__qmGoogleSignIn&&window.__qmGoogleSignIn('$id','')")
        else js("window.__qmGoogleSignIn&&window.__qmGoogleSignIn('','" + Uri.encode(err) + "')")
    }

    /** The keyboard inserted an image: read it and hand it to the chat's composer (js/message.js → __qmPasteImage). */
    private fun pasteContent(info: android.view.inputmethod.InputContentInfo, flags: Int): Boolean {
        val mime = info.description.getMimeType(0) ?: "image/png"
        if (!mime.startsWith("image/")) return false
        val needsPermission = Build.VERSION.SDK_INT >= 25 && (flags and android.view.inputmethod.InputConnection.INPUT_CONTENT_GRANT_READ_URI_PERMISSION) != 0
        try { if (needsPermission) info.requestPermission() } catch (_: Exception) { return false }
        Thread {
            try {
                val bytes = contentResolver.openInputStream(info.contentUri)?.use { it.readBytes() } ?: return@Thread
                if (bytes.size > 8_000_000) { runOnUiThread { android.widget.Toast.makeText(this, "That image is too large to paste", android.widget.Toast.LENGTH_SHORT).show() }; return@Thread }
                val b64 = android.util.Base64.encodeToString(bytes, android.util.Base64.NO_WRAP)
                val safeMime = if (Regex("^image/[a-z0-9.+-]{1,20}$").matches(mime)) mime else "image/png"
                runOnUiThread { js("window.__qmPasteImage&&window.__qmPasteImage('$safeMime','$b64','')") }
            } catch (_: Exception) {
            } finally { try { if (needsPermission) info.releasePermission() } catch (_: Exception) {} }
        }.start()
        return true
    }

    fun runJs(code: String) = runOnUiThread { js(code) }

    /** Consent already given (by ScreenShareActivity, from the call notification): keep it for the page's next startScreen() and ask the page to share. */
    @Volatile private var pendingProjection: Pair<Int, Intent>? = null
    fun shareWithProjection(res: Int, data: Intent) {
        pendingProjection = res to data
        runOnUiThread { js("window.QM&&QM.toggleScreen&&QM.toggleScreen()") }
    }
    private fun beginProjection(res: Int, data: Intent) {
        ScreenService.onFrame = { b64 -> runOnUiThread { js("window.__qmScreenFrame&&window.__qmScreenFrame('$b64')") } }
        ScreenService.onAudio = { b64 -> runOnUiThread { js("window.__qmScreenAudio&&window.__qmScreenAudio('$b64')") } }
        ScreenService.onState = { st -> runOnUiThread { js("window.__qmScreenState&&window.__qmScreenState('$st')") } }
        ScreenService.start(this, res, data)
    }

    private fun open(i: Intent?) {
        val chat = i?.getStringExtra(EXTRA_CHAT)
        if (i?.getBooleanExtra(EXTRA_RING, false) == true) {
            if (locked()) protectedMode = true
            if (Build.VERSION.SDK_INT >= 27) { setShowWhenLocked(true); setTurnScreenOn(true) }
            else window.addFlags(android.view.WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED or android.view.WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON)
        }
        val safe = chat != null && Regex("^[\\w-]{1,64}$").matches(chat)
        val answer = safe && i?.getBooleanExtra(EXTRA_ANSWER, false) == true
        if (answer) NotifyService.cancelAll(this)
        if (!loaded || web.url == null) { web.loadUrl(Config.SITE_URL + "index.html" + if (safe) "?chat=$chat" + (if (answer) "&call=${System.currentTimeMillis()}" else "") else ""); return }
        if (answer) web.evaluateJavascript("window.QM&&QM.openChat&&QM.openChat('$chat');window.QM&&QM.openCall&&QM.openCall('$chat')", null)
        else if (safe) web.evaluateJavascript("window.QM&&QM.openChat&&QM.openChat('$chat')", null)
    }

    override fun onSaveInstanceState(o: Bundle) { super.onSaveInstanceState(o); web.saveState(o) }
    override fun onStart() { super.onStart(); visible = true; NotifyService.cancelAll(this) }
    override fun onStop() { super.onStop(); if (!pip) { visible = false; NotifyService.sync(this, null) } }       // a bubble / notification left behind is refreshed to the real thread
    override fun onResume() { super.onResume(); web.onResume(); web.resumeTimers() }
    // Never paused at all: a paused WebView freezes JavaScript timers and the page's live connections, which is what made the app drop
    // offline after a while in the background. (The foreground service + wake lock keep the process itself alive.)
    override fun onPause() { super.onPause() }
    private val audioPing = Runnable { js("window.__qmAudioDevices&&window.__qmAudioDevices()") }
    private val audioCb = object : android.media.AudioDeviceCallback() {
        private fun ping() { web.removeCallbacks(audioPing); web.postDelayed(audioPing, 300) }        // a headset often reports several devices at once
        override fun onAudioDevicesAdded(added: Array<out android.media.AudioDeviceInfo>?) = ping()
        override fun onAudioDevicesRemoved(removed: Array<out android.media.AudioDeviceInfo>?) = ping()
    }
    override fun onDestroy() { try { (getSystemService(AUDIO_SERVICE) as AudioManager).unregisterAudioDeviceCallback(audioCb) } catch (_: Exception) {}; if (instance === this) instance = null; if (pipReceiverOn) try { unregisterReceiver(pipReceiver) } catch (_: Exception) {}
        // Closed while a file is still uploading: keep this page (and so the upload) running in the background instead of destroying it.
        if (NotifyService.uploadsFrom(uploadSource) > 0) { try { root.removeView(web) } catch (_: Exception) {}; keepHeadless(applicationContext, uploadSource, web) }
        else web.destroy()
        super.onDestroy()
    }

    override fun onUserLeaveHint() { if (inCall && callVisible && !protectedMode) enterPipNow() }

    override fun onPictureInPictureModeChanged(isInPip: Boolean, cfg: android.content.res.Configuration) {
        super.onPictureInPictureModeChanged(isInPip, cfg)
        pip = isInPip
        if (!isInPip) { pipRatio = Rational(16, 9); if (pipVideo) { pipVideo = false; pipPlaying = false; try { web.evaluateJavascript("window.__qmPipEnded&&window.__qmPipEnded()", null) } catch (_: Exception) {} } }
        if (!isInPip && !visible) visible = true
    }

    private var pipRatio = Rational(16, 9)
    private fun ratio(): Rational { val r = pipRatio.toDouble(); return if (r > 2.39) Rational(239, 100) else if (r < 0.42) Rational(42, 100) else pipRatio }   // Android only accepts 0.42 – 2.39
    /** Asks once to be exempt from battery optimisation, so Android doesn't cut the connection when the app is unused for a while. */
    @android.annotation.SuppressLint("BatteryLife")
    private fun askBatteryOnce() {
        if (Push.available(this) && Config.privateServer.isEmpty()) return       // push wakes the app even in Doze: no battery exemption needed
        val prefs = getSharedPreferences("quickmessage", MODE_PRIVATE)
        if (prefs.getBoolean("batteryAsked", false)) return
        val pm = getSystemService(POWER_SERVICE) as android.os.PowerManager
        if (Build.VERSION.SDK_INT >= 23 && !pm.isIgnoringBatteryOptimizations(packageName)) {
            prefs.edit().putBoolean("batteryAsked", true).apply()
            try { startActivity(Intent(android.provider.Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, Uri.parse("package:$packageName"))) } catch (_: Exception) {}
        }
    }

    /** A video from a chat is in picture-in-picture: the window shows play/pause and ±10 s buttons (PIP_OP broadcasts → the page). */
    private var pipVideo = false
    private var pipPlaying = false
    private var pipMuted = false
    private var pipCamOn = false
    private var pipCanCam = false
    private var pipDeaf = false
    private val pipReceiver = object : android.content.BroadcastReceiver() {
        override fun onReceive(c: android.content.Context?, i: Intent?) {
            val op = i?.getStringExtra("op") ?: return
            if (op !in setOf("toggle", "back", "fwd", "mic", "cam", "deaf")) return
            val fn = if (op == "mic" || op == "cam" || op == "deaf") "__qmCallCtl" else "__qmPipCtl"
            runOnUiThread { try { web.evaluateJavascript("window.$fn&&window.$fn('$op')", null) } catch (_: Exception) {} }
        }
    }
    private var pipReceiverOn = false
    private fun pipAction(op: String, icon: Int, label: String, code: Int): android.app.RemoteAction {
        val pi = android.app.PendingIntent.getBroadcast(this, code, Intent("app.quickmessage.PIP_OP").setPackage(packageName).putExtra("op", op), android.app.PendingIntent.FLAG_UPDATE_CURRENT or android.app.PendingIntent.FLAG_IMMUTABLE)
        return android.app.RemoteAction(android.graphics.drawable.Icon.createWithResource(this, icon), label, label, pi)
    }
    private fun pipParams(autoEnter: Boolean = false): PictureInPictureParams {
        val b = PictureInPictureParams.Builder().setAspectRatio(ratio())
        if (!pipVideo && inCall) {          // a call in picture-in-picture: mute / camera / deafen (no hang-up, to avoid mis-taps)
            val acts = ArrayList<android.app.RemoteAction>()
            acts.add(pipAction("mic", if (pipMuted) R.drawable.ic_mic_off else R.drawable.ic_mic, if (pipMuted) "Unmute" else "Mute", 11))
            if (pipCanCam) acts.add(pipAction("cam", if (pipCamOn) R.drawable.ic_cam else R.drawable.ic_cam_off, if (pipCamOn) "Turn camera off" else "Turn camera on", 12))
            acts.add(pipAction("deaf", if (pipDeaf) R.drawable.ic_headphones_off else R.drawable.ic_headphones, if (pipDeaf) "Undeafen" else "Deafen", 13))
            b.setActions(acts)
        }
        if (pipVideo) b.setActions(listOf(
            pipAction("back", android.R.drawable.ic_media_rew, "Back 10 seconds", 1),
            if (pipPlaying) pipAction("toggle", android.R.drawable.ic_media_pause, "Pause", 2) else pipAction("toggle", android.R.drawable.ic_media_play, "Play", 2),
            pipAction("fwd", android.R.drawable.ic_media_ff, "Forward 10 seconds", 3)))
        if (Build.VERSION.SDK_INT >= 31) b.setAutoEnterEnabled(autoEnter)
        return b.build()
    }
    private fun ensurePipReceiver() {
        if (!pipReceiverOn) { pipReceiverOn = true; try { if (Build.VERSION.SDK_INT >= 33) registerReceiver(pipReceiver, android.content.IntentFilter("app.quickmessage.PIP_OP"), RECEIVER_NOT_EXPORTED) else registerReceiver(pipReceiver, android.content.IntentFilter("app.quickmessage.PIP_OP")) } catch (_: Exception) {} }
    }
    private fun updatePip() {
        if (Build.VERSION.SDK_INT < 26) return
        ensurePipReceiver()
        try { setPictureInPictureParams(pipParams(inCall && callVisible)) } catch (_: Exception) {}
    }

    private fun enterPipNow() {
        if (Build.VERSION.SDK_INT < 26 || pip) return
        ensurePipReceiver()
        try { enterPictureInPictureMode(pipParams()) } catch (_: Exception) {}
    }

    // ---------------------------------------------------------------- downloads
    private val dlIds = java.util.concurrent.atomic.AtomicInteger(9000)
    private fun safeName(n: String) = n.replace(Regex("[^\\w.\\- ]"), "_").take(100).ifBlank { "download" }
    private fun guessMime(name: String): String = android.webkit.MimeTypeMap.getSingleton().getMimeTypeFromExtension(name.substringAfterLast('.', "").lowercase()) ?: "application/octet-stream"
    private fun dlNotifier(): android.app.NotificationManager {
        val nm = getSystemService(NOTIFICATION_SERVICE) as android.app.NotificationManager
        if (Build.VERSION.SDK_INT >= 26) nm.createNotificationChannel(android.app.NotificationChannel("downloads", "Downloads", android.app.NotificationManager.IMPORTANCE_LOW))
        return nm
    }
    private fun dlBuilder() = if (Build.VERSION.SDK_INT >= 26) android.app.Notification.Builder(this, "downloads") else @Suppress("DEPRECATION") android.app.Notification.Builder(this)
    private fun progress(id: Int, name: String, pct: Int) {
        try {
            val b = dlBuilder().setSmallIcon(android.R.drawable.stat_sys_download).setContentTitle("Downloading").setContentText(name).setOngoing(true).setOnlyAlertOnce(true)
            if (pct >= 0) b.setProgress(100, pct, false) else b.setProgress(0, 0, true)
            dlNotifier().notify(id, b.build())
        } catch (_: Exception) {}
        runOnUiThread { web.evaluateJavascript("window.__qmSaving&&window.__qmSaving(" + org.json.JSONObject.quote(name) + "," + pct + ")", null) }
    }
    /** Writes through [write] into the public Downloads folder (MediaStore on Android 10+). Returns the file's uri, or null when only the app's own folder was possible. */
    private fun saveToDownloads(name: String, mime: String, write: (java.io.OutputStream) -> Unit): Uri? {
        if (Build.VERSION.SDK_INT >= 29) {
            val v = android.content.ContentValues().apply {
                put(android.provider.MediaStore.Downloads.DISPLAY_NAME, name); put(android.provider.MediaStore.Downloads.MIME_TYPE, mime.ifBlank { "application/octet-stream" })
                put(android.provider.MediaStore.Downloads.IS_PENDING, 1)
            }
            val u = contentResolver.insert(android.provider.MediaStore.Downloads.EXTERNAL_CONTENT_URI, v) ?: throw java.io.IOException("can't create the file")
            try { contentResolver.openOutputStream(u)?.use { write(it) } ?: throw java.io.IOException("can't write the file") }
            catch (e: Exception) { try { contentResolver.delete(u, null, null) } catch (_: Exception) {}; throw e }
            val done = android.content.ContentValues().apply { put(android.provider.MediaStore.Downloads.IS_PENDING, 0) }
            contentResolver.update(u, done, null, null)
            return u
        }
        val dir = getExternalFilesDir(android.os.Environment.DIRECTORY_DOWNLOADS) ?: filesDir
        java.io.File(dir, name).outputStream().use { write(it) }
        return null
    }
    private fun saved(id: Int, name: String, uri: Uri?, mime: String, error: String?) {
        try {
            val nm = dlNotifier(); nm.cancel(id)
            val b = dlBuilder().setAutoCancel(true).setOnlyAlertOnce(true)
            if (error == null) {
                b.setSmallIcon(android.R.drawable.stat_sys_download_done).setContentTitle("Saved to Downloads").setContentText(name)
                if (uri != null) {
                    val view = Intent(Intent.ACTION_VIEW).setDataAndType(uri, mime.ifBlank { "*/*" }).addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK)
                    b.setContentIntent(android.app.PendingIntent.getActivity(this, id, view, android.app.PendingIntent.FLAG_UPDATE_CURRENT or android.app.PendingIntent.FLAG_IMMUTABLE))
                }
            } else b.setSmallIcon(android.R.drawable.stat_notify_error).setContentTitle("Couldn't save").setContentText("$name: $error")
            nm.notify(id, b.build())
        } catch (_: Exception) {}
        val j = org.json.JSONObject().put("name", name).put("ok", error == null).put("uri", uri?.toString() ?: "").put("mime", mime).put("error", error ?: "")
        runOnUiThread { web.evaluateJavascript("window.__qmSaved&&window.__qmSaved($j)", null) }
    }

    @Suppress("DEPRECATION")
    private fun immersive(on: Boolean) {
        if (Build.VERSION.SDK_INT >= 30) {
            window.insetsController?.let { c ->
                if (on) { c.hide(WindowInsets.Type.systemBars()); c.systemBarsBehavior = android.view.WindowInsetsController.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE }
                else c.show(WindowInsets.Type.systemBars())
            }
        } else run {
            window.decorView.systemUiVisibility = if (on) View.SYSTEM_UI_FLAG_FULLSCREEN or View.SYSTEM_UI_FLAG_HIDE_NAVIGATION or View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY or View.SYSTEM_UI_FLAG_LAYOUT_STABLE or View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN or View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
            else View.SYSTEM_UI_FLAG_LAYOUT_STABLE or View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN or View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
        }
    }

    /** Back is decided by the website (it minimises the call, closes the open chat, …) rather than walking WebView history,
     *  which could navigate a frame to a blank page. If the site has nothing to close, the app goes to the background. */
    @Deprecated("Deprecated in Java")
    override fun onBackPressed() {
        if (customView != null) { web.webChromeClient?.onHideCustomView(); return }
        web.evaluateJavascript("(function(){try{return !!(window.QM&&QM.androidBack&&QM.androidBack())}catch(e){return false}})()") { r ->
            if (r != "true") { if (protectedMode && locked()) requestUnlock() else moveTaskToBack(true) }
        }
    }

    // ------------------------------------------------------------------ camera / microphone for calls
    private fun askWebPermission(r: PermissionRequest) {
        val need = ArrayList<String>()
        for (res in r.resources) {
            if (res == PermissionRequest.RESOURCE_VIDEO_CAPTURE) need.add(Manifest.permission.CAMERA)
            if (res == PermissionRequest.RESOURCE_AUDIO_CAPTURE) need.add(Manifest.permission.RECORD_AUDIO)
        }
        val missing = need.filter { checkSelfPermission(it) != PackageManager.PERMISSION_GRANTED }
        if (missing.isEmpty()) { r.grant(r.resources); return }
        pendingWebPerm?.deny(); pendingWebPerm = r
        requestPermissions(missing.toTypedArray(), 10)
    }

    override fun onRequestPermissionsResult(code: Int, perms: Array<out String>, res: IntArray) {
        super.onRequestPermissionsResult(code, perms, res)
        if (code != 10) return
        val r = pendingWebPerm ?: return
        pendingWebPerm = null
        val granted = r.resources.filter {
            (it != PermissionRequest.RESOURCE_VIDEO_CAPTURE || checkSelfPermission(Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED) &&
            (it != PermissionRequest.RESOURCE_AUDIO_CAPTURE || checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED)
        }
        if (granted.isEmpty()) r.deny() else r.grant(granted.toTypedArray())
    }

    // ------------------------------------------------------------------ screen share + results
    @Deprecated("Deprecated in Java")
    override fun onActivityResult(req: Int, res: Int, data: Intent?) {
        super.onActivityResult(req, res, data)
        when (req) {
            REQ_FILE -> { fileCb?.onReceiveValue(WebChromeClient.FileChooserParams.parseResult(res, data)); fileCb = null }
            REQ_PROJECTION -> {
                if (res == RESULT_OK && data != null) beginProjection(res, data)
                else js("window.__qmScreenState&&window.__qmScreenState('denied')")
            }
        }
    }

    /** Shows the system unlock screen (PIN / fingerprint / face) on top of the call. */
    private fun requestUnlock() {
        if (Build.VERSION.SDK_INT < 26) return
        try { (getSystemService(KEYGUARD_SERVICE) as android.app.KeyguardManager).requestDismissKeyguard(this, null) } catch (_: Exception) {}
    }

    private fun js(code: String) { if (!isDestroyed) web.evaluateJavascript(code, null) }

    /** What the website can call (window.QMApp.*). */
    inner class Bridge {
        @JavascriptInterface fun isApp() = true

        /** Safe-area insets in CSS pixels, polled by js/bars.js in every frame. */
        @JavascriptInterface fun insets(): String = JSONObject().put("t", ins[0]).put("b", ins[1]).put("l", ins[2]).put("r", ins[3]).toString()
        @JavascriptInterface fun inPip() = pip
        @JavascriptInterface fun isForeground() = visible || pip
        /** Brings the app to full screen (out of PiP / background) — used by the in-page "Join" button before the call opens. */
        @JavascriptInterface fun bringToFront() = runOnUiThread {
            try { startActivity(Intent(this@MainActivity, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_REORDER_TO_FRONT or Intent.FLAG_ACTIVITY_SINGLE_TOP)) } catch (_: Exception) {}
        }
        @JavascriptInterface fun setCallDeaf(deafened: Boolean, useDeafenButton: Boolean) { NotifyService.setCallDeaf(this@MainActivity, deafened, useDeafenButton) }
        @JavascriptInterface fun setUploads(count: Int, pct: Int, text: String) {
            val src = System.identityHashCode(this)
            NotifyService.setUploads(applicationContext, src, count, pct, text.take(120))
            // a page that was kept alive only for its uploads is finished with them: let it go
            if (count <= 0) android.os.Handler(android.os.Looper.getMainLooper()).post { releaseHeadless(applicationContext, src) }
        }
        @JavascriptInterface fun uploadFailed(text: String) { NotifyService.uploadFailed(applicationContext, text.take(200)) }
        @JavascriptInterface fun setCallWho(who: String) { NotifyService.setCallWho(this@MainActivity, who.take(120)) }
        @JavascriptInterface fun setCallInfo(title: String, muted: Boolean, screen: Boolean, canScreen: Boolean, photo: String, startMs: Double) { NotifyService.setCallInfo(this@MainActivity, title.take(60), muted, screen, canScreen, if (photo.startsWith("https://") || photo.startsWith("data:image/")) photo.take(3_000_000) else "", startMs.toLong()) }

        /** Message protection: true while the phone is still locked after a call opened the app over the lock screen. */
        @JavascriptInterface fun isProtected(): Boolean {
            if (protectedMode && !locked()) protectedMode = false
            return protectedMode
        }
        @JavascriptInterface fun requestUnlock() = runOnUiThread { this@MainActivity.requestUnlock() }
        @JavascriptInterface fun endProtectedCall() = runOnUiThread {
            protectedMode = false
            if (Build.VERSION.SDK_INT >= 27) { setShowWhenLocked(false); setTurnScreenOn(false) }
            finishAndRemoveTask()
        }
        @JavascriptInterface fun enterPip() = runOnUiThread { pipRatio = Rational(16, 9); enterPipNow() }
        /** A chat video goes to picture-in-picture with its own controls. */
        @JavascriptInterface fun enterVideoPip(w: Int, h: Int, playing: Boolean) = runOnUiThread { pipVideo = true; pipPlaying = playing; if (w > 0 && h > 0) pipRatio = Rational(w.coerceIn(1, 4000), h.coerceIn(1, 4000)); enterPipNow() }
        /** State of the call buttons shown in the call's picture-in-picture window (mic, camera, deafen). */
        @JavascriptInterface fun setPipControls(muted: Boolean, camOn: Boolean, canCam: Boolean, deafened: Boolean) = runOnUiThread {
            if (pipMuted == muted && pipCamOn == camOn && pipCanCam == canCam && pipDeaf == deafened) return@runOnUiThread
            pipMuted = muted; pipCamOn = camOn; pipCanCam = canCam; pipDeaf = deafened; updatePip()
        }
        @JavascriptInterface fun setPipPlaying(playing: Boolean) = runOnUiThread { if (pipVideo && pipPlaying != playing) { pipPlaying = playing; updatePip() } }
        @JavascriptInterface fun enterPipSized(w: Int, h: Int) = runOnUiThread { if (w > 0 && h > 0) pipRatio = Rational(w.coerceIn(1, 4000), h.coerceIn(1, 4000)); enterPipNow() }

        /** The website says whether a call is up / on screen. */
        @JavascriptInterface fun setInCall(joined: Boolean, shown: Boolean) = runOnUiThread {
            inCall = joined; callVisible = joined && shown
            // Joined a call while the phone is locked (answered from the lock screen, or a call that started while it was locked):
            // lock the app down to the call until the user unlocks the phone.
            if (joined && locked()) {
                protectedMode = true
                if (Build.VERSION.SDK_INT >= 27) setShowWhenLocked(true)
            }
            NotifyService.setCall(this@MainActivity, joined)
            val am = getSystemService(AUDIO_SERVICE) as AudioManager
            am.mode = if (joined) AudioManager.MODE_IN_COMMUNICATION else AudioManager.MODE_NORMAL
            if (joined) {          // calls start on the speaker (the page may switch to the saved output a moment later)
                Telecomm.route(android.media.AudioDeviceInfo.TYPE_BUILTIN_SPEAKER)
                routeCall(am, android.media.AudioDeviceInfo.TYPE_BUILTIN_SPEAKER, null)
            }
            updatePip()
        }

        // ---- audio route: the app talks to Android directly (the WebView can only list/choose devices the browser way, which Android System WebView mostly doesn't offer)
        private fun audioKey(d: android.media.AudioDeviceInfo) = "${d.type}|${d.productName ?: ""}"
        private fun audioLabel(d: android.media.AudioDeviceInfo): String {
            val kind = when (d.type) {
                android.media.AudioDeviceInfo.TYPE_BUILTIN_EARPIECE -> "Phone earpiece"
                android.media.AudioDeviceInfo.TYPE_BUILTIN_SPEAKER -> "Phone speaker"
                android.media.AudioDeviceInfo.TYPE_BUILTIN_MIC -> "Phone microphone"
                android.media.AudioDeviceInfo.TYPE_WIRED_HEADSET, android.media.AudioDeviceInfo.TYPE_WIRED_HEADPHONES -> "Wired headset"
                android.media.AudioDeviceInfo.TYPE_USB_HEADSET, android.media.AudioDeviceInfo.TYPE_USB_DEVICE, android.media.AudioDeviceInfo.TYPE_USB_ACCESSORY -> "USB audio"
                android.media.AudioDeviceInfo.TYPE_BLUETOOTH_SCO, android.media.AudioDeviceInfo.TYPE_BLUETOOTH_A2DP -> "Bluetooth"
                else -> if (Build.VERSION.SDK_INT >= 31 && d.type == android.media.AudioDeviceInfo.TYPE_BLE_HEADSET) "Bluetooth LE" else "Audio device"
            }
            val n = d.productName?.toString()?.trim().orEmpty()
            return if (n.isBlank() || kind.contains(n, true) || d.type == android.media.AudioDeviceInfo.TYPE_BUILTIN_MIC || d.type == android.media.AudioDeviceInfo.TYPE_BUILTIN_SPEAKER || d.type == android.media.AudioDeviceInfo.TYPE_BUILTIN_EARPIECE) kind else "$kind ($n)"
        }
        private fun callType(t: Int) = when (t) { // a microphone type and its matching speaker type are the same physical headset
            android.media.AudioDeviceInfo.TYPE_WIRED_HEADPHONES -> android.media.AudioDeviceInfo.TYPE_WIRED_HEADSET
            android.media.AudioDeviceInfo.TYPE_BLUETOOTH_A2DP -> android.media.AudioDeviceInfo.TYPE_BLUETOOTH_SCO
            else -> t
        }
        private val OUT_TYPES = setOf(android.media.AudioDeviceInfo.TYPE_BUILTIN_EARPIECE, android.media.AudioDeviceInfo.TYPE_BUILTIN_SPEAKER, android.media.AudioDeviceInfo.TYPE_WIRED_HEADSET, android.media.AudioDeviceInfo.TYPE_WIRED_HEADPHONES, android.media.AudioDeviceInfo.TYPE_USB_HEADSET, android.media.AudioDeviceInfo.TYPE_USB_DEVICE, android.media.AudioDeviceInfo.TYPE_BLUETOOTH_SCO, android.media.AudioDeviceInfo.TYPE_BLUETOOTH_A2DP)
        private val IN_TYPES = setOf(android.media.AudioDeviceInfo.TYPE_BUILTIN_MIC, android.media.AudioDeviceInfo.TYPE_WIRED_HEADSET, android.media.AudioDeviceInfo.TYPE_USB_HEADSET, android.media.AudioDeviceInfo.TYPE_USB_DEVICE, android.media.AudioDeviceInfo.TYPE_BLUETOOTH_SCO)

        /** {"inputs":[{"id","name"}],"outputs":[…],"outId","inId"} — ids are stable across reboots ("type|product name"). */
        @JavascriptInterface fun audioDevices(): String {
            val am = getSystemService(AUDIO_SERVICE) as AudioManager
            fun arr(list: List<android.media.AudioDeviceInfo>) = org.json.JSONArray().also { a -> list.distinctBy { audioKey(it) }.forEach { a.put(JSONObject().put("id", audioKey(it)).put("name", audioLabel(it))) } }
            val o = JSONObject()
            o.put("inputs", arr(am.getDevices(AudioManager.GET_DEVICES_INPUTS).filter { it.type in IN_TYPES }))
            o.put("outputs", arr(am.getDevices(AudioManager.GET_DEVICES_OUTPUTS).filter { it.type in OUT_TYPES }))
            if (Build.VERSION.SDK_INT >= 31) am.communicationDevice?.let { o.put("outId", audioKey(it)) }
            return o.toString()
        }

        /** Sends the call's sound to this output (earpiece, speaker, wired, USB, Bluetooth). */
        @JavascriptInterface fun setAudioOutput(key: String): Boolean {
            val am = getSystemService(AUDIO_SERVICE) as AudioManager
            val dev = am.getDevices(AudioManager.GET_DEVICES_OUTPUTS).firstOrNull { audioKey(it) == key } ?: return false
            Telecomm.route(dev.type)
            return routeCall(am, dev.type, dev.id)
        }

        /** Uses this microphone. Android routes a headset's microphone and speaker together, so choosing e.g. a Bluetooth microphone also moves the sound there. */
        @JavascriptInterface fun setAudioInput(key: String): Boolean {
            val am = getSystemService(AUDIO_SERVICE) as AudioManager
            val dev = am.getDevices(AudioManager.GET_DEVICES_INPUTS).firstOrNull { audioKey(it) == key } ?: return false
            if (dev.type == android.media.AudioDeviceInfo.TYPE_BUILTIN_MIC) {          // the phone's own microphone: leave a headset if one is in use
                val cur = if (Build.VERSION.SDK_INT >= 31) am.communicationDevice?.type else null
                val builtIn = cur == android.media.AudioDeviceInfo.TYPE_BUILTIN_SPEAKER || cur == android.media.AudioDeviceInfo.TYPE_BUILTIN_EARPIECE
                if (!builtIn) Telecomm.route(android.media.AudioDeviceInfo.TYPE_BUILTIN_SPEAKER)
                return if (builtIn) true else routeCall(am, android.media.AudioDeviceInfo.TYPE_BUILTIN_SPEAKER, null)
            }
            Telecomm.route(callType(dev.type))
            return routeCall(am, callType(dev.type), null)
        }

        private fun routeCall(am: AudioManager, type: Int, id: Int?): Boolean = try {
            if (Build.VERSION.SDK_INT >= 31) {
                val c = am.availableCommunicationDevices
                val pick = c.firstOrNull { id != null && it.id == id } ?: c.firstOrNull { callType(it.type) == callType(type) }
                if (pick != null) am.setCommunicationDevice(pick) else false
            } else {
                @Suppress("DEPRECATION") when (callType(type)) {
                    android.media.AudioDeviceInfo.TYPE_BUILTIN_SPEAKER -> { am.stopBluetoothSco(); am.isBluetoothScoOn = false; am.isSpeakerphoneOn = true }
                    android.media.AudioDeviceInfo.TYPE_BLUETOOTH_SCO -> { am.isSpeakerphoneOn = false; am.startBluetoothSco(); am.isBluetoothScoOn = true }
                    else -> { am.stopBluetoothSco(); am.isBluetoothScoOn = false; am.isSpeakerphoneOn = false }
                }
                true
            }
        } catch (_: Exception) { false }

        /** Android 12+ wallpaper colours for "Material You": {"a1":{"100":"#RRGGBB",…},"n1":{…}}; empty on older Android. */
        @JavascriptInterface fun systemColors(): String {
            if (Build.VERSION.SDK_INT < 31) return ""
            return try {
                fun hx(id: Int) = String.format("#%06X", resources.getColor(id, theme) and 0xFFFFFF)
                val a = JSONObject().put("100", hx(android.R.color.system_accent1_100)).put("200", hx(android.R.color.system_accent1_200)).put("600", hx(android.R.color.system_accent1_600))
                    .put("700", hx(android.R.color.system_accent1_700)).put("800", hx(android.R.color.system_accent1_800))
                val n = JSONObject().put("10", hx(android.R.color.system_neutral1_10)).put("50", hx(android.R.color.system_neutral1_50)).put("100", hx(android.R.color.system_neutral1_100))
                    .put("200", hx(android.R.color.system_neutral1_200)).put("700", hx(android.R.color.system_neutral1_700)).put("800", hx(android.R.color.system_neutral1_800))
                    .put("900", hx(android.R.color.system_neutral1_900)).put("1000", hx(android.R.color.system_neutral1_1000))
                JSONObject().put("a1", a).put("n1", n).toString()
            } catch (_: Exception) { "" }
        }

        // ---- in-app updates (js/update.js)
        /** {"code":123,"name":"1.0.23"} of the installed app. */
        @JavascriptInterface fun appVersion(): String = try {
            val p = packageManager.getPackageInfo(packageName, 0)
            JSONObject().put("code", if (Build.VERSION.SDK_INT >= 28) p.longVersionCode else @Suppress("DEPRECATION") p.versionCode.toLong()).put("name", p.versionName ?: "").toString()
        } catch (_: Exception) { "{}" }
        /** Android only lets an app install packages after "Install unknown apps" was allowed for it. */
        @JavascriptInterface fun canInstallUpdates(): Boolean = Build.VERSION.SDK_INT < 26 || packageManager.canRequestPackageInstalls()
        @JavascriptInterface fun openInstallSettings() = runOnUiThread {
            try { startActivity(Intent(android.provider.Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:$packageName"))) } catch (_: Exception) {}
        }
        @JavascriptInterface fun downloadUpdate(url: String) { Updater.download(this@MainActivity, url) }
        // the page downloads the APK itself (works with hosts that block non-browser requests) and passes it in pieces
        @JavascriptInterface fun updateBegin(): Boolean = Updater.beginUpload(this@MainActivity)
        @JavascriptInterface fun updateChunk(b64: String): Boolean = Updater.uploadChunk(b64)
        @JavascriptInterface fun updateEnd() { Thread { Updater.finishUpload(this@MainActivity) }.start() }
        @JavascriptInterface fun updateAbort() { Updater.abortUpload() }

        @JavascriptInterface fun isDark(): Boolean = (resources.configuration.uiMode and android.content.res.Configuration.UI_MODE_NIGHT_MASK) == android.content.res.Configuration.UI_MODE_NIGHT_YES

        /** Google sign-in can't run inside a WebView, so it happens in the browser and comes back via quickmessage://auth. */
        @JavascriptInterface fun googleSignIn() = runOnUiThread {
            try { startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(Config.SITE_URL + "app-login.html"))) } catch (_: Exception) { js("window.__qmGoogleSignIn&&window.__qmGoogleSignIn('','no-browser')") }
        }

        @JavascriptInterface fun openNotificationSettings() = runOnUiThread {
            try {
                startActivity(Intent(android.provider.Settings.ACTION_APP_NOTIFICATION_SETTINGS).putExtra(android.provider.Settings.EXTRA_APP_PACKAGE, packageName))
            } catch (_: Exception) {}
        }

        /** The video being popped out: Android's PiP window takes its shape (updated as the video's size changes). */
        @JavascriptInterface fun setPipRatio(w: Int, h: Int) = runOnUiThread { pipRatio = if (w > 0 && h > 0) Rational(w.coerceIn(1, 4000), h.coerceIn(1, 4000)) else Rational(16, 9); updatePip() }

        @JavascriptInterface fun notifyEnabled() = Store(this@MainActivity).notify
        @JavascriptInterface fun canNotify() = Build.VERSION.SDK_INT < 33 || checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED
        @JavascriptInterface fun setNotify(on: Boolean) = runOnUiThread {
            Store(this@MainActivity).notify = on
            if (on) {
                if (Build.VERSION.SDK_INT >= 33 && !canNotify()) requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), REQ_PERMS)
                NotifyService.start(this@MainActivity)
            } else if (!inCall) NotifyService.stop(this@MainActivity)
        }

        @JavascriptInterface fun startScreen() = runOnUiThread {
            val pend = pendingProjection; pendingProjection = null
            if (pend != null) { beginProjection(pend.first, pend.second); return@runOnUiThread }
            val mpm = getSystemService(MEDIA_PROJECTION_SERVICE) as MediaProjectionManager
            @Suppress("DEPRECATION") startActivityForResult(mpm.createScreenCaptureIntent(), REQ_PROJECTION)
        }

        @JavascriptInterface fun setScreenQuality(edge: Int, quality: Int, fps: Int) { ScreenService.maxEdge = edge.coerceIn(480, 2560); ScreenService.jpegQuality = quality.coerceIn(30, 95); ScreenService.fps = fps.coerceIn(1, 30) }
        @JavascriptInterface fun stopScreen() { ScreenService.stop(this@MainActivity) }
        /** Downloads a link into Downloads, with a progress notification, then a "Saved" notification (tap to open) and a message in the page. */
        @JavascriptInterface fun downloadUrl(url: String, name: String) {
            if (!(url.startsWith("https://") || url.startsWith("http://"))) return
            val safe = safeName(name)
            val nid = dlIds.incrementAndGet()
            Thread {
                var mime = ""
                try {
                    progress(nid, safe, -1)
                    val c = java.net.URL(url).openConnection() as java.net.HttpURLConnection
                    c.connectTimeout = 15000; c.readTimeout = 30000; c.instanceFollowRedirects = true
                    c.setRequestProperty("User-Agent", "Mozilla/5.0 (Android) QuickMessage")
                    if (c.responseCode !in 200..299) throw java.io.IOException("HTTP " + c.responseCode)
                    mime = (c.contentType ?: "").substringBefore(";").trim().ifBlank { guessMime(safe) }
                    val total = c.contentLengthLong
                    val uri = saveToDownloads(safe, mime) { out ->
                        c.inputStream.use { input ->
                            val buf = ByteArray(32 * 1024); var done = 0L; var last = 0L
                            while (true) {
                                val n = input.read(buf); if (n < 0) break
                                out.write(buf, 0, n); done += n
                                val now = System.currentTimeMillis()
                                if (now - last > 400) { last = now; progress(nid, safe, if (total > 0) (done * 100 / total).toInt() else -1) }
                            }
                        }
                    }
                    saved(nid, safe, uri, mime, null)
                } catch (e: Exception) { saved(nid, safe, null, mime, e.message ?: "failed") }
            }.start()
        }
        /** Saves a file the page built itself (a decrypted attachment, a blob) into Downloads. */
        @JavascriptInterface fun saveFile(name: String, mime: String, b64: String) {
            val safe = safeName(name)
            val nid = dlIds.incrementAndGet()
            Thread {
                try {
                    val bytes = android.util.Base64.decode(b64, android.util.Base64.DEFAULT)
                    val m = mime.ifBlank { guessMime(safe) }
                    val uri = saveToDownloads(safe, m) { it.write(bytes) }
                    saved(nid, safe, uri, m, null)
                } catch (e: Exception) { saved(nid, safe, null, mime, e.message ?: "failed") }
            }.start()
        }
        /** Opens a saved file with another app (used by the "Open" button after a download, and for files this app can't show). */
        @JavascriptInterface fun openFile(uri: String, mime: String) = runOnUiThread {
            try {
                val i = Intent(Intent.ACTION_VIEW).setDataAndType(Uri.parse(uri), mime.ifBlank { "*/*" }).addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK)
                startActivity(Intent.createChooser(i, "Open with").addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
            } catch (_: Exception) { android.widget.Toast.makeText(this@MainActivity, "No app can open this file", android.widget.Toast.LENGTH_SHORT).show() }
        }
        /** Link previews: is the Android app [pkg] installed and able to open this https link? (then the page offers "open in app") */
        @JavascriptInterface fun canOpenApp(pkg: String, url: String): Boolean {
            if (!Regex("^[A-Za-z][\\w]*(\\.[\\w]+)+$").matches(pkg) || !(url.startsWith("https://") || url.startsWith("http://"))) return false
            return try { packageManager.queryIntentActivities(Intent(Intent.ACTION_VIEW, Uri.parse(url)).setPackage(pkg), 0).isNotEmpty() } catch (_: Exception) { false }
        }
        @JavascriptInterface fun openInApp(pkg: String, url: String) = runOnUiThread {
            if (!Regex("^[A-Za-z][\\w]*(\\.[\\w]+)+$").matches(pkg) || !(url.startsWith("https://") || url.startsWith("http://"))) return@runOnUiThread
            try { startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url)).setPackage(pkg).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) }
            catch (_: Exception) { try { startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) } catch (_: Exception) {} }
        }
        /** The login screen's "Private server" box: "" = back to Firebase. The server serves the site itself, so the app simply opens it. */
        @JavascriptInterface fun setServer(url: String) {
            var u = url.trim()
            if (u.isNotEmpty() && !Regex("^https?://[^\\s/@]+(/[^\\s]*)?$").matches(u)) return
            if (u.isNotEmpty() && !u.endsWith("/")) u += "/"
            Push.unregister(this@MainActivity); Crypt.forget(); Store(this@MainActivity).forget(); NotifyService.stop(this@MainActivity)
            Config.setServer(this@MainActivity, u)
            runOnUiThread { web.loadUrl(Config.SITE_URL + "index.html") }
        }
        @JavascriptInterface fun setDbUrl(url: String) {
            val s = Store(this@MainActivity)
            if (Regex("^https://[a-z0-9.-]+\\.(firebaseio\\.com|firebasedatabase\\.app)$").matches(url) && s.dbUrl != url) s.dbUrl = url
        }
        @JavascriptInterface fun setSession(uid: String, refreshToken: String) {
            val s = Store(this@MainActivity)
            if (s.uid != uid || s.refreshToken != refreshToken) { s.uid = uid; s.refreshToken = refreshToken }
            Push.register(this@MainActivity)                // registers this phone for push (once); the live connection ends when that works
            NotifyService.start(this@MainActivity)
            runOnUiThread { askBatteryOnce() }
        }

        @JavascriptInterface fun setCryptoKey(uid: String, jwk: String) {
            val s = Store(this@MainActivity)
            if (s.uid == uid && jwk.length < 2000 && s.cryptoJwk != jwk) { s.cryptoJwk = jwk; Crypt.forget() }
        }

        @JavascriptInterface fun logout() { Push.unregister(this@MainActivity); Crypt.forget(); Store(this@MainActivity).forget(); NotifyService.stop(this@MainActivity) }
        /** The page sent or read something in this chat: the notification / bubble for it is refreshed to match. */
        @JavascriptInterface fun chatSync(chatId: String) { if (chatId.length in 1..80) NotifyService.sync(this@MainActivity, chatId) }

        @JavascriptInterface fun clearCache() = runOnUiThread { web.clearCache(true) }   // HTTP cache only: signing in lives in site storage, which stays

        /** Colours the area behind the status and navigation bars like the site's background. */
        @JavascriptInterface fun setBars(color: String, lightBackground: Boolean) = runOnUiThread {
            try { barColor = Color.parseColor(color) } catch (_: Exception) { return@runOnUiThread }
            root.setBackgroundColor(barColor)
            if (Build.VERSION.SDK_INT >= 30) {
                val m = android.view.WindowInsetsController.APPEARANCE_LIGHT_STATUS_BARS or android.view.WindowInsetsController.APPEARANCE_LIGHT_NAVIGATION_BARS
                window.insetsController?.setSystemBarsAppearance(if (lightBackground) m else 0, m)
            } else {
                @Suppress("DEPRECATION") run {
                    var f = window.decorView.systemUiVisibility
                    f = if (lightBackground) f or View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR else f and View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR.inv()
                    window.decorView.systemUiVisibility = f
                }
            }
        }
    }
}
