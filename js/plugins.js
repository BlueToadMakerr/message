// Plugin host (runs in the app shell, only while Developer mode is on).
// Every enabled plugin runs inside its own sandboxed <iframe> (no access to this page, your account, cookies or storage) and talks to the
// site only through the messages handled here. Each call is checked against the permissions the plugin declared. Docs: plugin-docs.html
import { devOn, onDev, envInfo } from "./dev.js";
import { loadPlugins, pluginIssues, isBlocked, MAX_CODE } from "./plugin-store.js";
import { SITE_VERSION, API_VERSION } from "./version.js";
import { localToast, promptDialog } from "./ui.js";

const runs = new Map();                 // plugin id -> { frame, plugin, handlers, panelEl, styles }
let ctx = { uid: null, name: "", chatId: null, call: null };
let panelsHost = null;
const store = id => "qm-pstore-" + id;
const readStore = id => { try { return JSON.parse(localStorage.getItem(store(id)) || "{}"); } catch (_) { return {}; } };
const writeStore = (id, o) => { const s = JSON.stringify(o); if (s.length > 100000) throw new Error("Plugin storage is full (100 KB)."); localStorage.setItem(store(id), s); };

// What a plugin's sandbox runs first. It is the only code that exists in the frame besides the plugin's own.
function boot(code, p) {
  const csp = `default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval'; img-src data:; style-src 'unsafe-inline'; connect-src ${p.permissions.includes("network") ? "https:" : "'none'"}`;
  const bootJs = `
const PID=${JSON.stringify(p.id)}, SITE=${JSON.stringify(SITE_VERSION)}, API=${API_VERSION};
const pending=new Map(); let seq=0; const handlers={};
const call=(m,a)=>new Promise((res,rej)=>{const id=++seq;pending.set(id,{res,rej});parent.postMessage({qm:1,id,m,a:a||[]},"*");});
addEventListener("message",e=>{ if(e.source!==parent)return; const d=e.data; if(!d||d.qm!==1)return;
  if(d.reply){const w=pending.get(d.id); if(!w)return; pending.delete(d.id); d.error?w.rej(new Error(d.error)):w.res(d.result);}
  else if(d.event){(handlers[d.event]||[]).slice().forEach(f=>{try{const r=f(d.data); if(r&&r.catch)r.catch(x=>call("log",["error in "+d.event+": "+x]));}catch(x){call("log",["error in "+d.event+": "+x]);}});}
});
const qm={ version:SITE, apiVersion:API,
  on(ev,fn){(handlers[ev]=handlers[ev]||[]).push(fn);return ()=>qm.off(ev,fn);}, off(ev,fn){handlers[ev]=(handlers[ev]||[]).filter(f=>f!==fn);},
  toast:(t,k)=>call("toast",[t,k]), me:()=>call("me"), log:(...a)=>call("log",a.map(x=>typeof x==="string"?x:JSON.stringify(x))),
  style:{set:css=>call("style.set",[css]),clear:()=>call("style.clear")},
  storage:{get:k=>call("storage.get",[k]),set:(k,v)=>call("storage.set",[k,v]),remove:k=>call("storage.remove",[k]),all:()=>call("storage.all")},
  chat:{current:()=>call("chat.current"),insertText:t=>call("chat.insertText",[t]),open:id=>call("chat.open",[id])},
  panel:{set:o=>call("panel.set",[o]),hide:()=>call("panel.hide")},
  page:{query:(s,o)=>call("page.query",[s,o]),click:(s,o)=>call("page.click",[s,o]),type:(s,t,o)=>call("page.type",[s,t,o]),scroll:o=>call("page.scroll",[o]),
    scrollUntil:o=>call("page.scrollUntil",[o]),cancel:()=>call("page.cancel"),highlight:(s,o)=>call("page.highlight",[s,o]),url:o=>call("page.url",[o])},
  buttons:{add:o=>call("buttons.add",[o]),remove:id=>call("buttons.remove",[id]),clear:()=>call("buttons.clear")},
  calls:{state:()=>call("calls.state")},
  dev:{addCard:(scope,c)=>call("dev.addCard",[scope,c]),removeCard:id=>call("dev.removeCard",[id]),read:scope=>call("dev.read",[scope])},
  ask:(t,ph)=>call("ask",[t,ph]),
  sleep:ms=>new Promise(r=>setTimeout(r,Math.max(0,Math.min(60000,+ms||0)))),
  fetch:(...a)=>fetch(...a) };
const AsyncFunction=Object.getPrototypeOf(async function(){}).constructor;
(async()=>{ try{ await new AsyncFunction("qm",${JSON.stringify(code)})(qm); call("ready"); }catch(e){ call("crash",[String(e&&e.stack||e)]); } })();`;
  return `<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp}"><script>${bootJs.replace(/<\/script/gi, "<\\/script")}<\/script>`;
}

