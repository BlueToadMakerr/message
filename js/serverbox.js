// Login screen: "Private server" box. Points this browser (or the Android / iPhone app) at a server made with server/qm_server.py instead of Firebase.
import { PRIVATE, privateBase, setPrivateServer } from "./mode.js";

const $ = id => document.getElementById(id);
const nativeSet = url => {
  try { if (window.QMApp && window.QMApp.setServer) { window.QMApp.setServer(url); return true; } } catch (_) { /* ignore */ }
  try { const h = window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.qmServer; if (h) { h.postMessage({ url }); return true; } } catch (_) { /* ignore */ }
  return false;
};
const inApp = () => !!((window.QMApp && window.QMApp.setServer) || (window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.qmServer));

/** "192.168.1.10:8080" -> "http://192.168.1.10:8080"; anything that is not a plain server address -> "". */
export function cleanServerUrl(v) {
  let t = String(v || "").trim();
  if (!t) return "";
  if (!/^https?:\/\//i.test(t)) t = "http://" + t;
  try { const u = new URL(t); if (u.username || u.password) return ""; return u.origin + u.pathname.replace(/\/+$/, "").replace(/\/index\.html$/, ""); } catch (_) { return ""; }
}

async function ping(url) {
  const c = new AbortController(), t = setTimeout(() => c.abort(), 6000);
  try { const r = await fetch(url + "/api/ping", { signal: c.signal, cache: "no-store" }); const j = await r.json(); return j && j.server === "quickmessage-private" ? j : null; }
  catch (_) { return null; } finally { clearTimeout(t); }
}

function init() {
  const box = $("srvOpt"); if (!box) return;
  const msg = $("srvMsg"), inp = $("srvUrl"), say = (t, bad) => { msg.textContent = t; msg.style.color = bad ? "var(--danger)" : ""; };
  const current = PRIVATE ? (privateBase() || location.origin) : "";
  if (PRIVATE) { box.open = true; $("srvSum").textContent = "Private server (in use)"; inp.value = current; $("srvHelp").textContent = "You are using this private server. “Use Firebase” goes back to the normal QuickMessage."; }
  // served by the server itself in a browser: nothing to switch to from here (the hosted site is a different address)
  if (PRIVATE && privateBase() === "" && !inApp()) { $("srvReset").classList.add("hidden"); $("srvUse").classList.add("hidden"); inp.readOnly = true; }
  $("srvUse").onclick = async () => {
    const url = cleanServerUrl(inp.value);
    if (!url) return say("Enter the server's address, e.g. http://192.168.1.10:8080", true);
    say("Checking the server…");
    // From the app the page is https/Firebase and the server is plain http, so the check can't run here: the app opens the server directly.
    if (!inApp()) {
      const j = await ping(url);
      if (!j) return say("Couldn't reach a QuickMessage private server there. Is it running, and is the address right? (An https:// site can't talk to an http:// server: open the server's own address instead.)", true);
    }
    if (nativeSet(url)) return say("Opening the server…");
    setPrivateServer(url); location.reload();
  };
  $("srvReset").onclick = () => { if (nativeSet("")) return say("Going back to Firebase…"); setPrivateServer(""); location.reload(); };
}
if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init); else init();
