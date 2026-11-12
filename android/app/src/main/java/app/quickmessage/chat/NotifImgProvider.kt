package app.quickmessage.chat

import android.content.ContentProvider
import android.content.ContentValues
import android.database.Cursor
import android.net.Uri
import android.os.ParcelFileDescriptor
import java.io.File

/** Serves the small photo files the notifications show inline (cache/qmimg). Not exported: only links we grant (to systemui) can read. */
class NotifImgProvider : ContentProvider() {
    override fun onCreate() = true
    override fun getType(uri: Uri) = "image/jpeg"
    override fun openFile(uri: Uri, mode: String): ParcelFileDescriptor {
        val name = File(uri.lastPathSegment ?: throw java.io.FileNotFoundException()).name
        val f = File(File(context!!.cacheDir, "qmimg"), name)
        if (!f.exists()) throw java.io.FileNotFoundException(name)
        return ParcelFileDescriptor.open(f, ParcelFileDescriptor.MODE_READ_ONLY)
    }
    override fun query(uri: Uri, p: Array<String>?, s: String?, a: Array<String>?, o: String?): Cursor? = null
    override fun insert(uri: Uri, v: ContentValues?): Uri? = null
    override fun update(uri: Uri, v: ContentValues?, s: String?, a: Array<String>?) = 0
    override fun delete(uri: Uri, s: String?, a: Array<String>?) = 0
}
