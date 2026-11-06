package app.quickmessage.chat

import android.content.Context
import org.json.JSONObject
import java.io.BufferedReader
import java.io.InputStreamReader
import java.net.HttpURLConnection
import java.net.URL

/** Project settings. Copy these from js/firebase.js on the website. */
object Config {
    const val API_KEY = "AIzaSyBNynmpC9-jTZd56WnpsjnbJa7THeyTMWY"
    // The default Realtime Database URL for project quickmessage-ac953. If your database was created in another region it
    // looks like https://quickmessage-ac953-default-rtdb.<region>.firebasedatabase.app (see Firebase console > Realtime Database).
    const val DB_URL = "https://quickmessage-ac953-default-rtdb.firebaseio.com"
    /** Where the website lives (the app is a native shell around it). Keep the trailing slash. */
    const val DEFAULT_SITE = "https://msg.infinityfreeapp.com/"
    /** A private server (server/qm_server.py) entered on the login screen: it serves the site and replaces Firebase. "" = Firebase. Ends with "/". */
    @Volatile var privateServer: String = ""
    /** The page the app shows. */
    val SITE_URL: String get() = if (privateServer.isNotEmpty()) privateServer else DEFAULT_SITE
    fun init(ctx: Context) { privateServer = ctx.getSharedPreferences("quickmessage", Context.MODE_PRIVATE).getString("server", "") ?: "" }
    fun setServer(ctx: Context, url: String) { ctx.getSharedPreferences("quickmessage", Context.MODE_PRIVATE).edit().putString("server", url).apply(); privateServer = url }
}

class ApiException(val code: Int, message: String) : Exception(message)

/** Persistent app state: the signed-in account, handed over by the website (js/app-bridge.js). */
class Store(ctx: Context) {
    private val p = ctx.getSharedPreferences("quickmessage", Context.MODE_PRIVATE)
    init { Config.init(ctx) }
    var refreshToken: String?
        get() = p.getString("rt", null)
        set(v) { p.edit().putString("rt", v).apply() }
    var uid: String?
        get() = p.getString("uid", null)
        set(v) { p.edit().putString("uid", v).apply() }
    /** Notifications on/off (the bell on the website's chat list). */
    var notify: Boolean
        get() = p.getBoolean("notify", true)
        set(v) { p.edit().putBoolean("notify", v).apply() }
    /** The account's end-to-end private key (JWK), handed over by the website so notifications can be decrypted. Private to the app. */
    var cryptoJwk: String?
        get() = p.getString("cjwk", null)
        set(v) { p.edit().putString("cjwk", v).apply() }
    /** The Realtime Database this account uses (the website's "Advanced" setting); the built-in one unless changed. */
    var dbUrl: String
        get() = p.getString("dburl", null)?.takeIf { Regex("^https://[a-z0-9.-]+\\.(firebaseio\\.com|firebasedatabase\\.app)$").matches(it) } ?: Config.DB_URL
        set(v) { p.edit().putString("dburl", v).apply() }
    /** Push (FCM) registration of this device: the token, the account it was registered for, and "uid|token" once the database has it. */
    var pushToken: String?
        get() = p.getString("ptok", null)
        set(v) { p.edit().putString("ptok", v).apply() }
    var pushUid: String?
        get() = p.getString("puid", null)
        set(v) { p.edit().putString("puid", v).apply() }
    var pushOk: String?
        get() = p.getString("pok", null)
        set(v) { p.edit().putString("pok", v).apply() }
    val signedIn: Boolean get() = uid != null && refreshToken != null
    fun forget() {
        val n = notify; val d = p.getString("dburl", null); val sv = p.getString("server", null)
        val e = p.edit(); e.clear(); e.putBoolean("notify", n); if (d != null) e.putString("dburl", d); if (sv != null) e.putString("server", sv); e.apply()
    }
}

/** Minimal Firebase client over REST (anonymous auth + Realtime Database + server-sent events). */
class Firebase(private val store: Store) {
    @Volatile private var idToken: String? = null
    @Volatile private var tokenAt = 0L

    private fun http(url: String, method: String, body: String? = null, form: Boolean = false, accept: String? = null): HttpURLConnection {
        val c = URL(url).openConnection() as HttpURLConnection
        c.requestMethod = method
        c.connectTimeout = 15000
        c.readTimeout = if (accept != null) 0 else 20000
        if (accept != null) c.setRequestProperty("Accept", accept)
        if (body != null) {
            c.doOutput = true
            c.setRequestProperty("Content-Type", if (form) "application/x-www-form-urlencoded" else "application/json")
            c.outputStream.use { it.write(body.toByteArray()) }
        }
        return c
    }

