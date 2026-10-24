// The app's own drop-downs and colour picker. Android's built-in ones are white, tiny and ignore the theme, so on touch devices and in the
// Android/iPhone app every <select> is replaced by a themed menu (the real <select> stays, hidden, and keeps working: value, change events, options).
// Desktop browsers keep their native menus unless localStorage "qm-custom-ui" is "1".
import { confirmDialog } from "./ui.js";

export function useCustomUI() {
  try { if (localStorage.getItem("qm-custom-ui") === "1") return true; if (localStorage.getItem("qm-custom-ui") === "0") return false; } catch (_) { /* ignore */ }
  return !!window.QMApp || (window.webkit && window.webkit.messageHandlers && !!window.webkit.messageHandlers.qmGoogle) || matchMedia("(pointer: coarse)").matches;
}

// ---------------------------------------------------------------- drop-down
let openMenu = null;
const closeMenu = () => { if (openMenu) { openMenu.close(); openMenu = null; } };

function showMenu(sel, btn) {
  closeMenu();
  const host = btn.closest("dialog[open]") || document.body;                // inside a modal dialog the menu has to live in that dialog, or it can't be tapped
  const menu = document.createElement("div"); menu.className = "qm-menu"; menu.setAttribute("role", "listbox");
  const items = [];
  const add = (o, parent) => {
    const it = document.createElement("button"); it.type = "button"; it.className = "qm-menu-item"; it.setAttribute("role", "option");
    it.disabled = o.disabled || (parent && parent.disabled);
    const tick = document.createElement("span"); tick.className = "qm-tick"; tick.textContent = o.selected ? "✓" : "";
    const tx = document.createElement("span"); tx.className = "qm-menu-text"; tx.textContent = o.textContent;
    it.append(tick, tx); if (o.selected) it.classList.add("on");
    it.onclick = () => { closeMenu(); if (sel.value !== o.value) { sel.value = o.value; sel.dispatchEvent(new Event("input", { bubbles: true })); sel.dispatchEvent(new Event("change", { bubbles: true })); } btn.focus(); };
    menu.append(it); items.push(it);
  };
  for (const c of sel.children) {
    if (c.tagName === "OPTGROUP") { const g = document.createElement("div"); g.className = "qm-menu-group"; g.textContent = c.label; menu.append(g); for (const o of c.children) add(o, c); }
    else if (c.tagName === "OPTION") add(c, null);
  }
  host.append(menu);
  const place = () => {
    const r = btn.getBoundingClientRect(), vh = innerHeight, vw = innerWidth, gap = 6;
    menu.style.minWidth = Math.min(r.width, vw - 16) + "px";
    const h = Math.min(menu.scrollHeight, vh * 0.6), below = vh - r.bottom - 12, above = r.top - 12;
    const up = below < Math.min(h, 220) && above > below;
    menu.style.maxHeight = Math.max(120, Math.min(vh * 0.6, up ? above : below)) + "px";
    menu.style.left = Math.max(8, Math.min(r.left, vw - menu.offsetWidth - 8)) + "px";
    menu.style.top = up ? Math.max(8, r.top - gap - Math.min(menu.scrollHeight, parseFloat(menu.style.maxHeight))) + "px" : r.bottom + gap + "px";
  };
  place();
  const cur = menu.querySelector(".on"); if (cur) menu.scrollTop = Math.max(0, cur.offsetTop - menu.clientHeight / 2 + cur.offsetHeight / 2);
  const off = e => { if (!menu.contains(e.target)) closeMenu(); };
  const key = e => {
    const list = items.filter(i => !i.disabled), at = list.indexOf(document.activeElement);
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); closeMenu(); btn.focus(); }
    else if (e.key === "ArrowDown") { e.preventDefault(); (list[at + 1] || list[0]).focus(); }
    else if (e.key === "ArrowUp") { e.preventDefault(); (list[at - 1] || list[list.length - 1]).focus(); }
  };
  setTimeout(() => { document.addEventListener("pointerdown", off, true); document.addEventListener("scroll", off2, true); }, 150);
  document.addEventListener("keydown", key, true); addEventListener("resize", closeMenu);
  function off2(e) { if (!menu.contains(e.target)) closeMenu(); }
  (cur || items.find(i => !i.disabled))?.focus({ preventScroll: true });
  openMenu = { close() { document.removeEventListener("pointerdown", off, true); document.removeEventListener("keydown", key, true); removeEventListener("resize", closeMenu); document.removeEventListener("scroll", off2, true); menu.remove(); } };
}

