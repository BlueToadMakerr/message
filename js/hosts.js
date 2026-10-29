// File hosts for attachments that are too big (or not the right kind) to be sent inside the message itself.
// The user's choices (which services, in what order, whether to be asked, how long files should last) live in this browser's storage.
// Every host here is anonymous (no account / key). Uploads to all except Litterbox go through this site's upload.php (the hosts don't allow
// browsers to read their answers directly); it only talks to the addresses listed in upload.php.
import { uploadToLitterbox, uploadViaRelay, uploadDirectHost, fmtBytes } from "./litter.js";

const H = 3600, D = 86400, MB = 1024 * 1024, GB = 1024 * MB;

/** `expiries`: the retention times (seconds) the host offers, or `range: [min, max]` when any time in between works. `direct`: the browser can upload without this site's relay. */
export const HOSTS = {
  litterbox: {
    id: "litterbox", name: "Litterbox (Catbox)", site: "https://litterbox.catbox.moe", maxBytes: 1000 * MB, expiries: [1 * H, 12 * H, 24 * H, 72 * H], direct: true,
    urlRe: /^https:\/\/litter\.catbox\.moe\/[\w.\-]+$/i,
    rules: ["Up to 1 GB per file, no account needed.", "Files last 1 hour, 12 hours, 24 hours or 72 hours, then are deleted.", "Anyone who has the link can open the file.", "No illegal content, malware or abuse; uploads can be scanned and removed."]
  },
  oshi: {
    id: "oshi", name: "oshi.at", site: "https://oshi.at", maxBytes: 1000 * MB, range: [1 * H, 90 * D], direct: false,
    urlRe: /^https:\/\/oshi\.at\/[\w.\-\/%~+]+$/i,
    rules: ["Up to 1 GB per file, no account needed.", "You can choose any time from 1 hour to 90 days.", "QuickMessage switches off \"delete after the first download\", so everyone in the chat can open the file.", "Needs this site's server as a go-between (the service doesn't allow browsers to upload directly), so the file must fit the server's upload limit. Anonymous and privacy-oriented, but uploads are scanned for malware and abuse; no illegal or copyrighted content."]
  },
  tmpfile: {
    id: "tmpfile", name: "tmpfile.link", site: "https://tmpfile.link", maxBytes: 100 * MB, expiries: [7 * D], direct: true,
    urlRe: /^https:\/\/tmpfile\.link\/[\w.\-\/%~+]+$/i,
    rules: ["Up to 100 MB per file, no account needed.", "Files are deleted automatically after 7 days (not adjustable).", "Works straight from the browser (no size limit from this site's server). Runs on Cloudflare, so very rapid repeated uploads can be rate-limited.", "Uploads are scanned; no malware, copyright violations or abuse."]
  },
  fileio: {
    id: "fileio", name: "file.io", site: "https://www.file.io", maxBytes: 2 * GB, expiries: [1 * D, 7 * D, 14 * D], direct: true,
    urlRe: /^https:\/\/(?:www\.)?file\.io\/[\w.\-\/%~+]+$/i,
    rules: ["Up to 2 GB per file on the free tier, no account needed. Works straight from the browser.", "Normally a file is deleted after its first download. QuickMessage switches that off, and files last until they expire (1, 7 or 14 days).", "The link may open a download page instead of the file itself, so pictures and videos might not preview inside the chat (not verified).", "Uploads are scanned; no malware, copyright violations or abuse."]
  }
};
export const HOST_IDS = Object.keys(HOSTS);
/** Is this a link to one of our file hosts? (what a message may point to) */
export const isHostedUrl = u => typeof u === "string" && u.length <= 300 && HOST_IDS.some(id => HOSTS[id].urlRe.test(u));

/** Longest time the host keeps a file (seconds). */
export const maxTtl = h => h.range ? h.range[1] : Math.max(...h.expiries);
/** The time (seconds) the host will really use for a wish of `want` seconds (0 = as long as possible): the closest one it offers; never longer than it can. */
export function ttlFor(h, want) {
  const max = maxTtl(h);
  if (!want || want >= max) return max;
  if (h.range) return Math.max(h.range[0], Math.min(max, want));
  return h.expiries.reduce((best, e) => Math.abs(e - want) < Math.abs(best - want) ? e : best, h.expiries[0]);
}
/** "1 GB", "100 MB" for a host's size limit. */
export const fmtLimit = n => n >= 1000 * MB ? (Math.round(n / GB * 10) / 10 || 1) + " GB" : Math.round(n / MB) + " MB";
export function fmtTtl(sec) {
  if (sec >= 2 * D && sec % D === 0) return sec / D + " days";
  if (sec >= D && sec % D === 0) return sec / D + " day";
  if (sec % H === 0) return sec / H + (sec / H === 1 ? " hour" : " hours");
  return Math.round(sec / 60) + " minutes";
}