const need = (run, perm) => { if (!run.plugin.permissions.includes(perm)) throw new Error(`Needs the "${perm}" permission (add it to the plugin).`); };

function frames() { return [...document.querySelectorAll("iframe")].filter(f => { try { return !!f.contentDocument; } catch (_) { return false; } }); }
function applyStyle(run) {
  const targets = [document, ...frames().map(f => f.contentDocument)];
  for (const d of targets) {
    let s = d.querySelector(`style[data-qm-plugin="${run.plugin.id}"]`);
    if (!run.css) { s?.remove(); continue; }
    if (!s) { s = d.createElement("style"); s.dataset.qmPlugin = run.plugin.id; (d.head || d.documentElement).appendChild(s); }
    s.textContent = run.css;
  }
}
document.addEventListener("load", e => { if (e.target && e.target.tagName === "IFRAME") { for (const r of runs.values()) { if (r.css) setTimeout(() => applyStyle(r), 0); if (r.buttons.size) setTimeout(() => injectButtons(r), 100); } emit("page-load", { frame: e.target.id === "callFrame" ? "call" : "detail" }); } }, true);

function paintPanel(run, o) {
  if (!panelsHost) { panelsHost = document.createElement("div"); panelsHost.className = "plugin-panels"; document.body.appendChild(panelsHost); }
  let el = run.panelEl;
  if (!o) { el?.remove(); run.panelEl = null; return; }
  if (!el) { el = document.createElement("section"); el.className = "plugin-panel"; panelsHost.appendChild(el); run.panelEl = el; }
  el.replaceChildren();
  const h = document.createElement("strong"); h.textContent = String(o.title || run.plugin.name).slice(0, 60); el.appendChild(h);
  const x = document.createElement("button"); x.type = "button"; x.className = "plugin-x"; x.textContent = "×"; x.setAttribute("aria-label", "Close panel"); x.onclick = () => paintPanel(run, null); el.appendChild(x);
  for (const l of (Array.isArray(o.lines) ? o.lines : []).slice(0, 30)) { const p = document.createElement("div"); p.textContent = String(l).slice(0, 300); el.appendChild(p); }
  for (const b of (Array.isArray(o.buttons) ? o.buttons : []).slice(0, 8)) {
    const bt = document.createElement("button"); bt.type = "button"; bt.className = "btn small"; bt.textContent = String(b).slice(0, 40);
    bt.onclick = () => send(run, "panel-button", { label: String(b) }); el.appendChild(bt);
  }
}


