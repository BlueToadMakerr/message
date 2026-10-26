// iPhone / iPad app only (the Swift app answers on the "qmNotify" message handler). Web push doesn't exist inside an app's web view,
// so the app shows LOCAL notifications for messages this page receives while the app is in the background; to keep the page
// running there it plays silence (iOS background-audio mode). Notifications stop when iOS (or you) quits the app.
const handler = () => window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.qmNotify;
export const iosApp = () => !!handler();
let state = { enabled: false, allowed: false };
const listeners = new Set();
window.__qmIosNotify = s => { state = { ...state, ...s }; listeners.forEach(f => { try { f(state); } catch (_) { /* ignore */ } }); };
export const iosState = () => state;
export const onIosState = f => listeners.add(f);
const send = m => { try { handler().postMessage(m); } catch (_) { /* not in the app */ } };
export const iosSetEnabled = on => send({ op: "enable", on: !!on });
export const iosStatus = () => send({ op: "status" });
/** { id, chatId, title, body } */
export const iosShow = n => { if (state.enabled && state.allowed) send({ op: "show", ...n }); };
// A running call (and a screen share inside it) must keep running when you leave the app: the app plays silence natively, and the page itself
// plays an inaudible sound too, so iOS doesn't suspend the web page (without it the shared screen froze as soon as you left QuickMessage).
let keep = null;
function keepRunning(on) {
  try {
    if (!on) { if (keep) { keep.pause(); keep.remove(); keep = null; } return; }
    if (keep) return;
    const rate = 8000, n = rate, buf = new ArrayBuffer(44 + n * 2), v = new DataView(buf), s = (o, t) => { for (let i = 0; i < t.length; i++) v.setUint8(o + i, t.charCodeAt(i)); };
    s(0, "RIFF"); v.setUint32(4, 36 + n * 2, true); s(8, "WAVEfmt "); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true); v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true); s(36, "data"); v.setUint32(40, n * 2, true);
    for (let i = 0; i < n; i++) v.setInt16(44 + i * 2, i % 2 ? 1 : -1, true);       // +-1 of 32768: inaudible, but not digital silence
    let bin = ""; const u = new Uint8Array(buf); for (let i = 0; i < u.length; i += 0x8000) bin += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000));
    const a = new Audio("data:audio/wav;base64," + btoa(bin)); a.loop = true; a.volume = 0.02; a.setAttribute("playsinline", ""); a.style.display = "none";
    document.body.append(a); a.play().catch(() => {}); keep = a;
  } catch (_) { /* ignore */ }
}
window.__qmIosCall = on => { send({ op: "call", on: !!on }); if (iosApp()) keepRunning(!!on); };
if (iosApp()) iosStatus();
