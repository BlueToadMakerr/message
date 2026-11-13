// Usage statistics (Google Analytics for Firebase, the project's own measurementId). Account based and on by default:
//   * the choice lives in accsettings/{uid}/settings/analytics (false = off), so turning it off on one device turns it off on all of them
//   * nothing is sent (and the Analytics SDK isn't even loaded) while signed out, while the choice is unknown, when it is off,
//     in private-server / own-database mode, or when the browser says "Do Not Track"
//   * what is sent: which screens are used, how often features are used, error kinds and file names, app / site versions, platform.
//     Never: messages, names, emails, friend codes, chat or account ids, file names or links. See docs/ANALYTICS.md.
// Every page calls track(); the real work happens once, in the top window (the shell), like the database connection.
import { SITE_VERSION } from "./version.js";
import { PRIVATE } from "./mode.js";
import { customDbUrl } from "./dburl.js";

const V = "https://www.gstatic.com/firebasejs/11.0.1/";
let topWin = window; try { topWin = window.top; topWin.document; } catch (_) { topWin = window; }
const isTop = topWin === window;
const inApp = !!window.QMApp;
const dnt = () => navigator.doNotTrack === "1" || window.doNotTrack === "1";
const blocked = () => PRIVATE || !!customDbUrl() || dnt();

const clean = v => typeof v === "string" ? v.replace(/https?:\/\/\S+/g, "<url>").replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, "<email>").replace(/\bQM-[A-Za-z0-9-]+/g, "<code>").slice(0, 100) : v;
export const bucket = n => n <= 0 ? "0" : n < 10 ? "1-9" : n < 100 ? "10-99" : n < 1000 ? "100-999" : "1000+";
export const sizeBucket = bytes => bytes < 1e5 ? "<100KB" : bytes < 1e6 ? "<1MB" : bytes < 1e7 ? "<10MB" : bytes < 1e8 ? "<100MB" : "100MB+";
export const secsBucket = s => s < 30 ? "<30s" : s < 120 ? "<2m" : s < 600 ? "<10m" : s < 3600 ? "<1h" : "1h+";

// ---------------------------------------------------------------- the real thing (top window only)
const core = {
  enabled: null, queue: [], later: [], an: null, mod: null, loading: null, uid: null, listeners: new Set(),
  track(name, params) {
    if (this.enabled === false || blocked()) return;
    const ev = [String(name).slice(0, 40), params || {}];
    if (this.enabled === true && this.an) return this.send(ev);
    if (this.queue.length < 60) this.queue.push(ev);               // until the choice is known (a second or so after sign-in)
  },
  send([name, params]) {
    const p = {};
    for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null) p[String(k).slice(0, 40)] = typeof v === "number" || typeof v === "boolean" ? v : clean(String(v));
    try { this.mod.logEvent(this.an, name, p); } catch (_) { /* never break the app */ }
  },
  async load() {
    if (this.an) return true;
    this.loading ||= (async () => {
      try {
        const [{ app }, mod] = await Promise.all([import("./firebase.js"), import(V + "firebase-analytics.js")]);
        if (!(await mod.isSupported())) return false;
        this.mod = mod;
        this.an = mod.initializeAnalytics(app, { config: { send_page_view: false, allow_ad_personalization_signals: false } });   // screens are logged by us; no ad features
        try { mod.setConsent({ analytics_storage: "granted", ad_storage: "denied", ad_user_data: "denied", ad_personalization: "denied" }); } catch (_) { /* older SDK */ }
        mod.setUserProperties(this.an, { site_version: SITE_VERSION, platform: platform(), standalone: matchMedia("(display-mode: standalone)").matches ? "yes" : "no" });
        return true;
      } catch (_) { return false; }
    })();
    return this.loading;
  },
  async apply(on) {
    const was = this.enabled;
    this.enabled = !!on && !blocked();
    nativeSet(this.enabled);
    if (this.enabled) {
      if (await this.load()) { try { this.mod.setAnalyticsCollectionEnabled(this.an, true); this.mod.setConsent({ analytics_storage: "granted" }); } catch (_) { /* ignore */ } for (const e of this.queue.splice(0)) this.send(e); for (const e of this.later.splice(0)) this.send(e); }
      else { this.enabled = false; this.queue.length = 0; }
    } else {
      this.queue.length = 0; if (this.uid) this.later.length = 0;
      if (this.an) { try { this.mod.setAnalyticsCollectionEnabled(this.an, false); this.mod.setConsent({ analytics_storage: "denied" }); } catch (_) { /* ignore */ } }
    }
    if (was !== this.enabled) for (const f of this.listeners) { try { f(this.enabled); } catch (_) { /* ignore */ } }
  }
};
const platform = () => inApp ? (/iPhone|iPad/.test(navigator.userAgent) ? "ios_app" : "android_app") : /Android|iPhone|iPad|Mobile/i.test(navigator.userAgent) ? "mobile_web" : "desktop_web";
function nativeSet(v) { try { if (window.QMApp && window.QMApp.setAnalytics) window.QMApp.setAnalytics(!!v); } catch (_) { /* ignore */ } }

