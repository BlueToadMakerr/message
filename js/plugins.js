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
const timers=new Set();
Object.assign(qm,{
  now:()=>Date.now(),
  every:(ms,fn)=>{const t=setInterval(()=>{try{const r=fn();if(r&&r.catch)r.catch(x=>call("log",["error in every: "+x]));}catch(x){call("log",["error in every: "+x]);}},Math.max(200,+ms||1000));timers.add(t);return()=>{clearInterval(t);timers.delete(t);};},
  after:(ms,fn)=>{const t=setTimeout(()=>{timers.delete(t);try{const r=fn();if(r&&r.catch)r.catch(x=>call("log",["error in after: "+x]));}catch(x){call("log",["error in after: "+x]);}},Math.max(0,+ms||0));timers.add(t);return()=>{clearTimeout(t);timers.delete(t);};},
  util:{
    debounce:(fn,ms)=>{let t;return(...a)=>{clearTimeout(t);t=setTimeout(()=>fn(...a),ms);};},
    throttle:(fn,ms)=>{let last=0;return(...a)=>{const n=Date.now();if(n-last>=ms){last=n;return fn(...a);}};},
    uid:()=>Math.random().toString(36).slice(2,10),
    clamp:(n,a,b)=>Math.min(b,Math.max(a,n)),
    fmtBytes:n=>{n=+n||0;const u=["B","KB","MB","GB"];let i=0;while(n>=1024&&i<3){n/=1024;i++;}return (i?n.toFixed(1):n)+" "+u[i];},
    fmtTime:(ts,o)=>new Date(ts).toLocaleString(undefined,o),
    fmtDuration:ms=>{ms=Math.max(0,+ms||0);const s=Math.floor(ms/1000),h=Math.floor(s/3600),m=Math.floor(s%3600/60),x=s%60;return (h?h+":"+String(m).padStart(2,"0"):m)+":"+String(x).padStart(2,"0");}
  },
  bus:{emit:(t,d)=>call("bus.emit",[t,d]),on:(t,fn)=>qm.on("bus",e=>{if(e&&e.topic===t)fn(e.data,e.from);})},
  app:{info:()=>call("app.info")},
  plugins:{list:()=>call("plugins.list")},
  messages:{list:o=>call("messages.list",[o]),find:o=>call("messages.find",[o]),get:k=>call("messages.get",[k]),jump:k=>call("messages.jump",[k]),reply:(k,t)=>call("messages.reply",[k,t])},
  clipboard:{write:t=>call("clipboard.write",[t])},
  notify:(t,b)=>call("notify",[t,b]), vibrate:p=>call("vibrate",[p]),
  keys:{add:o=>call("keys.add",[o]),remove:id=>call("keys.remove",[id]),clear:()=>call("keys.clear"),list:()=>call("keys.list")},
  commands:{add:o=>call("commands.add",[o]),remove:n=>call("commands.remove",[n]),clear:()=>call("commands.clear"),list:()=>call("commands.list")},
  banner:{show:o=>call("banner.show",[o]),hide:()=>call("banner.hide")}
});
Object.assign(qm.chat,{getText:()=>call("chat.getText"),setText:t=>call("chat.setText",[t]),clearText:()=>call("chat.setText",[""]),focus:()=>call("chat.focus"),list:()=>call("chat.list"),info:()=>call("chat.info"),send:(t,o)=>call("chat.send",[t,o])});
Object.assign(qm.style,{vars:o=>call("style.vars",[o]),get:()=>call("style.get"),sheet:(id,css)=>call("style.sheet",[id,css]),removeSheet:id=>call("style.removeSheet",[id])});
Object.assign(qm.storage,{keys:()=>call("storage.keys"),clear:()=>call("storage.clear"),usage:()=>call("storage.usage")});
Object.assign(qm.page,{waitFor:(s,o)=>call("page.waitFor",[s,o]),text:(s,o)=>call("page.text",[s,o]),attr:(s,n,o)=>call("page.attr",[s,n,o]),count:(s,o)=>call("page.count",[s,o]),
  focus:(s,o)=>call("page.focus",[s,o]),press:(k,s,o)=>call("page.press",[k,s,o]),select:(s,v,o)=>call("page.select",[s,v,o]),check:(s,v,o)=>call("page.check",[s,v,o]),
  hide:(s,o)=>call("page.hide",[s,o]),show:(s,o)=>call("page.show",[s,o]),title:t=>call("page.title",[t])});
