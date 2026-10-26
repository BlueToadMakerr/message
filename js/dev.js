// Developer mode (Account → Developer). Off by default. When on, small "{ }" buttons appear (chat list, chat, message menu, call, account)
// that open raw, copyable information. Nothing else changes, so nothing gets in the way when it is off.
import { confirmDialog, copyText, toast, avatarEl } from "./ui.js";

const KEY = "qm-dev";
export const devOn = () => { try { return localStorage.getItem(KEY) === "1"; } catch (_) { return false; } };
const listeners = new Set();
function apply() { document.documentElement.classList.toggle("dev-on", devOn()); listeners.forEach(f => { try { f(devOn()); } catch (_) { /* ignore */ } }); }
export function setDev(on) { try { on ? localStorage.setItem(KEY, "1") : localStorage.removeItem(KEY); } catch (_) { /* ignore */ } apply(); }
export const onDev = fn => { listeners.add(fn); return () => listeners.delete(fn); };
apply();
addEventListener("storage", e => { if (e.key === KEY) apply(); });

/** JSON for display: long strings (data URLs, ciphertext, base64) are shortened, errors / maps / sets are readable. */
export function plain(v, max = 240) {
  const seen = new WeakSet();
  return JSON.stringify(v, (k, x) => {
    if (typeof x === "string" && x.length > max) return x.slice(0, max) + `… (${x.length} chars)`;
    if (x instanceof Map) return Object.fromEntries(x);
    if (x instanceof Set) return [...x];
    if (x instanceof Error) return { name: x.name, message: x.message };
    if (typeof x === "function") return "[function]";
    if (typeof x === "bigint") return String(x);
    if (x && typeof x === "object") { if (seen.has(x)) return "[circular]"; seen.add(x); }
    return x;
  }, 2);
}

/** A small button that exists only in developer mode. */
export function devButton(label, onclick, { title = "Developer info", cls = "" } = {}) {
  const b = document.createElement("button");
  b.type = "button"; b.className = "dev-btn " + cls; b.textContent = label; b.title = title; b.setAttribute("aria-label", title);
  b.addEventListener("click", e => { e.stopPropagation(); onclick(e); });
  return b;
}

/** Shows raw data in a dialog with a Copy button. `get` may be a function (re-read every `every` ms for live numbers). */
export async function showRaw(title, get, { every = 0 } = {}) {
  const data = () => { try { return typeof get === "function" ? get() : get; } catch (e) { return { error: String(e) }; } };
  const pre = document.createElement("pre"); pre.className = "dev-pre";
  const wrap = document.createElement("div"); wrap.className = "stack";
  const copy = document.createElement("button"); copy.type = "button"; copy.className = "btn small"; copy.textContent = "Copy all";
  let last = "";
  const paint = async () => { const d = await data(); last = typeof d === "string" ? d : plain(d); pre.textContent = last; };
  copy.onclick = async () => { try { await copyText(last); copy.textContent = "Copied ✓"; } catch (_) { copy.textContent = "Couldn't copy"; } setTimeout(() => { copy.textContent = "Copy all"; }, 1500); };
  wrap.append(copy, pre);
  await paint();
  const t = every ? setInterval(paint, every) : 0;
  try { await confirmDialog({ title, node: wrap, okText: "Close", hideCancel: true }); } finally { if (t) clearInterval(t); }
}

/** Handy facts about this page / device for every raw view. */
export function envInfo() {
  const nav = navigator, c = nav.connection || {};
  const res = (() => { try { const r = performance.getEntriesByType("resource"); const by = {}; let total = 0; for (const e of r) { const k = (e.initiatorType || "other"); by[k] = (by[k] || 0) + (e.transferSize || 0); total += e.transferSize || 0; } return { requests: r.length, transferredBytes: total, byType: by }; } catch (_) { return null; } })();
  let store = {}; try { for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); store[k] = (localStorage.getItem(k) || "").length; } } catch (_) { /* ignore */ }
  return {
    time: new Date().toISOString(), url: location.href, userAgent: nav.userAgent, language: nav.language, online: nav.onLine,
    app: !!window.QMApp, standalone: matchMedia("(display-mode: standalone)").matches,
    viewport: { w: innerWidth, h: innerHeight, dpr: devicePixelRatio }, network: { type: c.effectiveType, downlink: c.downlink, rtt: c.rtt, saveData: c.saveData },
    memoryMB: performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1048576) : undefined,
    loadedResources: res, localStorageBytesByKey: store,
    navigation: (() => { try { const n = performance.getEntriesByType("navigation")[0]; return n && { domContentLoadedMs: Math.round(n.domContentLoadedEventEnd), loadMs: Math.round(n.loadEventEnd) }; } catch (_) { return null; } })(),
  };
}

