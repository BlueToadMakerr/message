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
