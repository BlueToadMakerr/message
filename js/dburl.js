// Which Realtime Database this device talks to. The built-in one is the default; the login screen's "Advanced" section can point
// this browser at another one (a database in the same Firebase project, e.g. a second instance). Stored per device.
export const DEFAULT_DB_URL = "https://quickmessage-ac953-default-rtdb.firebaseio.com";
const KEY = "qm-db-url";

/** Normalises and checks a database URL: https, a Firebase database host, no path. Returns the clean URL or "". */
export function cleanDbUrl(v) {
  try {
    const u = new URL(String(v || "").trim());
    if (u.protocol !== "https:" || u.username || u.password || u.search || (u.pathname !== "/" && u.pathname !== "")) return "";
    if (!/^[a-z0-9-]+(\.[a-z0-9-]+)*\.(firebaseio\.com|firebasedatabase\.app)$/i.test(u.hostname)) return "";
    return "https://" + u.hostname.toLowerCase();
  } catch (_) { return ""; }
}
/** The database in use ("" = the default one). */
export function customDbUrl() {
  try { const c = cleanDbUrl(localStorage.getItem(KEY)); return c && c !== DEFAULT_DB_URL ? c : ""; } catch (_) { return ""; }
}
export const activeDbUrl = () => customDbUrl() || DEFAULT_DB_URL;
export function setDbUrl(v) {
  const c = cleanDbUrl(v);
  try { if (!v || !c || c === DEFAULT_DB_URL) localStorage.removeItem(KEY); else localStorage.setItem(KEY, c); } catch (_) { /* ignore */ }
  return c;
}