// ---------------------------------------------------------------- visual developer views
const h = (tag, cls, content) => { const e = document.createElement(tag); if (cls) e.className = cls; if (content != null) (content instanceof Node ? e.append(content) : (e.textContent = content)); return e; };
/** Small coloured label. tone: ok | warn | bad | info | "" */
export const devPill = (text, tone = "") => h("span", "dev-pill " + tone, text);
/** A horizontal meter (value out of max). */
export function devBar(value, max, tone = "") {
  const b = h("span", "dev-bar " + tone), i = h("i"); i.style.width = Math.max(0, Math.min(100, (value / max) * 100)) + "%"; b.append(i); return b;
}
/** Avatar + name (+ small grey line), for "who is this" headers. */
export function devWho(name, pfp, sub) {
  const w = h("div", "dev-who"); w.append(avatarEl(name || "?", pfp || "", "avatar sm"));
  const t = h("div", "dev-who-t"); t.append(h("strong", "", name || "Unknown")); if (sub) t.append(h("small", "muted", sub)); w.append(t); return w;
}
/** A titled card of label/value rows. A row is [label, value(string|Node), tone?]; a value of undefined/null is skipped. */
export function devCard(title, rows, { head } = {}) {
  const c = h("section", "dev-card");
  if (head) c.append(head); else if (title) c.append(h("div", "dev-card-t", title));
  for (const r of rows) {
    if (!r) continue;
    if (r.section) { c.append(h("div", "dev-sec", r.section)); continue; }
    if (r[1] == null || r[1] === "") continue;
    const row = h("div", "dev-row " + (r[2] || "")); row.append(h("span", "dev-k", r[0]));
    const v = h("span", "dev-v"); r[1] instanceof Node ? v.append(r[1]) : (v.textContent = String(r[1])); row.append(v); c.append(row);
    const hist = r[3];
    if (hist && hist.h) {                                    // click the row to see how the value has moved
      row.classList.add("has-hist"); row.title = "Click for history graph"; row.tabIndex = 0;
      const toggle = () => { if (OPEN.has(hist.h)) { OPEN.delete(hist.h); row.nextSibling && row.nextSibling.classList && row.nextSibling.classList.contains("dev-graph") && row.nextSibling.remove(); row.classList.remove("open"); } else { OPEN.add(hist.h); row.classList.add("open"); row.after(devGraph(hist.h, hist.unit)); } };
      row.addEventListener("click", toggle); row.addEventListener("keydown", e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggle(); } });
      if (OPEN.has(hist.h)) { row.classList.add("open"); c.append(devGraph(hist.h, hist.unit)); }   // (appended right after its row: rows are added in order)
    }
  }
  return c;
}
export const devSection = title => ({ section: title });
export const devGrid = (...cards) => { const g = h("div", "dev-grid"); g.append(...cards.flat().filter(Boolean)); return g; };

/** Dialog with a Visual tab (cards) and a Raw tab (JSON, copyable). `visual()` may be async and returns a Node / array of Nodes. */
export async function showDev(title, { visual, raw, every = 0 }) {
  const wrap = h("div", "stack dev-view"), tabs = h("div", "dev-tabs"), pane = h("div", "dev-pane");
  const mk = (id, label) => { const b = h("button", "dev-tab", label); b.type = "button"; b.dataset.tab = id; return b; };
  let mode = visual ? "visual" : "raw", last = "";
  tabs.append(...(visual ? [mk("visual", "Visual")] : []), mk("raw", "Raw"));
  const copy = h("button", "btn small", "Copy all"); copy.type = "button";
  const paint = async () => {
    tabs.querySelectorAll(".dev-tab").forEach(b => b.classList.toggle("on", b.dataset.tab === mode));
    copy.hidden = mode !== "raw";
    try {
      if (mode === "visual") { const n = await visual(); pane.replaceChildren(...[].concat(n).filter(Boolean)); }
      else { const d = await (typeof raw === "function" ? raw() : raw); last = typeof d === "string" ? d : plain(d); const pre = h("pre", "dev-pre", last); pane.replaceChildren(pre); }
    } catch (e) { pane.replaceChildren(h("pre", "dev-pre", String(e && e.stack || e))); }
  };
  tabs.addEventListener("click", e => { const b = e.target.closest(".dev-tab"); if (b) { mode = b.dataset.tab; paint(); } });
  copy.onclick = async () => { try { await copyText(last); copy.textContent = "Copied ✓"; } catch (_) { copy.textContent = "Couldn't copy"; } setTimeout(() => { copy.textContent = "Copy all"; }, 1500); };
  const top = h("div", "row wrap"); top.append(tabs, h("span", "grow"), ...(every ? [rateSelect(), spanSelect()] : []), copy);
  wrap.append(top, pane);
  await paint();
  const held = holdGuard(pane);                                                                  // keep the content still during a click
  const stop = every ? devLoop(() => (held() ? null : paint())) : null;                              // live views follow the chosen update speed
  try { await confirmDialog({ title, node: wrap, okText: "Close", hideCancel: true }); } finally { if (stop) stop(); histClear(); }
}
/** True while a click / press on `el` is in progress (so a live view doesn't swap its content under the finger). It always lets go again:
 *  a touch that turns into a scroll ends with pointercancel (no pointerup), and a release outside the window sends nothing, so it also expires by itself. */
