import { toast } from "./ui.js";
// Saving a picture / video / audio file to the device. Works for ordinary links, blob: / data: URLs (decrypted files) and in the Android app.
const EXT = { "image/jpeg": "jpg", "image/png": "png", "image/gif": "gif", "image/webp": "webp", "image/avif": "avif", "video/mp4": "mp4", "video/webm": "webm", "video/quicktime": "mov", "audio/mpeg": "mp3", "audio/mp4": "m4a", "audio/aac": "aac", "audio/wav": "wav", "audio/x-wav": "wav", "audio/ogg": "ogg", "audio/webm": "webm", "audio/flac": "flac", "audio/opus": "opus" };
function nameFor(url, hint, type) {
  let n = hint || "";
  if (!n) { try { n = decodeURIComponent(new URL(url, location.href).pathname.split("/").pop() || ""); } catch (_) { n = ""; } }
  n = n.replace(/[^\w.\- ]+/g, "_").slice(0, 100) || "download";
  if (!/\.\w{2,5}$/.test(n) && EXT[type]) n += "." + EXT[type];
  return n;
}
export async function downloadMedia(url, hint = "") {
  const app = window.QMApp;
  // Android app: the app downloads the link itself and shows progress + a "saved" notification (and a bar in the page)
  if (/^https?:/i.test(url) && app && app.downloadUrl) { try { app.downloadUrl(url, nameFor(url, hint, "")); return; } catch (_) { toast("Couldn't start the download.", "error"); } }
  try {
    if (app && app.saveFile) toast("Preparing the file…", "info", 1500);
    const r = await fetch(url);
    if (r.status === 404 || r.status === 410) { toast("That file doesn't exist anymore.", "error", 5000); return; }
    if (!r.ok) throw new Error("fetch");
    const blob = await r.blob(), name = nameFor(url, hint, blob.type);
    if (app && app.saveFile && blob.size < 40e6) {
      const b64 = await new Promise((ok, no) => { const f = new FileReader(); f.onload = () => ok(String(f.result).split(",")[1] || ""); f.onerror = no; f.readAsDataURL(blob); });
      app.saveFile(name, blob.type || "application/octet-stream", b64); return;
    }
    const u = URL.createObjectURL(blob), a = document.createElement("a");
    a.href = u; a.download = name; document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(u), 30000);
  } catch (_) {
    if (app && app.saveFile) { toast("Couldn't save the file.", "error"); return; }
    // the host doesn't allow reading it from here: let the browser open / save it itself
    const a = document.createElement("a"); a.href = url; a.download = nameFor(url, hint, ""); a.target = "_blank"; a.rel = "noopener noreferrer";
    document.body.append(a); a.click(); a.remove();
  }
}
