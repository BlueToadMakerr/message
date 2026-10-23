// Theme handling: "system" (default), "light" or "dark".
// Each page also sets data-theme from an inline script in <head> to avoid a flash.
const VALID = ["system", "light", "dark"];

export function getTheme() {
  try { return localStorage.getItem("theme") || "system"; } catch { return "system"; }
}

export function applyTheme(theme) {
  if (!VALID.includes(theme)) theme = "system";
  try { localStorage.setItem("theme", theme); } catch { /* storage blocked */ }
  document.documentElement.dataset.theme = theme;
  try { window.__qmApplyTheme && window.__qmApplyTheme(); } catch (_) { /* ignore */ }
  try { const bc = new BroadcastChannel("qm-theme"); bc.postMessage(theme); bc.close(); } catch (_) { /* old browser */ }
  return theme;
}

// ---- Midnight / accent colour / Material You. Stored per device; js/themeboot.js turns them into colours (in every page and frame).
export const ACCENT_PRESETS = ["#4f46e5", "#2563eb", "#0891b2", "#059669", "#65a30d", "#d97706", "#dc2626", "#db2777", "#9333ea", "#475569"];
const lsGet = k => { try { return localStorage.getItem(k); } catch { return null; } };
const lsSet = (k, v) => { try { v ? localStorage.setItem(k, v) : localStorage.removeItem(k); } catch { /* storage blocked */ } };

/** Material You needs Android 12+ (the app reports the wallpaper colours). */
export function materialAvailable() {
  try { return !!(window.QMApp && typeof window.QMApp.systemColors === "function" && window.QMApp.systemColors()); } catch { return false; }
}
export function getAppearance() {
  return { midnight: lsGet("qm-midnight") === "1", accent: lsGet("qm-accent") || "", material: lsGet("qm-material") === "1" && materialAvailable() };
}
/** Pass only what changed: { midnight?, accent?, material? }. Applies at once everywhere. */
export function setAppearance(p) {
  if ("midnight" in p) lsSet("qm-midnight", p.midnight ? "1" : "");
  if ("accent" in p) lsSet("qm-accent", /^#[0-9a-f]{6}$/i.test(p.accent || "") ? p.accent.toLowerCase() : "");
  if ("material" in p) lsSet("qm-material", p.material ? "1" : "");
  try { window.__qmThemeApply && window.__qmThemeApply(false); } catch (_) { /* ignore */ }
  try { const bc = new BroadcastChannel("qm-theme"); bc.postMessage("appearance"); bc.close(); } catch (_) { /* old browser */ }
}