export function holdGuard(el) {
  let until = 0;
  const hold = () => { until = Date.now() + 1500; }, free = () => { until = Date.now() + 60; };
  el.addEventListener("pointerdown", hold);
  for (const ev of ["pointerup", "pointercancel"]) addEventListener(ev, free, true);
  addEventListener("blur", free);
  return () => Date.now() < until;
}
export const fmtBytes = n => typeof n !== "number" ? "" : n < 1024 ? n + " B" : n < 1048576 ? (n / 1024).toFixed(1) + " KB" : (n / 1048576).toFixed(1) + " MB";

// ---------------------------------------------------------------- update speed (live views) and value history (graphs)
const RATE_KEY = "qm-dev-rate";
export const RATES = [[0, "Every frame"], [100, "100 ms"], [250, "250 ms"], [500, "0.5 s"], [1000, "1 s"], [2000, "2 s"], [3000, "3 s"]];
/** How often live developer views refresh, in ms (0 = every animation frame). */
export const devRate = () => { try { const v = localStorage.getItem(RATE_KEY); return v === null ? 1000 : Math.max(0, Math.min(3000, Number(v) || 0)); } catch (_) { return 1000; } };
export const setDevRate = ms => { try { localStorage.setItem(RATE_KEY, String(ms)); } catch (_) { /* ignore */ } };
/** A <select> for the update speed. */
export function rateSelect(onChange) {
  const sel = h("select", "dev-rate"); sel.title = "How often this view updates"; sel.setAttribute("aria-label", "Update speed");
  for (const [ms, label] of RATES) sel.add(new Option(label, String(ms)));
  sel.value = String(devRate());
  sel.onchange = () => { setDevRate(Number(sel.value)); onChange && onChange(Number(sel.value)); };
  addEventListener("storage", e => { if (e.key === RATE_KEY) sel.value = String(devRate()); });
  return sel;
}
/** Runs async `fn` repeatedly at the chosen speed (never overlapping itself). Returns stop(). */
export function devLoop(fn) {
  let stop = false, timer = 0, raf = 0;
  const run = async () => {
    if (stop) return;
    try { await Promise.race([fn(), new Promise(r => setTimeout(r, 5000))]); } catch (_) { /* keep going */ }     // a stuck request must not freeze the view for good
    if (stop) return;
    const ms = devRate();
    if (ms === 0) raf = requestAnimationFrame(run); else timer = setTimeout(run, ms);
  };
  run();
  return () => { stop = true; clearTimeout(timer); cancelAnimationFrame(raf); };
}

const HIST = new Map();            // key -> [[t, v], …]
const SPAN_KEY = "qm-dev-span", HIST_MAX = 8000;
/** How long a graph remembers (the "max length"), in seconds. */
export const SPANS = [[30, "30 s"], [60, "1 min"], [300, "5 min"], [600, "10 min"], [1800, "30 min"], [3600, "1 hour"]];
export const devSpan = () => { try { const v = Number(localStorage.getItem(SPAN_KEY)); return SPANS.some(s => s[0] === v) ? v : 600; } catch (_) { return 600; } };
export const setDevSpan = s => { try { localStorage.setItem(SPAN_KEY, String(s)); } catch (_) { /* ignore */ } trimAll(); };
/** A <select> for the graph length. */
export function spanSelect(onChange) {
  const sel = h("select", "dev-rate"); sel.title = "How much history the graphs keep"; sel.setAttribute("aria-label", "Graph length");
  for (const [s, label] of SPANS) sel.add(new Option("Graph: " + label, String(s)));
  sel.value = String(devSpan());
  sel.onchange = () => { setDevSpan(Number(sel.value)); onChange && onChange(Number(sel.value)); };
  addEventListener("storage", e => { if (e.key === SPAN_KEY) sel.value = String(devSpan()); });
  return sel;
}
function trim(a, t) { const lim = devSpan() * 1000; let i = 0; while (i < a.length && t - a[i][0] > lim) i++; if (i) a.splice(0, i); if (a.length > HIST_MAX) a.splice(0, a.length - HIST_MAX); }
function trimAll() { const t = performance.now(); for (const [k, a] of HIST) { trim(a, t); if (!a.length) HIST.delete(k); } }
/** Forget all recorded values (the live views do this when they close, so the next one starts clean). */
export function histClear() { HIST.clear(); }
export function histPush(key, v) {
  if (typeof v !== "number" || !isFinite(v)) return;
  let a = HIST.get(key); if (!a) HIST.set(key, a = []);
  const t = performance.now(); a.push([t, v]); LAST.set(key, t);
  trim(a, t);
  if (++pushes % 200 === 0) for (const [k, at] of LAST) if (t - at > 20000) { HIST.delete(k); LAST.delete(k); }     // things that vanished (someone left): drop their old numbers
}
let pushes = 0; const LAST = new Map();
export const histGet = key => { const a = HIST.get(key); if (a) trim(a, performance.now()); return HIST.get(key) || []; };
const OPEN = new Set();             // graphs the viewer has opened (kept across repaints)