const AsyncFunction=Object.getPrototypeOf(async function(){}).constructor;
(async()=>{ try{ await new AsyncFunction("qm",${JSON.stringify(code)})(qm); call("ready"); }catch(e){ call("crash",[String(e&&e.stack||e)]); } })();`;
  return `<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp}"><script>${bootJs.replace(/<\/script/gi, "<\\/script")}<\/script>`;
}

const need = (run, perm) => { if (!run.plugin.permissions.includes(perm)) throw new Error(`Needs the "${perm}" permission (add it to the plugin).`); };

function frames() { return [...document.querySelectorAll("iframe")].filter(f => { try { return !!f.contentDocument; } catch (_) { return false; } }); }
const styleText = run => (Object.keys(run.vars).length ? ":root{" + Object.entries(run.vars).map(([k, v]) => k + ":" + v + ";").join("") + "}\n" : "") + [...run.sheets.values()].join("\n") + "\n" + run.css;
function applyStyle(run) {
  const css = styleText(run).trim(), targets = [document, ...frames().map(f => f.contentDocument)];
  for (const d of targets) {
    let s = d.querySelector(`style[data-qm-plugin="${run.plugin.id}"]`);
    if (!css) { s?.remove(); continue; }
    if (!s) { s = d.createElement("style"); s.dataset.qmPlugin = run.plugin.id; (d.head || d.documentElement).appendChild(s); }
    s.textContent = css;
  }
}
document.addEventListener("load", e => { if (e.target && e.target.tagName === "IFRAME") { attachKeys(); for (const r of runs.values()) { if (styleText(r).trim()) setTimeout(() => applyStyle(r), 0); if (r.buttons.size) setTimeout(() => injectButtons(r), 100); } emit("page-load", { frame: e.target.id === "callFrame" ? "call" : "detail" }); } }, true);

