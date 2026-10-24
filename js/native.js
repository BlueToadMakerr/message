// Google sign-in can't run inside an app's web view, so the apps do it in the system browser and hand the ID token back
// (Android: QMApp.googleSignIn; iPhone: the "qmGoogle" message handler). Returns false in a normal browser.
export function hasNativeGoogle() {
  return !!((window.QMApp && window.QMApp.googleSignIn) || (window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.qmGoogle));
}
export function nativeGoogleSignIn() {
  if (window.QMApp && window.QMApp.googleSignIn) { window.QMApp.googleSignIn(); return true; }
  const h = window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.qmGoogle;
  if (h) { h.postMessage("signin"); return true; }
  return false;
}

/**
 * Screen capture done by the app itself (a web view can't capture the screen): Android (QMApp.startScreen…) or the iPhone app
 * (the "qmScreen" message handler + a ReplayKit broadcast extension). Both stream JPEG frames into window.__qmScreenFrame and report
 * window.__qmScreenState("started" | "denied" | "stopped"). null in a normal browser.
 */
export function nativeScreen() {
  const q = window.QMApp;
  if (q && q.startScreen) return {
    platform: "android",
    setQuality: (edge, jpeg, fps) => { try { q.setScreenQuality && q.setScreenQuality(edge, jpeg, fps); } catch (_) { /* older app */ } },
    start: () => q.startScreen(), stop: () => { try { q.stopScreen(); } catch (_) { /* ignore */ } }
  };
  const h = window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.qmScreen;
  if (h) return {
    platform: "ios",
    setQuality: (edge, jpeg, fps) => h.postMessage({ op: "quality", edge, jpeg, fps }),
    start: () => h.postMessage({ op: "start" }), stop: () => { try { h.postMessage({ op: "stop" }); } catch (_) { /* ignore */ } }
  };
  return null;
}