function enhance(sel) {
  if (sel.dataset.qmEnhanced || sel.multiple || sel.size > 1 || sel.hasAttribute("data-native")) return;
  sel.dataset.qmEnhanced = "1";
  const btn = document.createElement("button"); btn.type = "button"; btn.className = (sel.className || "field") + " qm-select";
  const label = document.createElement("span"); label.className = "qm-select-text"; const caret = document.createElement("span"); caret.className = "qm-caret"; caret.setAttribute("aria-hidden", "true");
  btn.append(label, caret); btn.setAttribute("aria-haspopup", "listbox");
  if (sel.id) btn.setAttribute("aria-labelledby", ""), btn.removeAttribute("aria-labelledby");
  sel.after(btn); sel.classList.add("qm-native-hidden"); sel.tabIndex = -1;
  const refresh = () => { const o = sel.selectedOptions[0]; label.textContent = o ? o.textContent : ""; btn.disabled = sel.disabled; btn.hidden = sel.hidden || sel.classList.contains("hidden"); };
  for (const prop of ["value", "selectedIndex"]) {                                       // code that sets .value / .selectedIndex must update the visible label
    const d = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, prop);
    Object.defineProperty(sel, prop, { configurable: true, get() { return d.get.call(sel); }, set(v) { d.set.call(sel, v); refresh(); } });
  }
  new MutationObserver(refresh).observe(sel, { childList: true, subtree: true, attributes: true, characterData: true });
  sel.addEventListener("change", refresh);
  btn.onclick = () => { if (openMenu) closeMenu(); else showMenu(sel, btn); };
  btn.addEventListener("keydown", e => { if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); showMenu(sel, btn); } });
  for (const l of sel.labels || []) l.addEventListener("click", e => { e.preventDefault(); btn.click(); });
  refresh();
}
const scan = root => (root.querySelectorAll ? root.querySelectorAll("select") : []).forEach(enhance);

// ---------------------------------------------------------------- colour picker
const PRESET_COLORS = ["#4f46e5", "#2563eb", "#0891b2", "#059669", "#65a30d", "#d97706", "#dc2626", "#db2777", "#9333ea", "#475569", "#000000", "#ffffff"];
const hex2 = n => Math.round(n).toString(16).padStart(2, "0");
function hslToHex(h, s, l) { s /= 100; l /= 100; const a = s * Math.min(l, 1 - l), f = n => { const k = (n + h / 30) % 12; return l - a * Math.max(-1, Math.min(k - 3, Math.min(9 - k, 1))); }; return "#" + [f(0), f(8), f(4)].map(v => hex2(v * 255)).join(""); }
function hexToHsl(x) {
  const n = parseInt(x.slice(1), 16), r = (n >> 16) / 255, g = ((n >> 8) & 255) / 255, b = (n & 255) / 255, mx = Math.max(r, g, b), mn = Math.min(r, g, b), l = (mx + mn) / 2, d = mx - mn;
  let h = 0, s = 0; if (d) { s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn); h = mx === r ? (g - b) / d + (g < b ? 6 : 0) : mx === g ? (b - r) / d + 2 : (r - g) / d + 4; h *= 60; }
  return [h, s * 100, l * 100];
}

/** A themed colour picker dialog. Resolves to "#rrggbb", or null when cancelled. */
export async function pickColor({ title = "Choose a colour", value = "#4f46e5", presets = PRESET_COLORS } = {}) {
  let [h, s, l] = hexToHsl(/^#[0-9a-f]{6}$/i.test(value) ? value : "#4f46e5");
  const box = document.createElement("div"); box.className = "stack cp";
  box.innerHTML = `
    <div class="cp-top"><div class="cp-preview" data-k="prev"></div><input class="field cp-hex" data-k="hex" maxlength="7" spellcheck="false" autocapitalize="off" aria-label="Hex colour"></div>
    <label class="lbl">Colour</label><input type="range" class="cp-range cp-h" min="0" max="360" data-k="h">
    <label class="lbl">Strength</label><input type="range" class="cp-range" min="0" max="100" data-k="s">
    <label class="lbl">Light ↔ dark</label><input type="range" class="cp-range" min="0" max="100" data-k="l">
    <div class="cp-swatches" data-k="sw"></div>`;
  const $ = k => box.querySelector(`[data-k="${k}"]`);
  const cur = () => hslToHex(h, s, l);
  const paint = (fromHex) => {
    const c = cur();
    $("prev").style.background = c;
    if (!fromHex) $("hex").value = c;
    $("h").value = h; $("s").value = s; $("l").value = l;
    $("s").style.background = `linear-gradient(90deg, ${hslToHex(h, 0, l)}, ${hslToHex(h, 100, l)})`;
    $("l").style.background = `linear-gradient(90deg, #000, ${hslToHex(h, s, 50)}, #fff)`;
  };
  for (const c of presets) { const b = document.createElement("button"); b.type = "button"; b.className = "swatch"; b.style.background = c; b.setAttribute("aria-label", c); b.onclick = () => { [h, s, l] = hexToHsl(c); paint(); }; $("sw").append(b); }
  box.addEventListener("input", e => {
    const k = e.target.dataset && e.target.dataset.k;
    if (k === "h" || k === "s" || k === "l") { ({ h, s, l } = { h: +$("h").value, s: +$("s").value, l: +$("l").value }); paint(); }
    else if (k === "hex") { let v = $("hex").value.trim(); if (v && v[0] !== "#") v = "#" + v; if (/^#[0-9a-f]{6}$/i.test(v)) { [h, s, l] = hexToHsl(v); paint(true); } }
  });
  paint();
  const ok = await confirmDialog({ title, node: box, okText: "Set", cancelText: "Cancel" });
  return ok ? cur() : null;
}

if (useCustomUI()) {
  const go = () => { scan(document); new MutationObserver(recs => { for (const r of recs) for (const n of r.addedNodes) if (n.nodeType === 1) { if (n.tagName === "SELECT") enhance(n); else scan(n); } }).observe(document.documentElement, { childList: true, subtree: true }); };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", go); else go();
}
