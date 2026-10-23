// Litterbox uploads (https://litterbox.catbox.moe): anonymous, temporary. We always ask for the longest retention (72 h).
// Relay (upload.php) when the file fits, for a real progress bar; otherwise a direct *simple* POST (no CORS preflight). Each falls back to the other.
import { auth } from "./firebase.js";

const API = "https://litterbox.catbox.moe/resources/internals/api.php";
export const RETENTION = "72h";
export const RETENTION_MS = 72 * 3600 * 1000;
export const MAX_BYTES = 1000 * 1024 * 1024;           // Litterbox's limit is 1 GB
const HOST_RE = /^https:\/\/litter\.catbox\.moe\/[\w.\-]+$/i;

const rand16 = () => {
  const a = crypto.getRandomValues(new Uint8Array(16)), c = "abcdefghijklmnopqrstuvwxyz0123456789";
  return Array.from(a, x => c[x % 36]).join("");
};
const extOf = f => {
  const m = /\.([A-Za-z0-9]{1,8})$/.exec(f.name || "");
  if (m) return "." + m[1].toLowerCase();
  const t = (f.type || "").split("/")[1];
  return t ? "." + t.replace(/[^a-z0-9].*$/i, "") : "";
};

/** Is this URL one we'd render? (only Litterbox links) */
export const isLitterUrl = u => typeof u === "string" && HOST_RE.test(u);

export const kindOf = mime => (mime || "").startsWith("image/") ? "image" : (mime || "").startsWith("video/") ? "video" : (mime || "").startsWith("audio/") ? "audio" : "file";

// Same-origin proxy upload: XHR so we can report real progress (no CORS involved, so upload listeners are safe here).
function postProxy(form, onProgress, signal) {
  return new Promise((resolve, reject) => {
    const x = new XMLHttpRequest();
    x.open("POST", "upload.php");
    x.upload.onprogress = e => { if (e.lengthComputable && onProgress) onProgress(e.loaded / e.total); };
    x.onload = () => (x.status >= 200 && x.status < 300) ? resolve(x.responseText.trim()) : reject(Object.assign(new Error(x.responseText.trim() || "Upload failed (" + x.status + ")"), { http: x.status }));
    x.onerror = () => reject(new Error("Couldn't reach the upload helper (network error)."));
    if (signal) signal.addEventListener("abort", () => { x.abort(); reject(Object.assign(new Error("Cancelled"), { aborted: true })); }, { once: true });
    x.send(form);
  });
}

// Direct upload: a *simple* cross-origin POST (no custom headers, no upload listeners) so the browser sends no
// preflight. Litterbox answers OPTIONS with 405, so anything that triggers a preflight (like xhr.upload.onprogress) breaks.
// The trade-off is that the browser can't report progress for this path (onProgress(null) = indeterminate).
async function postDirect(form, signal) {
  const r = await fetch(API, { method: "POST", body: form, signal, credentials: "omit", referrerPolicy: "no-referrer" });
  const t = (await r.text()).trim();
  if (!r.ok) throw Object.assign(new Error(t || "Litterbox error (" + r.status + ")"), { http: r.status });
  return t;
}

let limitP = null;
/** Largest file the upload.php relay can take (bytes), or 0 if the relay is unavailable. */
const relayLimit = () => limitP ||= fetch("upload.php?limits", { cache: "no-store" })
  .then(r => r.ok ? r.json() : { max: 0 }).then(j => +j.max || 0).catch(() => 0);

/**
 * Uploads via the same-origin relay when the file fits (real progress), otherwise directly (progress unknown).
 * Each route falls back to the other when it can.
 * @param {File} file
 * @param {(fraction:number|null)=>void} [onProgress] fraction 0..1, or null when progress isn't measurable
 * @param {AbortSignal} [signal]
 * @returns {Promise<{url:string, name:string, size:number, mime:string, kind:string, expiresAt:number}>}
 */
export async function uploadToLitterbox(file, onProgress, signal) {
  if (file.size > MAX_BYTES) throw new Error("That file is over Litterbox's 1 GB limit.");
  const stored = rand16() + extOf(file);                 // 16-character name, original name kept only in the chat message
  const build = () => {
    const f = new FormData();
    f.append("reqtype", "fileupload");
    f.append("time", RETENTION);
    f.append("fileNameLength", "16");
    f.append("fileToUpload", file, stored);
    return f;
  };
  const viaRelay = async () => {
    const f = build();
    f.append("idToken", await auth.currentUser.getIdToken());
    onProgress && onProgress(0);
    return postProxy(f, onProgress, signal);
  };
  const viaDirect = async () => {
    onProgress && onProgress(null);
    try { return await postDirect(build(), signal); }
    catch (e) { if (e.name === "AbortError") throw Object.assign(new Error("Cancelled"), { aborted: true }); throw e; }
  };
  const max = await relayLimit();
  const fits = max > 0 && file.size <= max;
  let text;
  if (fits) {
    try { text = await viaRelay(); }
    catch (e) { if (e.aborted) throw e; text = await viaDirect().catch(() => { throw e; }); }
  } else {
    try { text = await viaDirect(); }
    catch (e) {
      if (e.aborted || e.http) throw e;
      throw new Error("Couldn't reach Litterbox from this browser" + (max ? ", and this file is too big for the upload helper (" + fmtBytes(max) + " max)." : "."));
    }
  }
  if (!HOST_RE.test(text)) throw new Error("Litterbox didn't accept that file: " + text.slice(0, 120));
  return { url: text, name: file.name || stored, size: file.size, mime: file.type || "application/octet-stream", kind: kindOf(file.type), expiresAt: Date.now() + RETENTION_MS };
}

export function fmtBytes(n) {
  if (n < 1024) return n + " B";
  if (n < 1048576) return (n / 1024).toFixed(0) + " KB";
  if (n < 1073741824) return (n / 1048576).toFixed(1) + " MB";
  return (n / 1073741824).toFixed(2) + " GB";
}
