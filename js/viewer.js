// Image viewer with its own zoom: wheel / pinch / double-tap to zoom, drag to pan, the image's alt text as a small caption.
import { icon } from "./ui.js";
import { downloadMedia } from "./download.js";

let dlg = null, imgEl, capEl, label;
const S = { k: 1, x: 0, y: 0 };
const pts = new Map();
let pinch0 = null, drag0 = null, moved = false, lastTap = 0;
const GENERIC = /^(image|linked image|photo|picture)$/i;

function apply() {
  const k = S.k;
  if (k <= 1.001) { S.k = 1; S.x = 0; S.y = 0; }
  else {                                   // keep the picture from being dragged away entirely
    const w = imgEl.clientWidth * k, h = imgEl.clientHeight * k, mx = Math.max(0, (w - dlg.clientWidth) / 2 + 60), my = Math.max(0, (h - dlg.clientHeight) / 2 + 60);
    S.x = Math.max(-mx, Math.min(mx, S.x)); S.y = Math.max(-my, Math.min(my, S.y));
  }
  imgEl.style.transform = `translate(${S.x}px, ${S.y}px) scale(${S.k})`;
  label.textContent = Math.round(S.k * 100) + "%";
  dlg.classList.toggle("zoomed", S.k > 1);
}
function zoomAt(nk, cx, cy) {
  nk = Math.max(1, Math.min(8, nk));
  const r = dlg.getBoundingClientRect(), ox = cx - (r.left + r.width / 2), oy = cy - (r.top + r.height / 2);
  const f = nk / S.k;
  S.x = ox - (ox - S.x) * f; S.y = oy - (oy - S.y) * f; S.k = nk; apply();
}
const mid = () => { const [a, b] = [...pts.values()]; return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, d: Math.hypot(a.x - b.x, a.y - b.y) }; };

function build() {
  dlg = document.createElement("dialog");
  dlg.className = "qm-viewer";
  dlg.innerHTML = `<div class="qv-bar"><span class="qv-zoom">100%</span>
    <button type="button" class="qv-b" data-a="out" aria-label="Zoom out">−</button><button type="button" class="qv-b" data-a="in" aria-label="Zoom in">+</button>
    <button type="button" class="qv-b" data-a="reset" aria-label="Reset zoom">1:1</button>
    <button type="button" class="qv-b qv-dl" data-a="dl" aria-label="Download">${icon("download", 18)}</button>
    <button type="button" class="qv-b" data-a="close" aria-label="Close">${icon("close", 18)}</button></div>
    <div class="qv-stage"><img alt="" draggable="false"></div><div class="qv-cap" hidden></div>`;
  document.body.append(dlg);
  imgEl = dlg.querySelector("img"); capEl = dlg.querySelector(".qv-cap"); label = dlg.querySelector(".qv-zoom");
  const stage = dlg.querySelector(".qv-stage");
  dlg.querySelector(".qv-bar").addEventListener("click", e => {
    const a = e.target.closest("[data-a]")?.dataset.a; if (!a) return;
    const r = dlg.getBoundingClientRect(), cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    if (a === "dl") downloadMedia(imgEl.src, dlg.dataset.name || ""); else if (a === "close") dlg.close(); else if (a === "in") zoomAt(S.k * 1.5, cx, cy); else if (a === "out") zoomAt(S.k / 1.5, cx, cy); else { S.k = 1; apply(); }
  });
  stage.addEventListener("wheel", e => { e.preventDefault(); zoomAt(S.k * Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0018)), e.clientX, e.clientY); }, { passive: false });
  stage.addEventListener("pointerdown", e => {
    stage.setPointerCapture(e.pointerId); pts.set(e.pointerId, { x: e.clientX, y: e.clientY }); moved = false;
    if (pts.size === 2) { const m = mid(); pinch0 = { d: m.d, k: S.k }; drag0 = null; }
    else drag0 = { x: e.clientX, y: e.clientY, sx: S.x, sy: S.y };
  });
  stage.addEventListener("pointermove", e => {
    if (!pts.has(e.pointerId)) return;
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pts.size === 2 && pinch0) { const m = mid(); moved = true; zoomAt(pinch0.k * (m.d / pinch0.d), m.x, m.y); }
    else if (drag0 && S.k > 1) { moved = true; S.x = drag0.sx + e.clientX - drag0.x; S.y = drag0.sy + e.clientY - drag0.y; apply(); }
  });
  const up = e => {
    pts.delete(e.pointerId); pinch0 = null;
    if (pts.size === 1) { const p = [...pts.values()][0]; drag0 = { x: p.x, y: p.y, sx: S.x, sy: S.y }; } else drag0 = null;
    if (e.type === "pointerup" && !moved && pts.size === 0) {
      const now = Date.now();
      if (now - lastTap < 320) { lastTap = 0; if (S.k > 1) { S.k = 1; apply(); } else zoomAt(2.5, e.clientX, e.clientY); }
      else { lastTap = now; if (e.target === stage && S.k === 1) setTimeout(() => { if (lastTap === now) dlg.close(); }, 330); }
    }
  };
  stage.addEventListener("pointerup", up); stage.addEventListener("pointercancel", up);
  dlg.addEventListener("keydown", e => {
    if (e.key === "+" || e.key === "=") zoomAt(S.k * 1.3, innerWidth / 2, innerHeight / 2);
    else if (e.key === "-") zoomAt(S.k / 1.3, innerWidth / 2, innerHeight / 2);
    else if (e.key === "0") { S.k = 1; apply(); }
  });
  dlg.addEventListener("close", () => { imgEl.removeAttribute("src"); pts.clear(); });
}

/** Opens the viewer — in the top window, so the picture gets the whole screen (not just the chat panel). */
export function openImage(src, opts = {}) {
  try { if (window.top !== window && typeof window.top.__qmOpenImage === "function") return window.top.__qmOpenImage(src, { alt: opts.alt || "", name: opts.name || "" }); } catch (_) { /* cross-origin top: use ours */ }
  return openHere(src, opts);
}
if (window.top === window) window.__qmOpenImage = (src, o) => openHere(src, o);

function openHere(src, { alt = "", name = "" } = {}) {
  if (!dlg) build();
  S.k = 1; S.x = 0; S.y = 0; apply();
  imgEl.src = src; imgEl.alt = alt || "";
  const a = String(alt || "").trim();
  capEl.hidden = !a || GENERIC.test(a); capEl.textContent = a;
  dlg.dataset.name = name || "";
  if (!dlg.open) dlg.showModal();
}