// ---------------------------------------------------------------- page control helpers
const DEV_SCOPES = ["app", "chat", "message", "call"];
const FRAMES = { detail: "detailFrame", call: "callFrame" };
function targetDoc(name) {
  if (name === "shell") return document;
  const f = document.getElementById(FRAMES[name || "detail"] || "detailFrame");
  try { return f && f.contentDocument && f.contentDocument.body ? f.contentDocument : null; } catch (_) { return null; }
}
function queryPage(sel, o) {
  const doc = targetDoc(o.frame); if (!doc) throw new Error("That part of the page is not open.");
  sel = String(sel || ""); if (!sel || sel.length > 200) throw new Error("Give a CSS selector (200 characters at most).");
  let list; try { list = [...doc.querySelectorAll(sel)]; } catch (_) { throw new Error("Not a valid CSS selector."); }
  const text = o.text ? String(o.text).toLowerCase() : "";
  const out = []; list.forEach((el, i) => { if (!text || (el.innerText || el.textContent || "").toLowerCase().includes(text)) out.push({ el, i }); });
  return out.slice(0, Math.max(1, Math.min(200, Number(o.limit) || 50)));
}
function pick(sel, o) {
  o = o || {}; const list = queryPage(sel, { ...o, limit: 200 }), i = Number(o.index) || 0;
  if (!list[i]) throw new Error("Nothing on the page matches " + String(sel).slice(0, 60) + (o.text ? ' with "' + String(o.text).slice(0, 30) + '"' : "") + ".");
  return list[i].el;
}
function describe(el, i) {
  const r = el.getBoundingClientRect(), a = {};
  for (const n of ["id", "class", "href", "title", "aria-label", "role", "type", "name", "placeholder"]) { const v = el.getAttribute(n); if (v) a[n] = v.slice(0, 200); }
  for (const at of el.attributes) if (at.name.startsWith("data-")) a[at.name] = at.value.slice(0, 100);
  if ("value" in el && el.type !== "password" && typeof el.value === "string") a.value = el.value.slice(0, 300);
  return { index: i, tag: el.tagName.toLowerCase(), text: (el.innerText || el.textContent || "").trim().slice(0, 300), attrs: a, visible: r.width > 0 && r.height > 0, rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) } };
}
function scroller(doc, sel) {
  if (!doc) throw new Error("That part of the page is not open.");
  if (sel) { const e = doc.querySelector(String(sel).slice(0, 200)); if (!e) throw new Error("The scroll area was not found."); return e; }
  return doc.getElementById("messages") || doc.scrollingElement || doc.documentElement;
}
function flash(el) { try { el.scrollIntoView({ block: "center" }); el.animate([{ boxShadow: "0 0 0 4px #f59e0b" }, { boxShadow: "0 0 0 0 transparent" }], { duration: 1800, iterations: 2 }); } catch (_) { /* ignore */ } }
const sleep = ms => new Promise(r => setTimeout(r, ms));

let searchPill = null;
function pill(text, onStop) {
  if (!text) { searchPill?.remove(); searchPill = null; return; }
  if (!searchPill) { searchPill = document.createElement("div"); searchPill.className = "plugin-search"; document.body.appendChild(searchPill); }
  searchPill.replaceChildren(document.createTextNode(text + " "));
  const b = document.createElement("button"); b.type = "button"; b.className = "btn small"; b.textContent = "Stop"; b.onclick = onStop; searchPill.appendChild(b);
}
/** Scrolls a list (the open chat by default) until something on screen matches, loading older messages on the way. */
async function searchScroll(run, o) {
  if (run.search) run.search.stop = true;
  const me = run.search = { stop: false };
  const doc = targetDoc(o.frame), sc = scroller(doc, o.scroller), sel = String(o.selector || ".msg").slice(0, 200);
  const needle = String(o.text || "").toLowerCase();
  let re = null; if (o.regex) { try { re = new RegExp(String(o.regex).slice(0, 100), "i"); } catch (_) { throw new Error("Not a valid regular expression."); } }
  if (!needle && !re) throw new Error("Give text or regex to look for.");
  const dir = o.direction === "down" ? "down" : "up", maxMs = Math.max(1000, Math.min(120000, Number(o.maxMs) || 30000)), t0 = Date.now();
  const label = "Looking for “" + (o.text || o.regex).toString().slice(0, 30) + "”…";
  pill(label, () => { me.stop = true; });
  let still = 0, result = null;
  try {
    while (!me.stop && Date.now() - t0 < maxMs) {
      let list; try { list = [...doc.querySelectorAll(sel)]; } catch (_) { throw new Error("Not a valid CSS selector."); }
      const hits = list.filter(e => { const t = e.innerText || e.textContent || ""; return re ? re.test(t) : t.toLowerCase().includes(needle); });
      const hit = dir === "up" ? hits[hits.length - 1] : hits[0];
      if (hit) { flash(hit); result = { found: true, text: (hit.innerText || hit.textContent || "").trim().slice(0, 200), key: hit.dataset ? hit.dataset.key || null : null, waitedMs: Date.now() - t0 }; break; }
      const before = sc.scrollHeight, top = sc.scrollTop;
      // a page only reacts when the scroll position CHANGES, so step away from the edge first, then go back to it
      if (dir === "up") { if (sc.scrollTop < 140) { sc.scrollTop = Math.min(sc.scrollHeight, 180); await sleep(80); } sc.scrollTop = 0; }
      else { if (sc.scrollHeight - sc.scrollTop - sc.clientHeight < 140) { sc.scrollTop = Math.max(0, sc.scrollTop - 180); await sleep(80); } sc.scrollTop = sc.scrollHeight; }
      await sleep(450);
      still = sc.scrollHeight === before && Math.abs(sc.scrollTop - top) < 2 || sc.scrollHeight === before ? still + 1 : 0;
      if (still >= 4) { result = { found: false, reason: dir === "up" ? "reached the start" : "reached the end" }; break; }
    }
    if (!result) result = { found: false, reason: me.stop ? "stopped" : "timeout" };
  } finally { if (run.search === me) { run.search = null; pill(null); } }
  return result;
}

