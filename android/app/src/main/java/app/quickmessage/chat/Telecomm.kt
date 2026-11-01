package app.quickmessage.chat

import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.telecom.Connection
import android.telecom.ConnectionRequest
import android.telecom.ConnectionService
import android.telecom.DisconnectCause
import android.telecom.PhoneAccount
import android.telecom.PhoneAccountHandle
import android.telecom.TelecomManager

/**
 * Registers QuickMessage calls with Android's Telecom framework as "self-managed" calls (the app keeps its own call screen).
 * That is what lets the system, Bluetooth headsets and Android Auto know a call is ringing / running, answer or hang up from the car,
 * and mute from the car. Everything here is best effort: if the system refuses (old Android, missing permission) the normal
 * notifications keep working exactly as before.
 */
object Telecomm {
    private const val ACCOUNT_ID = "quickmessage-calls"
    const val EXTRA_CHAT = "qm_chat"
    const val EXTRA_WHO = "qm_who"
    @Volatile var current: QmConnection? = null
    @Volatile private var placedAt = 0L          // the system creates the connection a moment after placeCall(): don't place it twice

    private fun handle(ctx: Context) = PhoneAccountHandle(ComponentName(ctx, QmConnectionService::class.java), ACCOUNT_ID)
    private fun tm(ctx: Context) = ctx.getSystemService(Context.TELECOM_SERVICE) as TelecomManager
    private fun uri(chat: String) = Uri.fromParts("quickmessage", chat.ifBlank { "call" }, null)

    private fun register(ctx: Context): Boolean {
        if (Build.VERSION.SDK_INT < 26) return false
        return try {
            val acc = PhoneAccount.builder(handle(ctx), "QuickMessage")
                .setCapabilities(PhoneAccount.CAPABILITY_SELF_MANAGED)
                .addSupportedUriScheme("quickmessage")
                .build()
            tm(ctx).registerPhoneAccount(acc)
            true
        } catch (_: Throwable) { false }
    }

    /** A call is ringing: tell the system. */
    fun incoming(ctx: Context, chat: String, who: String) {
        if (current != null || !register(ctx)) return
        try {
            val extras = Bundle().apply {
                putParcelable(TelecomManager.EXTRA_INCOMING_CALL_ADDRESS, uri(chat))
                putString(EXTRA_CHAT, chat); putString(EXTRA_WHO, who)
            }
            tm(ctx).addNewIncomingCall(handle(ctx), extras)
        } catch (_: Throwable) { /* no MANAGE_OWN_CALLS, or the system said no: the notification is enough */ }
    }

    /** A call is running (answered, or started in the app): make sure the system has it as active. */
    fun active(ctx: Context, title: String) {
        val c = current
        if (c != null) { c.goActive(); return }
        if (System.currentTimeMillis() - placedAt < 5000 || !register(ctx)) return
        placedAt = System.currentTimeMillis()
        try {
            val extras = Bundle().apply {
                putParcelable(TelecomManager.EXTRA_PHONE_ACCOUNT_HANDLE, handle(ctx))
                putString(EXTRA_CHAT, ""); putString(EXTRA_WHO, title.ifBlank { "QuickMessage call" })
            }
            tm(ctx).placeCall(uri("call"), extras)
        } catch (_: Throwable) { /* ignore */ }
    }

    /** The call ended (or was declined). [chat] null = whatever call is current. */
    fun end(chat: String?, rejected: Boolean) {
        val c = current ?: return
        if (chat != null && c.chat.isNotEmpty() && c.chat != chat) return
        c.finish(if (rejected) DisconnectCause.REJECTED else DisconnectCause.LOCAL)
    }
}

class QmConnection(private val ctx: Context, val chat: String, who: String, incoming: Boolean) : Connection() {
    init {
        setConnectionProperties(PROPERTY_SELF_MANAGED)
        setAudioModeIsVoip(true)
        setAddress(Uri.fromParts("quickmessage", chat.ifBlank { "call" }, null), TelecomManager.PRESENTATION_ALLOWED)
        setCallerDisplayName(who, TelecomManager.PRESENTATION_ALLOWED)
        if (incoming) {
            setRinging()
            // nobody answered or declined (e.g. it was handled on the web page): don't leave a ringing call in the car
            android.os.Handler(android.os.Looper.getMainLooper()).postDelayed({ if (!done && state == STATE_RINGING) finish(DisconnectCause.MISSED) }, 60_000)
        } else setDialing()
    }
    private var done = false

    fun goActive() { if (!done) setActive() }
    fun finish(cause: Int) {
        if (done) return
        done = true
        try { setDisconnected(DisconnectCause(cause)) } catch (_: Throwable) {}
        try { destroy() } catch (_: Throwable) {}
        if (Telecomm.current === this) Telecomm.current = null
    }

    // ---- the car / headset / system asks for something: do what the notification buttons do
    override fun onAnswer() { onAnswer(0) }
    override fun onAnswer(videoState: Int) {
        try { ctx.startActivity(Intent(ctx, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
            .putExtra(MainActivity.EXTRA_CHAT, chat).putExtra(MainActivity.EXTRA_RING, true).putExtra(MainActivity.EXTRA_ANSWER, true)) } catch (_: Throwable) {}
        goActive()
    }
    override fun onReject() {
        if (chat.isNotEmpty()) startSvc(Intent(ctx, NotifyService::class.java).setAction(NotifyService.ACT_DECLINE).putExtra("chat", chat))
        finish(DisconnectCause.REJECTED)
    }
    override fun onDisconnect() {
        startSvc(Intent(ctx, NotifyService::class.java).setAction(NotifyService.ACT_HANGUP))
        finish(DisconnectCause.LOCAL)
    }
    override fun onAbort() { finish(DisconnectCause.CANCELED) }
    override fun onCallAudioStateChanged(state: android.telecom.CallAudioState?) {
        if (state != null && state.isMuted != NotifyService.callMuted && NotifyService.inCall)
            startSvc(Intent(ctx, NotifyService::class.java).setAction(NotifyService.ACT_MIC))          // muted from the car: follow it
    }
    private fun startSvc(i: Intent) { try { if (Build.VERSION.SDK_INT >= 26) ctx.startForegroundService(i) else ctx.startService(i) } catch (_: Throwable) {} }
}

class QmConnectionService : ConnectionService() {
    override fun onCreateIncomingConnection(account: PhoneAccountHandle?, request: ConnectionRequest?): Connection {
        val ex = request?.extras
        val c = QmConnection(this, ex?.getString(Telecomm.EXTRA_CHAT).orEmpty(), ex?.getString(Telecomm.EXTRA_WHO).orEmpty().ifBlank { "QuickMessage" }, incoming = true)
        Telecomm.current = c
        return c
    }
    override fun onCreateOutgoingConnection(account: PhoneAccountHandle?, request: ConnectionRequest?): Connection {
        val ex = request?.extras
        val c = QmConnection(this, ex?.getString(Telecomm.EXTRA_CHAT).orEmpty(), ex?.getString(Telecomm.EXTRA_WHO).orEmpty().ifBlank { "QuickMessage call" }, incoming = false)
        Telecomm.current = c
        c.setActive()
        return c
    }
    override fun onCreateIncomingConnectionFailed(account: PhoneAccountHandle?, request: ConnectionRequest?) { Telecomm.current = null }
    override fun onCreateOutgoingConnectionFailed(account: PhoneAccountHandle?, request: ConnectionRequest?) { Telecomm.current = null }
}
