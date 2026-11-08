// Data Saver: while it is active, QuickMessage doesn't download things you didn't ask for (pictures / videos / audio that aren't saved on this
// device yet, link previews) and skips automatic update and status checks. Anything can still be opened by tapping it.
//
// Mode (Account → Data Saver), stored on this device:
//   off | on | saver (follow the system / browser Data Saver) | metered (follow "metered connection") | either (when one of those two is on)
// "saver" and "metered" only exist where the device can tell: the Android app reads Android's Data Saver and the metered flag;
// Chrome on Android exposes the Data Saver flag (connection.saveData) and the connection type (cellular counts as metered).
const KEY = "qm-datasaver";
const MODES = ["off", "on", "saver", "metered", "either"];
const app = () => (window.QMApp && window.QMApp.dataSaverState) ? window.QMApp : null;
const conn = () => navigator.connection || navigator.mozConnection || navigator.webkitConnection || null;

/** What the device reports: { saver, metered } each true / false, or null when it can't tell. */
export function systemState() {
  const a = app();
  if (a) { try { const s = JSON.parse(a.dataSaverState()); return { saver: s.saverAvailable ? !!s.saver : null, metered: s.meteredAvailable ? !!s.metered : null, native: true }; } catch (_) { /* fall through */ } }
  const c = conn();
  return { saver: c && "saveData" in c ? !!c.saveData : null, metered: c && typeof c.type === "string" ? c.type === "cellular" : null, native: false };
}
/** Which "follow" options this device can offer. */
export function available() { const s = systemState(); return { saver: s.saver !== null, metered: s.metered !== null }; }
export function modeChoices() {
  const av = available(), out = [["off", "Off"], ["on", "On (always)"]];
  if (av.saver) out.push(["saver", app() ? "Follow Android's Data Saver" : "Follow the browser's Data Saver"]);
  if (av.metered) out.push(["metered", app() ? "Follow metered connections (mobile data or a metered Wi-Fi)" : "Follow mobile data connections"]);
  if (av.saver && av.metered) out.push(["either", "Follow either of those"]);
  return out;
}
export function getMode() { let m = "off"; try { m = localStorage.getItem(KEY) || "off"; } catch (_) { /* ignore */ } return MODES.includes(m) ? m : "off"; }

function compute() {
  const m = getMode(); if (m === "off") return false; if (m === "on") return true;
  const s = systemState();
  const sv = s.saver === true, me = s.metered === true;
  return m === "saver" ? sv : m === "metered" ? me : (sv || me);
}
let cur = compute();
export const saverOn = () => cur;

function pushNative() { try { const a = app(); a && a.setDataSaverMode(getMode()); } catch (_) { /* ignore */ } }
function pushWorker() {
  if (window.top !== window) return;
  try { navigator.serviceWorker && navigator.serviceWorker.controller && navigator.serviceWorker.controller.postMessage({ op: "saver", on: cur }); } catch (_) { /* ignore */ }
}
function recompute(force) {
  const n = compute();
  if (n === cur && !force) return;
  cur = n; pushWorker();
  try { document.documentElement.classList.toggle("data-saver", cur); } catch (_) { /* ignore */ }
  window.dispatchEvent(new CustomEvent("qm-datasaver", { detail: { on: cur } }));
}
export function setMode(m) {
  if (!MODES.includes(m)) m = "off";
  try { localStorage.setItem(KEY, m); } catch (_) { /* ignore */ }
  pushNative(); recompute(true);
}
/** cb(on) whenever Data Saver switches on or off (also when the system setting changes). */
export function onSaverChange(cb) { const f = e => cb(e.detail.on); window.addEventListener("qm-datasaver", f); return () => window.removeEventListener("qm-datasaver", f); }

/** One line for the settings page. */
export function describe() {
  const m = getMode(), s = systemState(), on = cur;
  const why = m === "on" ? "switched on here" : m === "saver" ? (on ? "the Data Saver of your device is on" : "the Data Saver of your device is off")
    : m === "metered" ? (on ? "this connection is metered" : "this connection is not metered")
    : m === "either" ? (on ? (s.saver ? "Data Saver is on" : "this connection is metered") : "Data Saver is off and the connection is not metered") : "switched off";
  return `Data Saver is ${on ? "ACTIVE" : "not active"} — ${why}.`;
}

// ---- Keep it live
try { const c = conn(); c && c.addEventListener && c.addEventListener("change", () => recompute()); } catch (_) { /* ignore */ }
addEventListener("storage", e => { if (e.key === KEY) recompute(true); });
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") recompute(); });
if (app()) setInterval(() => recompute(), 5000);              // the app has no "changed" event for Data Saver / metered Wi-Fi: ask now and then (a bridge call, no network)
pushNative();
document.documentElement.classList.toggle("data-saver", cur);
if (window.top === window) {
  pushWorker();
  try { navigator.serviceWorker && navigator.serviceWorker.addEventListener("controllerchange", pushWorker); navigator.serviceWorker && navigator.serviceWorker.ready.then(pushWorker).catch(() => {}); } catch (_) { /* ignore */ }
}

/** A tap-to-load stand-in for a picture / video / sound that wasn't downloaded because of Data Saver. */
export function gateNode(kind, name, load) {
  const b = document.createElement("button"); b.type = "button"; b.className = "media-lazy saver-gate";
  b.textContent = (kind === "audio" ? "🎵 Tap to load audio" : kind === "video" ? "🎥 Tap to load video" : "📷 Tap to load photo") + (name ? " — " + name : "") + " (Data Saver)";
  b.onclick = () => { b.onclick = null; b.textContent = "Loading…"; load(); };
  return b;
}
