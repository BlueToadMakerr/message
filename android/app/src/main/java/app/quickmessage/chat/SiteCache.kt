package app.quickmessage.chat

import android.content.Context
import android.net.Uri
import android.webkit.CookieManager
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import org.json.JSONObject
import java.io.ByteArrayInputStream
import java.io.File
import java.net.HttpURLConnection
import java.net.URL
import java.security.MessageDigest

/**
 * The app has no service worker, so this plays its part (same rules as firebase-messaging-sw.js on the website):
 *  - every page / script / style / picture of the site that is fetched is kept on the phone, one copy per file (the ?query doesn't matter,
 *    so message.html?chatId=… of ANY chat opens offline once message.html has been fetched);
 *  - network first: the host is asked every time; the saved copy is used when it can't be reached, answers 5xx, or sends a "checking your browser" page;
 *  - Data Saver (Account → Data Saver) uses saved files without asking the host for newer ones;
 *  - "Refresh site" fetches everything again and then drops what wasn't refreshed (prune), so old pages don't linger.
 * The database, PHP helpers, version.json and downloads are never kept.
 */
object SiteCache {
    private var dir: File? = null
    private const val MAX = 8 * 1024 * 1024

    fun init(ctx: Context) { if (dir == null) dir = File(ctx.filesDir, "sitecache").apply { mkdirs() } }

    private fun cacheable(u: Uri): Boolean {
        val p = u.path ?: return false
        if (Regex("\\.php$|version\\.json$|/api/|/downloads/|firebase-messaging-sw\\.js$", RegexOption.IGNORE_CASE).containsMatchIn(p)) return false
        return p.endsWith("/") || Regex("\\.(html|js|css|svg|png|webmanifest|json|woff2?)$", RegexOption.IGNORE_CASE).containsMatchIn(p)
    }
    private fun key(u: Uri): String {
        val d = MessageDigest.getInstance("SHA-1").digest((u.scheme + "://" + u.host + (if (u.port > 0) ":" + u.port else "") + u.path).toByteArray())
        return d.joinToString("") { "%02x".format(it) }
    }
    private fun wantsHtml(u: Uri) = (u.path ?: "").let { it.endsWith(".html") || it.endsWith("/") }

    private fun read(k: String): WebResourceResponse? {
        val d = dir ?: return null
        val body = File(d, "$k.bin"); val meta = File(d, "$k.json")
        if (!body.exists() || !meta.exists()) return null
        return try {
            val m = JSONObject(meta.readText())
            WebResourceResponse(m.optString("mime", "application/octet-stream"), if (m.isNull("enc")) null else m.getString("enc"), 200, "OK", mapOf("Cache-Control" to "no-cache", "X-QM-Saved" to "1"), ByteArrayInputStream(body.readBytes()))
        } catch (_: Exception) { null }
    }
    private fun write(k: String, mime: String, enc: String?, bytes: ByteArray) {
        val d = dir ?: return
        try {
            File(d, "$k.bin.tmp").writeBytes(bytes); File(d, "$k.bin.tmp").renameTo(File(d, "$k.bin"))
            File(d, "$k.json").writeText(JSONObject().put("mime", mime).put("enc", enc ?: JSONObject.NULL).put("ts", System.currentTimeMillis()).toString())
        } catch (_: Exception) { /* storage full: just no copy */ }
    }
    /** Drop every saved file that was not saved at or after [since] (called after "Refresh site" has fetched the files again). */
    fun prune(since: Long): Int {
        var n = 0
        dir?.listFiles { f -> f.name.endsWith(".json") }?.forEach { f ->
            val ts = try { JSONObject(f.readText()).optLong("ts", 0) } catch (_: Exception) { 0L }
            if (ts < since) { f.delete(); File(f.parentFile, f.name.removeSuffix(".json") + ".bin").delete(); n++ }
        }
        return n
    }
    fun clear() { dir?.listFiles()?.forEach { it.delete() } }
    fun count(): Int = dir?.listFiles { f -> f.name.endsWith(".json") }?.size ?: 0

    /** Called from WebViewClient.shouldInterceptRequest (a background thread). null = let the WebView load it itself. */
    fun serve(r: WebResourceRequest, siteHost: String?): WebResourceResponse? {
        if (dir == null || r.method != "GET" || r.url.host != siteHost || !cacheable(r.url)) return null
        val k = key(r.url)
        val h = r.requestHeaders
        val forced = (h["Cache-Control"] ?: "").let { it.contains("no-cache") || it.contains("max-age=0") || it.contains("no-store") } || h["Pragma"] == "no-cache"
        if (!forced && DataSaver.active()) read(k)?.let { return it }
        val url = r.url.toString()
        try {
            val c = URL(url).openConnection() as HttpURLConnection
            c.connectTimeout = 8000; c.readTimeout = 12000; c.instanceFollowRedirects = false; c.requestMethod = "GET"
            for ((n, v) in h) if (n.lowercase() !in setOf("accept-encoding", "if-none-match", "if-modified-since", "cookie", "host", "range", "cache-control", "pragma")) c.setRequestProperty(n, v)
            CookieManager.getInstance().getCookie(url)?.let { c.setRequestProperty("Cookie", it) }
            val code = c.responseCode
            c.headerFields?.get("Set-Cookie")?.forEach { CookieManager.getInstance().setCookie(url, it) }
            if (code in 300..399) { c.disconnect(); return null }                     // redirects: the WebView follows them itself
            if (code != 200) { c.disconnect(); return if (code >= 500) read(k) else null }
            val type = c.contentType ?: ""
            val mime = type.substringBefore(';').trim().ifEmpty { "application/octet-stream" }
            val enc = Regex("charset=([^;\\s]+)", RegexOption.IGNORE_CASE).find(type)?.groupValues?.get(1)
            val bytes = c.inputStream.use { it.readBytes() }
            c.disconnect()
            var good = true
            if (mime.equals("text/html", true) && !wantsHtml(r.url)) good = false              // a host "checking your browser" page where a script should be
            if (good && wantsHtml(r.url)) { val t = String(bytes, Charsets.UTF_8); if (!t.contains("</html>", true) || Regex("slowAES|aes\\.js").containsMatchIn(t)) good = false }
            if (!good) return read(k) ?: WebResourceResponse(mime, enc, 200, "OK", mapOf("Cache-Control" to "no-cache"), ByteArrayInputStream(bytes))
            if (bytes.size <= MAX) write(k, mime, enc, bytes)
            return WebResourceResponse(mime, enc, 200, "OK", mapOf("Cache-Control" to "no-cache"), ByteArrayInputStream(bytes))
        } catch (_: Exception) {
            return read(k)                                                                  // offline / timeout: the saved copy (null if there is none: the WebView then shows our offline page)
        }
    }
}