// ---------------------------------------------------------------- buttons
function injectButtons(run) {
  const spots = { chat: () => { const d = targetDoc("detail"); return d && d.querySelector("#chatOptionsBtn") ? { doc: d, host: d.querySelector("#chatOptionsBtn").parentNode, before: d.querySelector("#chatOptionsBtn") } : null; },
    list: () => { const d = document; const h = d.getElementById("topActions"); return h ? { doc: d, host: h, before: h.firstChild } : null; },
    call: () => { const d = targetDoc("call"); const h = d && d.querySelector("#dock .dock-pill"); return h ? { doc: d, host: h, before: d.getElementById("moreBtn") } : null; } };
  const mark = `${run.plugin.id}`;
  for (const d of [document, targetDoc("detail"), targetDoc("call")]) if (d) d.querySelectorAll(`[data-qm-plugin-btn^="${mark}:"]`).forEach(b => { const id = b.dataset.qmPluginBtn.slice(mark.length + 1); if (!run.buttons.has(id)) b.remove(); });
  for (const b of run.buttons.values()) {
    const sp = spots[b.where](); if (!sp) continue;
    const key = `${mark}:${b.id}`;
    if (sp.doc.querySelector(`[data-qm-plugin-btn="${key}"]`)) continue;
    const el = sp.doc.createElement("button"); el.type = "button"; el.className = "btn small plugin-btn"; el.textContent = b.label; el.title = b.title; el.dataset.qmPluginBtn = key;
    el.onclick = () => send(run, "button", { id: b.id, where: b.where });
    sp.host.insertBefore(el, sp.before || null);
  }
}
setInterval(() => { for (const r of runs.values()) if (r.buttons.size) injectButtons(r); }, 1500);      // pages are replaced when you move around: put the buttons back

// ---------------------------------------------------------------- calls and developer views
const callInfo = () => ctx.call ? { chatId: ctx.call.chatId || null, joined: !!ctx.call.joined, visible: !!ctx.call.visible, muted: !!ctx.call.muted, camOn: !!ctx.call.camOn, screenOn: !!ctx.call.screenOn, startedAt: ctx.call.startLocal || null, title: ctx.call.title || "" } : { chatId: null, joined: false, visible: false };
/** Cards that plugins want in a developer view (read by dev.js, from any frame). */
function devCards(scope) {
  const out = [];
  for (const r of runs.values()) for (const c of r.cards.values()) if (c.scope === scope) out.push({ id: r.plugin.id + ":" + c.id, plugin: c.plugin, title: c.title, rows: c.rows });
  return out;
}
const lastView = {};
function devView(scope) { const n = Date.now(); if (n - (lastView[scope] || 0) < 800) return; lastView[scope] = n; emit("dev-view", { scope }); }

