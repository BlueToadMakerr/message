package app.quickmessage.chat

import android.util.Base64
import org.json.JSONObject
import java.math.BigInteger
import java.security.*
import java.security.spec.*
import java.util.concurrent.ConcurrentHashMap
import javax.crypto.Cipher
import javax.crypto.KeyAgreement
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec

/**
 * The phone's side of the website's end-to-end encryption (js/crypto.js), so notifications show the real text.
 * The website hands over the account's private key (QMApp.setCryptoKey); everything else mirrors the page:
 *   chat key  = AES-GCM( ECDH(my private, wrapper's public) ) unwrap of privateChats/{chat}/keys/{me}, AAD "qm:{chat}"
 *   message   = "1." + base64(iv) + "." + base64(ciphertext+tag), same key and AAD
 */
object Crypt {
    private val spec: ECParameterSpec by lazy {
        AlgorithmParameters.getInstance("EC").apply { init(ECGenParameterSpec("secp256r1")) }.getParameterSpec(ECParameterSpec::class.java)
    }
    private val keys = ConcurrentHashMap<String, ByteArray>()      // chatId -> raw chat key

    private fun u(s: String) = Base64.decode(s, Base64.URL_SAFE or Base64.NO_PADDING or Base64.NO_WRAP)
    private fun std(s: String) = Base64.decode(s, Base64.DEFAULT)
    private fun stdOut(b: ByteArray) = Base64.encodeToString(b, Base64.NO_WRAP)
    private fun pub(x: String, y: String): PublicKey =
        KeyFactory.getInstance("EC").generatePublic(ECPublicKeySpec(ECPoint(BigInteger(1, u(x)), BigInteger(1, u(y))), spec))
    private fun priv(d: String): PrivateKey =
        KeyFactory.getInstance("EC").generatePrivate(ECPrivateKeySpec(BigInteger(1, u(d)), spec))
    private fun gcm(mode: Int, key: ByteArray, iv: ByteArray, chatId: String, data: ByteArray): ByteArray =
        Cipher.getInstance("AES/GCM/NoPadding").run {
            init(mode, SecretKeySpec(key, "AES"), GCMParameterSpec(128, iv)); updateAAD(("qm:$chatId").toByteArray()); doFinal(data)
        }

    fun forget() = keys.clear()
    fun drop(chatId: String) { keys.remove(chatId) }
    fun cached(chatId: String): ByteArray? = keys[chatId]

    /** The chat's raw key, or null when this phone can't open it (no private key yet, or the chat isn't keyed for this account). */
    fun chatKey(fb: Firebase, store: Store, chatId: String): ByteArray? {
        keys[chatId]?.let { return it }
        val me = store.uid ?: return null
        val jwk = try { JSONObject(store.cryptoJwk ?: return null) } catch (_: Exception) { return null }
        return try {
            val rec = fb.get("privateChats/$chatId/keys/$me") as? JSONObject ?: return null
            val by = rec.optString("by")
            val x: String; val y: String
            if (by == me) { x = jwk.getString("x"); y = jwk.getString("y") }
            else {
                val p = (fb.get("userKeys/$by/pub") as? String)?.split(".") ?: return null
                if (p.size != 2) return null
                x = p[0]; y = p[1]
            }
            val ka = KeyAgreement.getInstance("ECDH").apply { init(priv(jwk.getString("d"))); doPhase(pub(x, y), true) }
            val shared = ka.generateSecret().let { if (it.size > 32) it.copyOfRange(it.size - 32, it.size) else it }
            val raw = gcm(Cipher.DECRYPT_MODE, shared, std(rec.getString("iv")), chatId, std(rec.getString("ct")))
            keys[chatId] = raw
            raw
        } catch (_: Exception) { null }
    }

    fun decrypt(key: ByteArray, chatId: String, s: String): String? = try {
        val p = s.split(".")
        if (p.size != 3 || p[0] != "1") null
        else String(gcm(Cipher.DECRYPT_MODE, key, std(p[1]), chatId, std(p[2])), Charsets.UTF_8)
    } catch (_: Exception) { null }

    fun encrypt(key: ByteArray, chatId: String, text: String): String {
        val iv = ByteArray(12).also { SecureRandom().nextBytes(it) }
        return "1." + stdOut(iv) + "." + stdOut(gcm(Cipher.ENCRYPT_MODE, key, iv, chatId, text.toByteArray(Charsets.UTF_8)))
    }
}