if (isTop) {
  window.__qmAn = core;
  if (blocked()) { nativeSet(false); }
  else (async () => {
    const { auth, db } = await import("./firebase.js");
    const { onAuthStateChanged, onValue, ref } = await import("./sdk.js");
    let off = null;
    onAuthStateChanged(auth, user => {
      if (off) { off(); off = null; }
      if (!user) { core.uid = null; core.apply(false); return; }
      core.uid = user.uid;
      // live: another device switching it off reaches this one within moments
      off = onValue(ref(db, `accsettings/${user.uid}/settings/analytics`), s => core.apply(s.val() !== false), () => core.apply(true));
    });
  })().catch(() => {});
}

// ---------------------------------------------------------------- what every page uses
const real = () => { try { const t = topWin.__qmAn; if (t) return t; } catch (_) { /* cross-origin */ } return isTop ? core : null; };
/** Log an event. Safe to call anywhere, any time; does nothing when analytics is off. Keep names snake_case and parameters small (no personal data). */
export function track(name, params) { try { const t = real(); if (t) t.track(name, params); } catch (_) { /* ignore */ } }
/** true / false once known, null before that. */
export const analyticsOn = () => { const t = real(); return t ? t.enabled : null; };
export const onAnalyticsChange = fn => { const t = real(); if (t) t.listeners.add(fn); return () => t && t.listeners.delete(fn); };
/** Switch it for the whole account (all devices). */
export async function setAnalyticsEnabled(on) {
  const { auth, db } = await import("./firebase.js"); const { ref, update } = await import("./sdk.js");
  if (!auth.currentUser) throw new Error("Not signed in");
  await update(ref(db, `accsettings/${auth.currentUser.uid}/settings`), { analytics: !!on });
}
/** For things that happen while signing in (sign-up, login): kept until the account's choice is known, then sent only if it is on. */
export function trackAfterSignIn(name, params) { try { const t = real(); if (t && t.uid) return t.track(name, params); if (t && !blocked() && t.later.length < 10) { t.later.push([String(name).slice(0, 40), params || {}]); setTimeout(() => { const i = t.later.findIndex(e => e[0] === name); if (i >= 0 && !t.uid) t.later.splice(i, 1); }, 120000); } } catch (_) { /* ignore */ } }
export const analyticsAvailable = () => !blocked();

// ---------------------------------------------------------------- automatic: screens, errors, install
export const pageName = () => (location.pathname.split("/").pop() || "index.html").replace(/\.html$/, "") || "index";
if (!isTop) track("screen_view", { screen_name: pageName(), firebase_screen: pageName() });
const seen = new Set(); let errs = 0;
const base = f => { try { return new URL(f, location.href).pathname.split("/").pop(); } catch (_) { return String(f || "").slice(-40); } };
addEventListener("error", e => {
  if (!e.filename && !e.message) return;                                   // resource errors are reported by the shell's own checks
  if (errs >= 5) return; const key = base(e.filename) + ":" + e.lineno + ":" + e.message; if (seen.has(key)) return; seen.add(key); errs++;
  track("app_error", { kind: "js", file: base(e.filename), line: e.lineno || 0, msg: clean(e.message || ""), page: pageName() });
});
addEventListener("unhandledrejection", e => {
  if (errs >= 5) return; const m = clean(String((e.reason && (e.reason.message || e.reason.code)) || e.reason || "")); const key = "p:" + m; if (seen.has(key)) return; seen.add(key); errs++;
  track("app_error", { kind: "promise", msg: m, page: pageName() });
});
if (isTop) addEventListener("appinstalled", () => track("pwa_installed"));
