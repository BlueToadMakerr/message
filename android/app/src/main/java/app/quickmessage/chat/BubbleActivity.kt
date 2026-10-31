package app.quickmessage.chat

import android.annotation.SuppressLint
import android.app.Activity
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.Color
import android.os.Message
import android.net.Uri
import android.os.Bundle
import android.webkit.*
import android.widget.FrameLayout

/**
 * The floating chat bubble. It shows ONE chat (message.html?bubble=1) and nothing else: the page hides its back / call buttons and
 * this activity refuses to navigate anywhere but that chat, so the rest of the app is not reachable from a bubble — the same
 * "call area only" idea as the lock-screen protection. It shares the app's sign-in (same WebView storage) but runs its own page.
 */
class BubbleActivity : Activity() {
    private lateinit var web: WebView
    private var chat = ""
    private var fileCb: ValueCallback<Array<Uri>>? = null
    private var camReq: PermissionRequest? = null
    private companion object { const val REQ_FILE = 2; const val REQ_CAM = 11 }

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(b: Bundle?) {
        Config.init(this)
        super.onCreate(b)
        chat = intent?.getStringExtra(MainActivity.EXTRA_CHAT).orEmpty()
        if (!Regex("^[\\w-]{1,64}$").matches(chat)) { finish(); return }
        val root = FrameLayout(this).apply { setBackgroundColor(Color.WHITE) }
        web = WebView(this)
        root.addView(web, FrameLayout.LayoutParams(-1, -1))
        setContentView(root)
        web.settings.apply {
            javaScriptEnabled = true; setSupportZoom(false); builtInZoomControls = false; displayZoomControls = false; domStorageEnabled = true; mediaPlaybackRequiresUserGesture = true
            allowFileAccess = false; allowContentAccess = false
        }
        web.addJavascriptInterface(Bridge(), "QMApp")
        web.settings.setSupportMultipleWindows(true)
        val allowed = Config.SITE_URL + "message.html"
        web.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(v: WebView, r: WebResourceRequest): Boolean {
                val u = r.url.toString()
                if (u.startsWith(allowed) && r.url.getQueryParameter("chatId") == chat) return false
                // Other web links open in the browser as usual; anything else inside the app stays out of reach of a bubble.
                val site = Uri.parse(Config.SITE_URL)
                if ((r.url.scheme == "https" || r.url.scheme == "http") && r.url.host != site.host) {
                    try { startActivity(Intent(Intent.ACTION_VIEW, r.url).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) } catch (_: Exception) {}
                }
                return true
            }
            // No connection: the same offline page as the main app (with a "Try again" button), not Android's "Webpage not available".
            override fun onReceivedError(v: WebView, r: WebResourceRequest, e: WebResourceError) {
                if (!r.isForMainFrame || r.url.scheme == "file") return
                val code = (e.description?.toString() ?: "").removePrefix("net::")
                v.loadUrl("file:///android_asset/offline.html?code=" + Uri.encode(code) + "&url=" + Uri.encode(r.url.toString()))
            }
        }
        web.webChromeClient = object : WebChromeClient() {
            // Camera (taking a photo for the chat) is allowed; the microphone is not (no calls from a bubble).
            override fun onPermissionRequest(r: PermissionRequest) { runOnUiThread { askCamera(r) } }
            override fun onCreateWindow(view: WebView, isDialog: Boolean, isUserGesture: Boolean, resultMsg: Message): Boolean = externalWindow(view, resultMsg)           // no camera / microphone in a bubble
            override fun onShowFileChooser(w: WebView, cb: ValueCallback<Array<Uri>>, p: FileChooserParams): Boolean {
                fileCb?.onReceiveValue(null); fileCb = cb
                return try { startActivityForResult(p.createIntent(), REQ_FILE); true } catch (_: Exception) { fileCb = null; false }
            }
        }
        web.loadUrl("$allowed?chatId=$chat&standalone=1&bubble=1")
    }

    /** The little part of the app bridge a bubble needs: no safe-area padding (the bubble window has none), light/dark, nothing else. */
    inner class Bridge {
        @JavascriptInterface fun isApp() = true
        @JavascriptInterface fun insets(): String = "{\"t\":0,\"b\":0,\"l\":0,\"r\":0}"
        @JavascriptInterface fun inPip() = false
        @JavascriptInterface fun isForeground() = true
        @JavascriptInterface fun setBars(color: String, lightBackground: Boolean) {}
        @JavascriptInterface fun isDark(): Boolean = (resources.configuration.uiMode and android.content.res.Configuration.UI_MODE_NIGHT_MASK) == android.content.res.Configuration.UI_MODE_NIGHT_YES
    }

    /** target="_blank" / window.open: open the link in the browser. */
    private fun externalWindow(view: WebView, resultMsg: Message): Boolean {
        val tmp = WebView(view.context)
        val open = { u: Uri? -> if (u != null && (u.scheme == "https" || u.scheme == "http")) { try { startActivity(Intent(Intent.ACTION_VIEW, u).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) } catch (_: Exception) {} } }
        tmp.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(v: WebView, r: WebResourceRequest): Boolean { open(r.url); v.destroy(); return true }
            override fun onPageStarted(v: WebView, url: String?, f: Bitmap?) { if (url != null && url != "about:blank") { open(Uri.parse(url)); v.stopLoading(); v.destroy() } }
        }
        (resultMsg.obj as WebView.WebViewTransport).webView = tmp
        resultMsg.sendToTarget()
        return true
    }

    private fun askCamera(r: PermissionRequest) {
        val video = r.resources.filter { it == PermissionRequest.RESOURCE_VIDEO_CAPTURE }.toTypedArray()
        if (video.isEmpty()) { r.deny(); return }
        if (checkSelfPermission(android.Manifest.permission.CAMERA) == android.content.pm.PackageManager.PERMISSION_GRANTED) { r.grant(video); return }
        camReq?.deny(); camReq = r
        requestPermissions(arrayOf(android.Manifest.permission.CAMERA), REQ_CAM)
    }

    override fun onRequestPermissionsResult(code: Int, perms: Array<out String>, res: IntArray) {
        super.onRequestPermissionsResult(code, perms, res)
        if (code != REQ_CAM) return
        val r = camReq ?: return; camReq = null
        if (res.isNotEmpty() && res[0] == android.content.pm.PackageManager.PERMISSION_GRANTED) r.grant(arrayOf(PermissionRequest.RESOURCE_VIDEO_CAPTURE)) else r.deny()
    }

    @Deprecated("Deprecated in Java")
    override fun onActivityResult(req: Int, res: Int, data: Intent?) {
        super.onActivityResult(req, res, data)
        if (req == REQ_FILE) { fileCb?.onReceiveValue(WebChromeClient.FileChooserParams.parseResult(res, data)); fileCb = null }
    }

    override fun onDestroy() { web.destroy(); super.onDestroy() }
}