function paintPanel(run, o) {
  if (!panelsHost) { panelsHost = document.createElement("div"); panelsHost.className = "plugin-panels"; document.body.appendChild(panelsHost); }
  let el = run.panelEl;
  if (!o) { el?.remove(); run.panelEl = null; return; }
  if (!el) { el = document.createElement("section"); el.className = "plugin-panel"; panelsHost.appendChild(el); run.panelEl = el; }
  el.replaceChildren();
  const h = document.createElement("strong"); h.textContent = String(o.title || run.plugin.name).slice(0, 60); el.appendChild(h);
  const x = document.createElement("button"); x.type = "button"; x.className = "plugin-x"; x.textContent = "×"; x.setAttribute("aria-label", "Close panel"); x.onclick = () => paintPanel(run, null); el.appendChild(x);
  for (const l of (Array.isArray(o.lines) ? o.lines : []).slice(0, 30)) { const p = document.createElement("div"); p.textContent = String(l).slice(0, 300); el.appendChild(p); }
  if (typeof o.progress === "number" && isFinite(o.progress)) { const b = document.createElement("div"); b.className = "up-bar"; b.innerHTML = "<i></i>"; b.firstChild.style.width = Math.round(Math.max(0, Math.min(1, o.progress)) * 100) + "%"; el.appendChild(b); }
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
setInterval(() => { attachKeys(); for (const r of runs.values()) if (r.buttons.size) injectButtons(r); }, 1500);      // pages are replaced when you move around: put the buttons back

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


// ---------------------------------------------------------------- more host helpers (site 1.48.0)
const clampN = (n, a, b, d) => { n = Number(n); return isFinite(n) ? Math.max(a, Math.min(b, n)) : d; };
const msgWin = () => { const f = document.getElementById("detailFrame"); try { return f && f.contentWindow && f.contentWindow.__qmMsgs ? f.contentWindow : null; } catch (_) { return null; } };
const needChat = () => { const w = msgWin(); if (!w || !w.__qmComposer) throw new Error("No chat is open."); return w; };
const isDark = () => { const t = document.documentElement.dataset.theme; return t ? t === "dark" : !!(window.matchMedia && matchMedia("(prefers-color-scheme: dark)").matches); };
const asText = m => (m.text == null ? "" : String(m.text));
function msgFilter(list, o) {
  o = o || {}; const needle = o.text ? String(o.text).toLowerCase() : "";
  let re = null; if (o.regex) { try { re = new RegExp(String(o.regex).slice(0, 100), "i"); } catch (_) { throw new Error("Not a valid regular expression."); } }
  return list.filter(m => (o.fromMe === undefined || m.fromMe === !!o.fromMe) && (!o.type || m.type === o.type) && (!needle || asText(m).toLowerCase().includes(needle)) && (!re || re.test(asText(m))));
}
// keyboard shortcuts (permission "keys")
const RESERVED_KEYS = new Set(["ctrl+c", "ctrl+v", "ctrl+x", "ctrl+a", "ctrl+z", "ctrl+y", "ctrl+r", "ctrl+w", "ctrl+t", "ctrl+n", "ctrl+l", "ctrl+f", "ctrl+p", "ctrl+s", "meta+c", "meta+v", "meta+x", "meta+a", "meta+z", "meta+r", "meta+w", "meta+t", "meta+q", "alt+f4"]);
function comboOf(e) {
  const k = e.key === " " ? "space" : String(e.key || "").toLowerCase();
  if (["control", "shift", "alt", "meta"].includes(k)) return "";
  return [e.ctrlKey && "ctrl", e.altKey && "alt", e.shiftKey && "shift", e.metaKey && "meta", k].filter(Boolean).join("+");
}
function cleanCombo(c) {
  const parts = String(c || "").toLowerCase().replace(/\s+/g, "").split("+").filter(Boolean);
  if (!parts.length) throw new Error("Give a key combination such as ctrl+shift+k.");
  const key = parts.pop(), mods = ["ctrl", "alt", "shift", "meta"].filter(m => parts.includes(m));
  if (parts.some(m => !["ctrl", "alt", "shift", "meta"].includes(m))) throw new Error("Unknown modifier in the key combination (use ctrl, alt, shift, meta).");
  if (!/^([a-z0-9]|f([1-9]|1[0-2])|space|escape|enter|tab|arrowup|arrowdown|arrowleft|arrowright|[,./;'\[\]\\=`-])$/.test(key)) throw new Error("Unknown key “" + key.slice(0, 12) + "”.");
  if (!mods.some(m => m === "ctrl" || m === "alt" || m === "meta") && !/^f([1-9]|1[0-2])$/.test(key)) throw new Error("A shortcut needs ctrl, alt or meta (or be an F key), so typing keeps working.");
  const out = [...mods, key].join("+");
  if (RESERVED_KEYS.has(out)) throw new Error("That combination belongs to the browser (" + out + ").");
  return out;
}
const keyDocs = new WeakSet();
function onKey(e) {
  const c = comboOf(e); if (!c) return;
  for (const r of runs.values()) for (const k of r.keys.values()) if (k.combo === c) { e.preventDefault(); e.stopPropagation(); send(r, "key", { id: k.id, combo: c }); return; }
}
function attachKeys() {
  for (const d of [document, ...frames().map(f => f.contentDocument)]) { if (!d || keyDocs.has(d)) continue; keyDocs.add(d); d.addEventListener("keydown", onKey, true); }
}
// slash commands (permission "commands"): the chat page asks here before it sends text that starts with "/"
function runCommand(text, chatId) {
  const m = /^\/([a-z][a-z0-9_-]{0,23})(?:\s+([\s\S]*))?$/i.exec(String(text || "").trim()); if (!m) return false;
  const name = m[1].toLowerCase();
  for (const r of runs.values()) if (r.commands.has(name)) { send(r, "command", { name, args: (m[2] || "").trim(), chatId: chatId || ctx.chatId || null }); return true; }
  return false;
}
// a banner across the top (permission "panel")
function paintBanner(run, o) {
  if (!o) { run.bannerEl?.remove(); run.bannerEl = null; return; }
  let el = run.bannerEl;
  if (!el) { el = document.createElement("div"); el.className = "plugin-banner"; document.body.appendChild(el); run.bannerEl = el; }
  el.className = "plugin-banner " + (["info", "success", "error"].includes(o.kind) ? o.kind : "info");
  el.replaceChildren();
  const t = document.createElement("span"); t.textContent = String(o.text || "").slice(0, 200); el.appendChild(t);
  for (const b of (Array.isArray(o.buttons) ? o.buttons : []).slice(0, 3)) { const bt = document.createElement("button"); bt.type = "button"; bt.className = "btn small"; bt.textContent = String(b).slice(0, 30); bt.onclick = () => send(run, "banner-button", { label: String(b) }); el.appendChild(bt); }
  const x = document.createElement("button"); x.type = "button"; x.className = "plugin-x"; x.textContent = "×"; x.setAttribute("aria-label", "Close"); x.onclick = () => paintBanner(run, null); el.appendChild(x);
}
const CSS_VAR = /^--[\w-]{1,40}$/, CSS_VAL = /^[^;{}<>\\]{1,100}$/;
function restoreHidden(run) { for (const [el, prev] of run.hidden) { try { el.style.display = prev; } catch (_) { /* gone */ } } run.hidden.clear(); }
// the page-level helpers share these
async function waitForEl(run, sel, o) {
  o = o || {}; const until = Date.now() + clampN(o.timeout, 100, 30000, 5000);
  while (!run.dead) {
    let list = []; try { list = queryPage(sel, { ...o, limit: 200 }); } catch (e) { if (/not open/.test(e.message)) list = []; else throw e; }
    const hit = list[Number(o.index) || 0];
    if (hit) return describe(hit.el, hit.i);
    if (Date.now() > until) return null;
    await sleep(120);
  }
  return null;
}

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
  // ---- more of everything (site 1.48.0) ----
  "app.info": run => ({ site: SITE_VERSION, api: API_VERSION, platform: window.QMApp ? "android" : window.__qmIosApp ? "ios" : "web", online: navigator.onLine, dark: isDark(), language: navigator.language || "", ...(run.plugin.permissions.includes("chat") ? { chatId: ctx.chatId } : {}) }),
  "plugins.list": () => [...runs.values()].map(r => ({ id: r.plugin.id, name: r.plugin.name, version: r.plugin.version, state: r.state })),
  "bus.emit": (run, [topic, data]) => {
    topic = String(topic || "").slice(0, 60); if (!topic) throw new Error("Give a topic.");
    const s = JSON.stringify(data ?? null); if (s.length > 20000) throw new Error("That message is too big (20 KB at most).");
    let n = 0; for (const r of runs.values()) if (r !== run) { send(r, "bus", { topic, data: JSON.parse(s), from: run.plugin.name }); n++; }
    return n;
  },
  "storage.keys": run => Object.keys(readStore(run.plugin.id)),
  "storage.clear": run => { writeStore(run.plugin.id, {}); },
  "storage.usage": run => ({ bytes: JSON.stringify(readStore(run.plugin.id)).length, limit: 100000 }),
  // chat (permission "chat"; sending needs "send")
  "chat.getText": run => { need(run, "chat"); return needChat().__qmComposer.get(); },
  "chat.setText": (run, [t]) => { need(run, "chat"); needChat().__qmComposer.set(String(t ?? "").slice(0, 4000)); },
  "chat.focus": run => { need(run, "chat"); needChat().__qmComposer.focus(); },
  "chat.list": run => {
    need(run, "chat"); const withPreview = run.plugin.permissions.includes("messages");
    return [...document.querySelectorAll(".chat-item")].slice(0, 100).map(a => ({ id: a.dataset.chat || null, title: (a.querySelector(".chat-title")?.textContent || "").trim().slice(0, 100), unread: a.classList.contains("unread"), ...(withPreview ? { preview: (a.querySelector(".chat-preview")?.textContent || "").trim().slice(0, 160) } : {}) }));
  },
  "chat.info": run => {
    need(run, "chat"); if (!ctx.chatId) return null;
    const a = [...document.querySelectorAll(".chat-item")].find(x => x.dataset.chat === ctx.chatId);
    return { chatId: ctx.chatId, title: a ? (a.querySelector(".chat-title")?.textContent || "").trim().slice(0, 100) : "" };
  },
  "chat.send": (run, [t, o]) => {
    need(run, "send"); const w = needChat(), text = String(t ?? "").trim().slice(0, 4000); if (!text) throw new Error("Nothing to send.");
    const now = Date.now(); run.sent = (run.sent || []).filter(x => now - x < 10000);
    if (run.sent.length >= 5) throw new Error("Slow down: a plugin can send 5 messages per 10 seconds.");
    run.sent.push(now);
    const ok = w.__qmComposer.send(text, o && o.replyTo ? String(o.replyTo) : null);
    if (ok) localToast(`${run.plugin.name} sent a message`, "info", 1500);
    return !!ok;
  },
  // messages (permission "messages")
  "messages.list": (run, [o]) => { need(run, "messages"); const w = msgWin(); if (!w) throw new Error("No chat is open."); o = o || {}; return msgFilter(w.__qmMsgs(), o).slice(-clampN(o.limit, 1, 300, 50)); },
  "messages.find": (run, [o]) => { need(run, "messages"); const w = msgWin(); if (!w) throw new Error("No chat is open."); o = o || {}; if (!o.text && !o.regex && !o.type && o.fromMe === undefined) throw new Error("Give text, regex, type or fromMe to look for."); return msgFilter(w.__qmMsgs(), o).slice(-clampN(o.limit, 1, 300, 20)); },
  "messages.get": (run, [k]) => { need(run, "messages"); const w = msgWin(); if (!w) throw new Error("No chat is open."); return w.__qmMsgs().find(m => m.key === String(k)) || null; },
  "messages.jump": (run, [k]) => { need(run, "messages"); const d = targetDoc("detail"), el = d && d.getElementById("msg-" + String(k).replace(/[^\w-]/g, "")); if (!el) return false; flash(el); return true; },
  "messages.reply": (run, [k, t]) => api["chat.send"](run, [t, { replyTo: k }]),
  // clipboard, notifications, vibration
  "clipboard.write": async (run, [t]) => { need(run, "clipboard"); try { await navigator.clipboard.writeText(String(t ?? "").slice(0, 20000)); return true; } catch (_) { throw new Error("The browser did not allow clipboard access right now."); } },
  notify: (run, [t, b]) => {
    need(run, "notify"); const title = `${run.plugin.name}: ${String(t ?? "").slice(0, 80)}`, body = String(b ?? "").slice(0, 200);
    if (document.hidden && typeof Notification !== "undefined" && Notification.permission === "granted") { try { new Notification(title, { body }); return "system"; } catch (_) { /* fall through */ } }
    localToast(body ? `${title} - ${body}` : title, "info", 5000); return "toast";
  },
  vibrate: (run, [p]) => { need(run, "notify"); const pat = (Array.isArray(p) ? p : [p]).slice(0, 8).map(n => clampN(n, 0, 2000, 0)); try { return !!(navigator.vibrate && navigator.vibrate(pat)); } catch (_) { return false; } },
  // keyboard shortcuts
  "keys.add": (run, [o]) => {
    need(run, "keys"); o = o || {}; const id = String(o.id || "").slice(0, 40); if (!/^[\w.-]{1,40}$/.test(id)) throw new Error("A shortcut needs an id (letters, numbers, - _ .).");
    if (run.keys.size >= 10 && !run.keys.has(id)) throw new Error("A plugin can add up to 10 shortcuts.");
    const combo = cleanCombo(o.combo);
    for (const r of runs.values()) for (const k of r.keys.values()) if (k.combo === combo && !(r === run && k.id === id)) throw new Error(combo + " is already used by " + (r === run ? "another shortcut of this plugin" : "the plugin “" + r.plugin.name + "”") + ".");
    run.keys.set(id, { id, combo, label: String(o.label || "").slice(0, 60) }); attachKeys(); return combo;
  },
  "keys.remove": (run, [id]) => { need(run, "keys"); run.keys.delete(String(id)); },
  "keys.clear": run => { need(run, "keys"); run.keys.clear(); },
  "keys.list": run => { need(run, "keys"); return [...run.keys.values()]; },
  // slash commands
  "commands.add": (run, [o]) => {
    need(run, "commands"); o = o || {}; const name = String(o.name || "").toLowerCase().replace(/^\//, "");
    if (!/^[a-z][a-z0-9_-]{0,23}$/.test(name)) throw new Error("A command name is letters, numbers, - and _ (24 at most), starting with a letter.");
    if (run.commands.size >= 10 && !run.commands.has(name)) throw new Error("A plugin can add up to 10 commands.");
    for (const r of runs.values()) if (r !== run && r.commands.has(name)) throw new Error("/" + name + " is already used by the plugin “" + r.plugin.name + "”.");
    run.commands.set(name, { name, description: String(o.description || "").slice(0, 100) }); return name;
  },
  "commands.remove": (run, [n]) => { need(run, "commands"); run.commands.delete(String(n).toLowerCase().replace(/^\//, "")); },
  "commands.clear": run => { need(run, "commands"); run.commands.clear(); },
  "commands.list": run => { need(run, "commands"); return [...run.commands.values()]; },
  // banner (permission "panel")
  "banner.show": (run, [o]) => { need(run, "panel"); paintBanner(run, o || {}); },
  "banner.hide": run => { need(run, "panel"); paintBanner(run, null); },
  // styles (permission "style")
  "style.vars": (run, [o]) => {
    need(run, "style"); o = o || {}; const next = {};
    for (const [k, v] of Object.entries(o).slice(0, 40)) { if (!CSS_VAR.test(k)) throw new Error("A CSS variable name looks like --accent."); if (v === null) continue; if (!CSS_VAL.test(String(v))) throw new Error("That value for " + k + " is not allowed."); next[k] = String(v); }
    run.vars = next; applyStyle(run);
  },
  "style.get": run => { need(run, "style"); return { css: run.css, vars: { ...run.vars }, sheets: [...run.sheets.keys()] }; },
  "style.sheet": (run, [id, css]) => {
    need(run, "style"); id = String(id || "").slice(0, 40); if (!/^[\w.-]{1,40}$/.test(id)) throw new Error("A stylesheet needs an id (letters, numbers, - _ .).");
    if (run.sheets.size >= 10 && !run.sheets.has(id)) throw new Error("A plugin can have up to 10 stylesheets.");
    run.sheets.set(id, String(css ?? "").slice(0, 50000)); applyStyle(run);
  },
  "style.removeSheet": (run, [id]) => { need(run, "style"); run.sheets.delete(String(id)); applyStyle(run); },
  // page control (permission "page")
  "page.waitFor": (run, [sel, o]) => { need(run, "page"); return waitForEl(run, sel, o); },
  "page.text": (run, [sel, o]) => { need(run, "page"); const e = pick(sel, o); return (e.innerText || e.textContent || "").trim().slice(0, 5000); },
  "page.attr": (run, [sel, name, o]) => { need(run, "page"); const e = pick(sel, o), n = String(name || ""); if (!/^[a-z][\w:-]{0,40}$/i.test(n)) throw new Error("Not an attribute name."); if (/^on/i.test(n)) throw new Error("Event attributes are not readable."); if (n === "value" && e.type === "password") return null; return e.getAttribute(n); },
  "page.count": (run, [sel, o]) => { need(run, "page"); return queryPage(sel, { ...(o || {}), limit: 200 }).length; },
  "page.focus": (run, [sel, o]) => { need(run, "page"); pick(sel, o).focus(); return true; },
  "page.press": (run, [key, sel, o]) => {
    need(run, "page"); key = String(key || ""); if (!/^[\w -]{1,20}$/.test(key) && !["Enter", "Escape", "Tab", "Backspace", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(key)) throw new Error("Unknown key.");
    const doc = targetDoc((o || {}).frame), e = sel ? pick(sel, o) : (doc && doc.activeElement) || (doc && doc.body); if (!e) throw new Error("That part of the page is not open.");
    const init = { key, bubbles: true, cancelable: true, shiftKey: !!(o || {}).shift, ctrlKey: !!(o || {}).ctrl, altKey: !!(o || {}).alt };
    const W = e.ownerDocument.defaultView; e.dispatchEvent(new W.KeyboardEvent("keydown", init)); e.dispatchEvent(new W.KeyboardEvent("keyup", init)); return true;
  },
  "page.select": (run, [sel, v, o]) => { need(run, "page"); const e = pick(sel, o); if (e.tagName !== "SELECT") throw new Error("That element is not a drop-down list."); e.value = String(v); e.dispatchEvent(new Event("input", { bubbles: true })); e.dispatchEvent(new Event("change", { bubbles: true })); return e.value === String(v); },
  "page.check": (run, [sel, v, o]) => { need(run, "page"); const e = pick(sel, o); if (!(e.tagName === "INPUT" && /^(checkbox|radio)$/.test(e.type))) throw new Error("That element is not a checkbox."); if (e.checked !== !!v) e.click(); return e.checked; },
  "page.hide": (run, [sel, o]) => { need(run, "page"); const list = queryPage(sel, { ...(o || {}), limit: 200 }); for (const { el } of list) { if (!run.hidden.has(el)) run.hidden.set(el, el.style.display); el.style.display = "none"; } return list.length; },
  "page.show": (run, [sel, o]) => { need(run, "page"); const list = queryPage(sel, { ...(o || {}), limit: 200 }); let n = 0; for (const { el } of list) if (run.hidden.has(el)) { el.style.display = run.hidden.get(el); run.hidden.delete(el); n++; } return n; },
  "page.title": (run, [t]) => { need(run, "page"); if (t === undefined || t === null) return document.title; if (run.origTitle == null) run.origTitle = document.title; document.title = String(t).slice(0, 120); return document.title; },
  ready: run => { run.state = "running"; },
  crash: (run, [e]) => { run.state = "crashed"; run.error = String(e).slice(0, 600); api.log(run, ["crashed: " + run.error]); localToast(`Plugin “${run.plugin.name}” crashed: ${run.error.split("\n")[0]}`, "error", 6000); }
};

function send(run, event, data) { try { run.frame.contentWindow.postMessage({ qm: 1, event, data }, "*"); } catch (_) { /* frame gone */ } }
const PERM_OF = { message: "messages", "chat-open": "chat", "chat-close": "chat", button: "buttons", "call-state": "calls", "dev-view": "devinfo", "page-load": "page", key: "keys", command: "commands", "banner-button": "panel" };
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
  runs.set(p.id, { frame, plugin: p, sig: pluginSig(p), state: "starting", error: "", logs: [], css: "", vars: {}, sheets: new Map(), panelEl: null, bannerEl: null, buttons: new Map(), cards: new Map(), keys: new Map(), commands: new Map(), hidden: new Map(), origTitle: null, sent: [], dead: false, search: null });
  document.body.appendChild(frame);
}
const pluginSig = p => JSON.stringify([p.code, p.permissions, p.name, p.version]);
/** Stops a plugin and takes back everything it put on the screen. */
export function stopPlugin(id) {
  const r = runs.get(id); if (!r) return;
  r.dead = true; r.css = ""; r.vars = {}; r.sheets.clear(); applyStyle(r); paintPanel(r, null); paintBanner(r, null); restoreHidden(r);
  if (r.origTitle != null) document.title = r.origTitle;
  if (r.search) r.search.stop = true; pill(null);
  r.buttons.clear(); r.keys.clear(); r.commands.clear(); r.cards.clear(); injectButtons(r); r.frame.remove(); runs.delete(id);
}
export const stopAll = () => [...runs.keys()].forEach(stopPlugin);
/** Makes what is running match what is saved: plugins that were switched off, deleted or blocked are stopped, changed ones restart, new ones start,
 *  and unchanged ones are left alone. (This used to only start plugins, so switching one off did nothing until Developer mode was toggled.) */
export function startAll() {
  if (!devOn()) { stopAll(); return; }
  const list = loadPlugins();
  const want = new Map(list.filter(p => p.enabled && !isBlocked(p) && p.code.length <= MAX_CODE).map(p => [p.id, p]));
  for (const id of [...runs.keys()]) if (!want.has(id)) stopPlugin(id);
  const started = [];
  for (const p of want.values()) { const r = runs.get(p.id); if (r && r.sig === pluginSig(p)) { r.plugin = p; continue; } startPlugin(p); started.push(p); }
  for (const p of started.filter(p => pluginIssues(p).length)) { const i = pluginIssues(p)[0]; localToast(`Plugin “${p.name}”: ${i.text}`, i.level === "error" ? "error" : "info", 8000); }
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

// events that need no permission
addEventListener("online", () => emit("online", {})); addEventListener("offline", () => emit("offline", {}));
document.addEventListener("visibilitychange", () => emit("visibility", { visible: !document.hidden }));
try { new MutationObserver(() => emit("theme-change", { dark: isDark() })).observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] }); } catch (_) { /* ignore */ }
onDev(on => { if (on) startAll(); else stopAll(); });
addEventListener("storage", e => { if (e.key === "qm-plugins" && devOn()) startAll(); });
if (devOn()) setTimeout(startAll, 800);
export const plugins = { emit, setContext, startPlugin, stopPlugin, startAll, stopAll, status, devCards, devView, command: runCommand };