const api = {
  toast: (run, [t, k]) => { need(run, "toast"); localToast(`${run.plugin.name}: ${String(t).slice(0, 200)}`, ["info", "success", "error"].includes(k) ? k : "info"); },
  log: (run, a) => { run.logs.push(a.join(" ").slice(0, 500)); if (run.logs.length > 100) run.logs.shift(); console.log("[plugin " + run.plugin.name + "]", ...a); },
  me: run => { need(run, "me"); return { uid: ctx.uid, displayName: ctx.name }; },
  "style.set": (run, [css]) => { need(run, "style"); run.css = String(css).slice(0, 50000); applyStyle(run); },
  "style.clear": run => { need(run, "style"); run.css = ""; applyStyle(run); },
  "storage.get": (run, [k]) => readStore(run.plugin.id)[String(k)] ?? null,
  "storage.set": (run, [k, v]) => { const o = readStore(run.plugin.id); o[String(k).slice(0, 80)] = v; writeStore(run.plugin.id, o); },
  "storage.remove": (run, [k]) => { const o = readStore(run.plugin.id); delete o[String(k)]; writeStore(run.plugin.id, o); },
  "storage.all": run => readStore(run.plugin.id),
  "chat.open": (run, [id]) => { need(run, "chat"); if (!/^[\w-]{1,64}$/.test(String(id))) throw new Error("Not a chat id."); window.QM?.openChat?.(String(id)); },
  "chat.current": run => { need(run, "chat"); return ctx.chatId ? { chatId: ctx.chatId } : null; },
  "chat.insertText": (run, [t]) => {
    need(run, "chat");
    const f = document.getElementById("detailFrame");
    const inp = f && f.contentDocument && f.contentDocument.getElementById("msgInput");
    if (!inp) throw new Error("No chat is open.");
    inp.value = (inp.value ? inp.value + " " : "") + String(t).slice(0, 2000);
    inp.dispatchEvent(new Event("input", { bubbles: true })); inp.focus();
  },
  "panel.set": (run, [o]) => { need(run, "panel"); paintPanel(run, o || {}); },
  "panel.hide": run => { need(run, "panel"); paintPanel(run, null); },
  // ---- page control (permission "page")
  "page.query": (run, [sel, o]) => { need(run, "page"); return queryPage(sel, o || {}).map(e => describe(e.el, e.i)); },
  "page.click": (run, [sel, o]) => { need(run, "page"); const e = pick(sel, o); e.click(); return true; },
  "page.type": (run, [sel, text, o]) => {
    need(run, "page"); const e = pick(sel, o);
    if (!/^(INPUT|TEXTAREA)$/.test(e.tagName) && !e.isContentEditable) throw new Error("That element is not a text field.");
    if (e.type === "password") throw new Error("Plugins cannot type into password fields.");
    const t = String(text).slice(0, 5000);
    if (e.isContentEditable) e.textContent = t;
    else { const win = e.ownerDocument.defaultView, proto = e.tagName === "TEXTAREA" ? win.HTMLTextAreaElement.prototype : win.HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(proto, "value").set.call(e, t); }
    e.dispatchEvent(new Event("input", { bubbles: true })); e.dispatchEvent(new Event("change", { bubbles: true })); return true;
  },
  "page.scroll": (run, [o]) => {
    need(run, "page"); o = o || {}; const doc = targetDoc(o.frame), sc = scroller(doc, o.scroller);
    if (o.to === "top") sc.scrollTop = 0; else if (o.to === "bottom") sc.scrollTop = sc.scrollHeight;
    else if (typeof o.to === "number") sc.scrollTop = o.to; else if (typeof o.by === "number") sc.scrollTop += o.by;
    else if (typeof o.to === "string") pick(o.to, o).scrollIntoView({ block: "center" });
    return { top: Math.round(sc.scrollTop), height: sc.scrollHeight, view: sc.clientHeight };
  },
  "page.scrollUntil": (run, [o]) => { need(run, "page"); return searchScroll(run, o || {}); },
  "page.cancel": run => { need(run, "page"); if (run.search) run.search.stop = true; },
  "page.highlight": (run, [sel, o]) => { need(run, "page"); const e = pick(sel, o); flash(e); return true; },
  "page.url": (run, [o]) => { need(run, "page"); const d = targetDoc((o || {}).frame); return d ? String(d.location.pathname + d.location.search) : null; },
  // ---- buttons (permission "buttons")
  "buttons.add": (run, [o]) => {
    need(run, "buttons"); o = o || {};
    const id = String(o.id || "").slice(0, 40), where = ["chat", "list", "call"].includes(o.where) ? o.where : "chat";
    if (!/^[\w.-]{1,40}$/.test(id)) throw new Error("A button needs an id (letters, numbers, - _ .).");
    if (run.buttons.size >= 6 && !run.buttons.has(id)) throw new Error("A plugin can add up to 6 buttons.");
    run.buttons.set(id, { id, where, label: String(o.label || id).slice(0, 24), title: String(o.title || o.label || id).slice(0, 80) }); injectButtons(run); return true;
  },
  "buttons.remove": (run, [id]) => { need(run, "buttons"); run.buttons.delete(String(id)); injectButtons(run); },
  "buttons.clear": run => { need(run, "buttons"); run.buttons.clear(); injectButtons(run); },
  // ---- calls (permission "calls")
  "calls.state": run => { need(run, "calls"); return callInfo(); },
  // ---- developer info (permission "devinfo")
  "dev.addCard": (run, [scope, c]) => {
    need(run, "devinfo"); if (!DEV_SCOPES.includes(scope)) throw new Error("scope must be one of: " + DEV_SCOPES.join(", "));
    c = c || {}; const id = String(c.id || "card").slice(0, 40);
    if (run.cards.size >= 8 && !run.cards.has(id)) throw new Error("A plugin can add up to 8 developer cards.");
    const rows = (Array.isArray(c.rows) ? c.rows : []).slice(0, 40).map(r => Array.isArray(r) ? [String(r[0]).slice(0, 60), String(r[1] ?? "").slice(0, 300), ["ok", "warn", "bad", "info"].includes(r[2]) ? r[2] : ""] : null).filter(Boolean);
    run.cards.set(id, { scope, id, plugin: run.plugin.name, title: String(c.title || run.plugin.name).slice(0, 60), rows });
  },
  "dev.removeCard": (run, [id]) => { need(run, "devinfo"); run.cards.delete(String(id)); },
  "dev.read": async (run, [scope]) => {
    need(run, "devinfo");
    let v;
    if (scope === "env") v = envInfo();
    else if (scope === "state") v = { chatId: ctx.chatId, call: callInfo(), plugins: [...runs.values()].map(r => ({ name: r.plugin.name, state: r.state })) };
    else if (scope === "call") { const f = document.getElementById("callFrame"); const fn = f && f.contentWindow && f.contentWindow.__qmDev && f.contentWindow.__qmDev.call; if (!fn) throw new Error("No call is running."); v = await fn(); }
    else throw new Error('scope must be "env", "state" or "call"');
    const s = JSON.stringify(v, (k, x) => typeof x === "function" ? undefined : x);
    if (s.length > 200000) throw new Error("That info is too big to hand to a plugin.");
    return JSON.parse(s);
  },
  ask: async (run, [title, placeholder]) => {
    if (!["panel", "buttons", "toast"].some(k => run.plugin.permissions.includes(k))) throw new Error('Needs the "panel", "buttons" or "toast" permission to ask the user something.');
    if (run.asking) throw new Error("Already asking.");
    run.asking = true;
    try { return await promptDialog({ title: String(title || "Question").slice(0, 80), message: "Asked by the plugin “" + run.plugin.name + "”.", input: { placeholder: String(placeholder || "").slice(0, 80), maxLength: 500 }, okText: "OK" }); }
    finally { run.asking = false; }
  },
  ready: run => { run.state = "running"; },
  crash: (run, [e]) => { run.state = "crashed"; run.error = String(e).slice(0, 600); api.log(run, ["crashed: " + run.error]); localToast(`Plugin “${run.plugin.name}” crashed: ${run.error.split("\n")[0]}`, "error", 6000); }
};