    private fun read(c: HttpURLConnection): String {
        val code = c.responseCode
        val text = (if (code in 200..299) c.inputStream else c.errorStream)?.bufferedReader()?.readText() ?: ""
        if (code !in 200..299) throw ApiException(code, text.take(200))
        return text
    }

    /** Refreshes the signed-in user's token (the refresh token comes from the website). */
    @Synchronized fun token(): String {
        val cur = idToken
        if (cur != null && System.currentTimeMillis() - tokenAt < 50 * 60 * 1000) return cur
        val rt = store.refreshToken ?: throw ApiException(401, "not signed in")
        if (Config.privateServer.isNotEmpty()) {            // private server: the session token is renewed by the server itself
            val c = http(Config.privateServer + "api/auth/me", "GET"); c.setRequestProperty("Authorization", "Bearer $rt")
            val j = JSONObject(read(c))
            store.refreshToken = j.getString("token"); idToken = j.getString("token"); tokenAt = System.currentTimeMillis()
            return idToken!!
        }
        val j = JSONObject(read(http("https://securetoken.googleapis.com/v1/token?key=${Config.API_KEY}", "POST",
            "grant_type=refresh_token&refresh_token=$rt", form = true)))
        store.refreshToken = j.getString("refresh_token")
        idToken = j.getString("id_token")
        tokenAt = System.currentTimeMillis()
        return idToken!!
    }

    // A private server answers the same REST calls under /db/ (see server/qm_server.py), so nothing else in the app has to know the difference.
    private fun url(path: String) = (if (Config.privateServer.isNotEmpty()) "${Config.privateServer}db" else store.dbUrl) + "/${path.trim('/')}.json?auth=${token()}"

    /** Returns the JSON value at [path] (JSONObject, String, Number, Boolean) or null. */
    fun get(path: String): Any? = parse(read(http(url(path), "GET")))
    fun put(path: String, json: String) { read(http(url(path), "PUT", json)) }
    fun patch(path: String, json: String) { read(http(url(path), "PATCH", json)) }
    /** Pushes a child with a new database key and returns that key. */
    fun post(path: String, json: String): String = JSONObject(read(http(url(path), "POST", json))).optString("name")
    /** The last [n] children of [path], ordered by key (oldest first as a list of key → value). */
    fun recent(path: String, n: Int): List<Pair<String, JSONObject>> {
        val t = read(http(url(path) + "&orderBy=%22%24key%22&limitToLast=$n", "GET"))
        val o = parse(t) as? JSONObject ?: return emptyList()
        return o.keys().asSequence().sorted().mapNotNull { k -> o.optJSONObject(k)?.let { k to it } }.toList()
    }
    fun delete(path: String) { read(http(url(path), "DELETE")) }

    private fun parse(t: String): Any? {
        val s = t.trim()
        return when {
            s == "null" || s.isEmpty() -> null
            s.startsWith("{") -> JSONObject(s)
            s.startsWith("\"") -> org.json.JSONTokener(s).nextValue()
            else -> org.json.JSONTokener(s).nextValue()
        }
    }

    /**
     * Blocks, calling [onEvent](event, path, data) for every put/patch until the stream ends or [alive] turns false.
     * Returns normally when the server closes the stream (token expiry, network) so the caller can reconnect.
     */
    fun stream(path: String, alive: () -> Boolean, onEvent: (String, String, Any?) -> Unit) {
        val c = http(url(path), "GET", accept = "text/event-stream")
        if (c.responseCode !in 200..299) throw ApiException(c.responseCode, c.errorStream?.bufferedReader()?.readText()?.take(200) ?: "")
        BufferedReader(InputStreamReader(c.inputStream)).use { r ->
            var event = ""
            while (alive()) {
                val line = r.readLine() ?: break
                when {
                    line.startsWith("event:") -> event = line.removePrefix("event:").trim()
                    line.startsWith("data:") -> {
                        val d = line.removePrefix("data:").trim()
                        if (event == "put" || event == "patch") {
                            val j = JSONObject(d)
                            onEvent(event, j.optString("path", "/"), if (j.isNull("data")) null else j.get("data"))
                        } else if (event == "cancel" || event == "auth_revoked") break
                    }
                }
            }
        }
        c.disconnect()
    }
}
