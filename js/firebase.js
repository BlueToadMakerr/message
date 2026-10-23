// Shared Firebase initialisation. The web config below is public by design
// (security comes from your Realtime Database rules, not from hiding this).
import { initializeApp } from "./sdk.js";
import { getAuth } from "./sdk.js";
import { getDatabase, goOnline, goOffline } from "./sdk.js";
import { customDbUrl } from "./dburl.js";

export const firebaseConfig = {
  apiKey: "AIzaSyBNynmpC9-jTZd56WnpsjnbJa7THeyTMWY",
  authDomain: "quickmessage-ac953.firebaseapp.com",
  projectId: "quickmessage-ac953",
  storageBucket: "quickmessage-ac953.firebasestorage.app",
  messagingSenderId: "841093269538",
  appId: "1:841093269538:web:9679b67cfd0939a02ea27b",
  measurementId: "G-B1Z5T0H4PR"
};

export const VAPID_KEY =
  "BI-mhcctjGRymM3U9kCjsrEma7n6572wBZrZDcFm-PlMNKis7REyQabUTBbpFeKg61WtBb60L1y3VwWzsqTVF8s";

export const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db = customDbUrl() ? getDatabase(app, customDbUrl()) : getDatabase(app);

// ---- fewer database connections (the free plan allows 100 at once; every open page / frame / device holds one).
// A page that nobody is looking at lets go of its connection and takes it back when it is needed again. A call keeps everything online.
// Only the top window (the shell) manages it, because every frame shares this one connection (see sdk.js).
if (window.top === window) {
  const inCall = () => { try { const c = window.QM && window.QM.state && window.QM.state.call; return !!(c && (c.joined || c.chatId)); } catch (_) { return false; } };
  const wanted = () => {
    if (inCall()) return true;
    if (window.QMApp && window.QMApp.isForeground) { try { return !!window.QMApp.isForeground(); } catch (_) { return true; } }
    return !document.hidden || hiddenFor() < 120000;       // browser tab: stay connected for 2 minutes after it's hidden
  };
  let hiddenSince = 0, online = true;
  const hiddenFor = () => (hiddenSince ? Date.now() - hiddenSince : 0);
  document.addEventListener("visibilitychange", () => { hiddenSince = document.hidden ? Date.now() : 0; check(); });
  function check() {
    const w = wanted();
    if (w === online) return;
    online = w;
    try { w ? goOnline(db) : goOffline(db); } catch (_) { /* ignore */ }
  }
  setInterval(check, 5000);
}