function send(run, event, data) { try { run.frame.contentWindow.postMessage({ qm: 1, event, data }, "*"); } catch (_) { /* frame gone */ } }
const PERM_OF = { message: "messages", "chat-open": "chat", "chat-close": "chat", button: "buttons", "call-state": "calls", "dev-view": "devinfo", "page-load": "page" };
const wants = (run, event) => !PERM_OF[event] || run.plugin.permissions.includes(PERM_OF[event]);

addEventListener("message", async e => {
  const d = e.data; if (!d || d.qm !== 1 || !d.m) return;
  const run = [...runs.values()].find(r => r.frame.contentWindow === e.source); if (!run) return;
  const reply = (result, error) => { try { e.source.postMessage({ qm: 1, reply: true, id: d.id, result, error }, "*"); } catch (_) { /* ignore */ } };
  const fn = api[d.m];
  if (!fn) return reply(undefined, "Unknown method " + String(d.m).slice(0, 40));
  try { reply(await fn(run, Array.isArray(d.a) ? d.a : [])); } catch (err) { reply(undefined, String(err && err.message || err)); }
});

export function startPlugin(p) {
  stopPlugin(p.id);
  if (isBlocked(p) || !p.enabled || p.code.length > MAX_CODE) return;
  const frame = document.createElement("iframe");
  frame.setAttribute("sandbox", "allow-scripts");          // no allow-same-origin: the plugin cannot reach the site, its cookies, storage or Firebase login
  frame.setAttribute("aria-hidden", "true"); frame.tabIndex = -1; frame.title = "Plugin: " + p.name;
  frame.style.cssText = "position:fixed;width:0;height:0;border:0;opacity:0;pointer-events:none";
  frame.srcdoc = boot(p.code, p);
  runs.set(p.id, { frame, plugin: p, state: "starting", error: "", logs: [], css: "", panelEl: null, buttons: new Map(), cards: new Map(), search: null });
  document.body.appendChild(frame);
}
export function stopPlugin(id) {
  const r = runs.get(id); if (!r) return;
  r.css = ""; applyStyle(r); paintPanel(r, null); if (r.search) r.search.stop = true; r.buttons.clear(); injectButtons(r); r.frame.remove(); runs.delete(id);
}
export const stopAll = () => [...runs.keys()].forEach(stopPlugin);
export function startAll() {
  if (!devOn()) return;
  const list = loadPlugins();
  const warn = list.filter(p => p.enabled && pluginIssues(p).length);
  for (const p of list) if (p.enabled) startPlugin(p);
  for (const p of warn) { const i = pluginIssues(p)[0]; localToast(`Plugin “${p.name}”: ${i.text}`, i.level === "error" ? "error" : "info", 8000); }
}
export function emit(event, data) { for (const r of runs.values()) if (wants(r, event)) send(r, event, data); }
export const status = () => [...runs.values()].map(r => ({ id: r.plugin.id, name: r.plugin.name, state: r.state, error: r.error, logs: r.logs.slice(-20) }));

/** Shell: tell plugins which account / chat is current. */
export function setContext(c) {
  const chatChanged = "chatId" in c && c.chatId !== ctx.chatId;
  const old = ctx.chatId;
  const callBefore = JSON.stringify(callInfo());
  ctx = { ...ctx, ...c };
  if ("call" in c && JSON.stringify(callInfo()) !== callBefore) emit("call-state", callInfo());
  if (chatChanged) { if (old) emit("chat-close", { chatId: old }); if (ctx.chatId) emit("chat-open", { chatId: ctx.chatId }); }
}

onDev(on => { if (on) startAll(); else stopAll(); });
addEventListener("storage", e => { if (e.key === "qm-plugins" && devOn()) startAll(); });
if (devOn()) setTimeout(startAll, 800);
export const plugins = { emit, setContext, startPlugin, stopPlugin, startAll, stopAll, status, devCards, devView };
