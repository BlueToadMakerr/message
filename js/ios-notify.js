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
// a running call needs the audio session for itself: the app pauses its silence meanwhile
window.__qmIosCall = on => send({ op: "call", on: !!on });
if (iosApp()) iosStatus();