// ------------------------------------------------------------------ settings (this device)
const KEY = "qm-hosts";
export const EXPIRY_CHOICES = [[0, "As long as each service allows"], [1 * H, "1 hour"], [12 * H, "12 hours"], [D, "1 day"], [3 * D, "3 days"], [7 * D, "7 days"], [14 * D, "14 days"], [30 * D, "30 days"], [90 * D, "90 days"]];
const DEFAULTS = () => ({ mode: "priority", order: HOST_IDS.slice(), enabled: { litterbox: true, oshi: true, tmpfile: true, fileio: false }, ttl: 0 });
export function getHostSettings() {
  let s = null;
  try { s = JSON.parse(localStorage.getItem(KEY) || "null"); } catch (_) { s = null; }
  const d = DEFAULTS();
  if (!s || typeof s !== "object") return d;
  const order = (Array.isArray(s.order) ? s.order : []).filter(id => HOSTS[id]);
  for (const id of HOST_IDS) if (!order.includes(id)) order.push(id);
  return { mode: s.mode === "ask" ? "ask" : "priority", order, enabled: { ...d.enabled, ...(s.enabled || {}) }, ttl: Math.max(0, Math.min(90 * D, +s.ttl || 0)) };
}
export function setHostSettings(s) { try { localStorage.setItem(KEY, JSON.stringify(s)); } catch (_) { /* ignore */ } }
export function resetHostSettings() { try { localStorage.removeItem(KEY); } catch (_) { /* ignore */ } }

/** Hosts that may take this file, in the user's order: switched on, big enough, and reachable (the relay's size limit applies to hosts without direct upload). */
export function eligibleHosts(size, relayMax, s = getHostSettings()) {
  return s.order.map(id => HOSTS[id]).filter(h => s.enabled[id2(h)] && size <= h.maxBytes && (h.direct || size <= relayMax));
}
const id2 = h => h.id;

/** Why nothing fits (for the error message). */
export function whyNone(size, relayMax, s = getHostSettings()) {
  const on = s.order.map(id => HOSTS[id]).filter(h => s.enabled[h.id]);
  if (!on.length) return "All file hosting services are switched off. Turn one on in Account → File hosting.";
  const biggest = Math.max(...on.map(h => h.direct ? h.maxBytes : Math.min(h.maxBytes, relayMax || 0)));
  return `No switched-on file host takes a file this big (${fmtBytes(size)}). The largest your selection allows is ${fmtBytes(biggest)}. Turn on more services in Account → File hosting.`;
}

/**
 * Uploads `file` to the first host that works. `choose(list)` (optional) lets the user pick the first host (mode "ask").
 * `relayMax`: how big a file this site's relay can take (only matters for hosts that can't be reached straight from the browser). Returns { url, name, size, mime, kind, expiresAt, host }.
 */
export async function uploadToHosts(file, { onProgress, signal, relayMax = 0, choose, onSwitch } = {}) {
  const s = getHostSettings();
  let list = eligibleHosts(file.size, relayMax, s);
  if (!list.length) throw new Error(whyNone(file.size, relayMax, s));
  if (s.mode === "ask" && choose) {
    const first = await choose(list.map(h => ({ host: h, ttl: ttlFor(h, s.ttl) })));
    if (!first) throw Object.assign(new Error("Cancelled"), { aborted: true });
    list = [first, ...list.filter(h => h !== first)];
  }
  let lastErr = null;
  for (let i = 0; i < list.length; i++) {
    const h = list[i], ttl = ttlFor(h, s.ttl);
    for (let attempt = 0; attempt < 2; attempt++) {               // one more try after a short pause (rate limits / busy servers)
      try {
        let r;
        if (h.id === "litterbox") r = await uploadToLitterbox(file, onProgress, signal, ttl);
        else if (h.direct) {
          // straight from the browser; only if that can't connect at all (blocked / CORS) the server relay is the way round, when the file fits through it
          try { r = await uploadDirectHost(h.id, file, ttl, onProgress, signal); }
          catch (e) { if (e.http || e.aborted || !(file.size <= relayMax)) throw e; r = await uploadViaRelay(h.id, file, ttl, onProgress, signal); }
        } else r = await uploadViaRelay(h.id, file, ttl, onProgress, signal);
        return { ...r, host: h.id };
      } catch (e) {
        if (e.aborted) throw e;
        lastErr = e;
        const again = !e.http || e.http === 429 || e.http >= 500;
        if (attempt === 0 && again) { await new Promise(res => setTimeout(res, 1500)); continue; }
        break;
      }
    }
    if (i + 1 < list.length) onSwitch && onSwitch(h, list[i + 1], lastErr);
  }
  throw lastErr || new Error("Upload failed");
}
