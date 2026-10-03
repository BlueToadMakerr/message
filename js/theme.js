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
  return theme;
}
