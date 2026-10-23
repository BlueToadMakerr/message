package app.quickmessage.chat

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

/** Restarts the notification listener after the phone reboots (only if someone is signed in). */
class BootReceiver : BroadcastReceiver() {
    override fun onReceive(c: Context, i: Intent) { NotifyService.start(c) }
}
