package app.quickmessage.chat

import android.app.Activity
import android.content.Intent
import android.media.projection.MediaProjectionManager
import android.os.Bundle

/**
 * Invisible, short-lived activity opened by the call notification's "Share screen" button. It only shows the system
 * "start recording / casting" prompt and hands the answer to MainActivity — the app itself is never brought to the front.
 */
class ScreenShareActivity : Activity() {
    override fun onCreate(b: Bundle?) {
        super.onCreate(b)
        try {
            val mpm = getSystemService(MEDIA_PROJECTION_SERVICE) as MediaProjectionManager
            @Suppress("DEPRECATION") startActivityForResult(mpm.createScreenCaptureIntent(), 7)
        } catch (_: Exception) { finish() }
    }

    @Deprecated("Deprecated in Java")
    override fun onActivityResult(req: Int, res: Int, data: Intent?) {
        super.onActivityResult(req, res, data)
        val m = MainActivity.instance
        if (m != null) {
            if (res == RESULT_OK && data != null) m.shareWithProjection(res, data) else m.runJs("window.__qmScreenState&&window.__qmScreenState('denied')")
        }
        finish()
        overridePendingTransition(0, 0)
    }
}