/** Line graph of a value's history, with min / avg / max and a hover read-out. */
export function devGraph(key, unit = "") {
  const box = h("div", "dev-graph"), all = histGet(key), step = Math.ceil(all.length / 400), pts = step > 1 ? all.filter((_, i) => i % step === 0 || i === all.length - 1) : all;
  if (pts.length < 2) { box.append(h("small", "muted", "Collecting data… (" + pts.length + " sample" + (pts.length === 1 ? "" : "s") + ")")); return box; }
  const W = 300, H = 70, vs = pts.map(p => p[1]), min = Math.min(...vs), max = Math.max(...vs), avg = vs.reduce((a, b) => a + b, 0) / vs.length;
  const t0 = pts[0][0], t1 = pts[pts.length - 1][0], span = Math.max(1, t1 - t0), rng = max - min || 1;
  const X = t => ((t - t0) / span) * W, Y = v => H - 4 - ((v - min) / rng) * (H - 10);
  const d = pts.map((p, i) => (i ? "L" : "M") + X(p[0]).toFixed(1) + " " + Y(p[1]).toFixed(1)).join("");
  const ns = "http://www.w3.org/2000/svg", svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", `0 0 ${W} ${H}`); svg.setAttribute("preserveAspectRatio", "none"); svg.setAttribute("class", "dev-svg");
  svg.innerHTML = `<path d="${d}L${W} ${H}L0 ${H}Z" class="dev-area"/><path d="${d}" class="dev-line"/><line class="dev-cur" x1="0" x2="0" y1="0" y2="${H}" visibility="hidden"/>`;
  const fmt = v => (Math.abs(v) >= 100 ? Math.round(v) : Math.round(v * 100) / 100) + unit;
  const read = h("div", "dev-read", `now ${fmt(vs[vs.length - 1])} · min ${fmt(min)} · avg ${fmt(avg)} · max ${fmt(max)} · ${Math.round(span / 1000)} s${performance.now() - t1 > 4000 ? " · no new data for " + Math.round((performance.now() - t1) / 1000) + " s" : ""}`);
  svg.addEventListener("pointermove", e => {
    const r = svg.getBoundingClientRect(), f = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)), t = t0 + f * span;
    let best = pts[0]; for (const p of pts) if (Math.abs(p[0] - t) < Math.abs(best[0] - t)) best = p;
    const cur = svg.querySelector(".dev-cur"); cur.setAttribute("x1", X(best[0])); cur.setAttribute("x2", X(best[0])); cur.setAttribute("visibility", "visible");
    read.textContent = `${fmt(best[1])} · ${Math.round((t1 - best[0]) / 100) / 10} s ago`;
  });
  svg.addEventListener("pointerleave", () => { svg.querySelector(".dev-cur").setAttribute("visibility", "hidden"); read.textContent = `now ${fmt(vs[vs.length - 1])} · min ${fmt(min)} · avg ${fmt(avg)} · max ${fmt(max)} · ${Math.round(span / 1000)} s`; });
  box.append(svg, read);
  return box;
}
/** Row helper: a number that can be clicked to open its history graph. */
export function devHistRow(label, key, value, { unit = "", text, tone = "", digits = 1 } = {}) {
  if (typeof value !== "number" || !isFinite(value)) return null;
  histPush(key, value);
  const shown = text != null ? text : (Math.round(value * 10 ** digits) / 10 ** digits) + unit;
  return [label, shown, tone, { h: key, unit }];
}
