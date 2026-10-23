package app.quickmessage.chat

import android.graphics.*
import android.util.Base64
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.ConcurrentHashMap

/** Round profile / group pictures for notifications and bubbles (the photo URL, or a coloured letter when there is none). Call off the main thread. */
object Avatars {
    private val cache = ConcurrentHashMap<String, Bitmap>()

    fun load(url: String?, label: String, size: Int = 192, round: Boolean = true): Bitmap {
        val key = "${url ?: ""}|$label|$size|$round"
        cache[key]?.let { return it }
        val bmp = circle(if (url.isNullOrBlank()) null else fetch(url), label, size, round)
        if (cache.size > 80) cache.clear()
        cache[key] = bmp
        return bmp
    }

    private fun fetch(url: String): Bitmap? = try {
        when {
            url.startsWith("data:image/") && url.length < 3_000_000 -> Base64.decode(url.substringAfter(","), Base64.DEFAULT).let { BitmapFactory.decodeByteArray(it, 0, it.size) }
            url.startsWith("https://") -> (URL(url).openConnection() as HttpURLConnection).run {
                connectTimeout = 8000; readTimeout = 8000
                try { inputStream.use { BitmapFactory.decodeStream(it) } } finally { disconnect() }
            }
            else -> null
        }
    } catch (_: Exception) { null }

    private fun circle(src: Bitmap?, label: String, size: Int, round: Boolean): Bitmap {
        val out = Bitmap.createBitmap(size, size, Bitmap.Config.ARGB_8888)
        val c = Canvas(out)
        val p = Paint(Paint.ANTI_ALIAS_FLAG)
        if (src != null) {
            val s = minOf(src.width, src.height)
            val sq = Bitmap.createBitmap(src, (src.width - s) / 2, (src.height - s) / 2, s, s)
            if (round) {
                c.drawCircle(size / 2f, size / 2f, size / 2f, p)
                p.xfermode = PorterDuffXfermode(PorterDuff.Mode.SRC_IN)
            }
            c.drawBitmap(sq, null, Rect(0, 0, size, size), p)
        } else {
            p.color = Color.HSVToColor(floatArrayOf((Math.abs(label.hashCode()) % 360).toFloat(), 0.55f, 0.70f))
            if (round) c.drawCircle(size / 2f, size / 2f, size / 2f, p) else c.drawRect(0f, 0f, size.toFloat(), size.toFloat(), p)
            p.color = Color.WHITE; p.textSize = size * 0.48f; p.textAlign = Paint.Align.CENTER; p.isFakeBoldText = true
            c.drawText(label.trim().firstOrNull()?.uppercase() ?: "?", size / 2f, size / 2f - (p.descent() + p.ascent()) / 2, p)
        }
        return out
    }
}
