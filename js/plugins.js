// Plugin host (runs in the app shell, only while Developer mode is on).
// Every enabled plugin runs inside its own sandboxed <iframe> (no access to this page, your account, cookies or storage) and talks to the
// site only through the messages handled here. Each call is checked against the permissions the plugin declared. Docs: plugin-docs.html
import { devOn, onDev, envInfo } from "./dev.js";
import { loadPlugins, pluginIssues, isBlocked, unreviewed, MAX_CODE } from "./plugin-store.js";
import { SITE_VERSION, API_VERSION } from "./version.js";
import { localToast, promptDialog, confirmDialog } from "./ui.js";

const runs = new Map();                 // plugin id -> { frame, plugin, handlers, panelEl, styles }
let ctx = { uid: null, name: "", chatId: null, call: null };
const store = id => "qm-pstore-" + id;
const readStore = id => { try { return JSON.parse(localStorage.getItem(store(id)) || "{}"); } catch (_) { return {}; } };
const writeStore = (id, o) => { const s = JSON.stringify(o); if (s.length > 100000) throw new Error("Plugin storage is full (100 KB)."); localStorage.setItem(store(id), s); };

// What a plugin's sandbox runs first. It is the only code that exists in the frame besides the plugin's own.
function boot(code, p) {
  const unsafe = p.permissions.includes("unsandboxed");
  const csp = `default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval'; img-src data:; style-src 'unsafe-inline'; connect-src ${p.permissions.includes("network") ? "https:" : "'none'"}`;
  const bootJs = `
const PID=${JSON.stringify(p.id)}, SITE=${JSON.stringify(SITE_VERSION)}, API=${API_VERSION};
const pending=new Map(); let seq=0; const handlers={};
const call=(m,a)=>new Promise((res,rej)=>{const id=++seq;pending.set(id,{res,rej});parent.postMessage({qm:1,id,m,a:a||[]},"*");});
addEventListener("message",e=>{ if(e.source!==parent)return; const d=e.data; if(!d||d.qm!==1)return;
  if(d.reply){const w=pending.get(d.id); if(!w)return; pending.delete(d.id); d.error?w.rej(new Error(d.error)):w.res(d.result);}
  else if(d.event){(handlers[d.event]||[]).slice().forEach(f=>{try{const r=f(d.data); if(r&&r.catch)r.catch(x=>call("log",["error in "+d.event+": "+x]));}catch(x){call("log",["error in "+d.event+": "+x]);}});}
});
const PERMS=${JSON.stringify(p.permissions)};
const qm={ version:SITE, apiVersion:API,
  permissions:{list:()=>PERMS.slice(),has:k=>PERMS.includes(k),sandboxed:${unsafe ? "false" : "true"}},
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
  banner:{show:o=>call("banner.show",[o]),hide:o=>call("banner.hide",[o]),clear:()=>call("banner.clear")},
  ui:{open:o=>call("ui.open",[o]),update:(id,o)=>call("ui.update",[id,o]),close:id=>call("ui.close",[id]),list:()=>call("ui.list"),confirm:o=>call("ui.confirm",[o]),prompt:o=>call("ui.prompt",[o])},
  speech:{say:(t,o)=>call("speech.say",[t,o]),stop:()=>call("speech.stop")},
  sound:{play:(k)=>call("sound.play",[k])},
  badge:{set:n=>call("badge.set",[n]),clear:()=>call("badge.set",[0])},
  share:t=>call("share.text",[t]),
  download:{save:(name,data,type)=>call("download.save",[name,data,type])},
  files:{pick:o=>call("files.pick",[o])},
  links:{open:u=>call("links.open",[u])},
  messageMenu:{add:o=>call("menu.add",[o]),remove:id=>call("menu.remove",[id]),clear:()=>call("menu.clear"),list:()=>call("menu.list")}
});
Object.assign(qm.chat,{getText:()=>call("chat.getText"),setText:t=>call("chat.setText",[t]),clearText:()=>call("chat.setText",[""]),focus:()=>call("chat.focus"),list:()=>call("chat.list"),info:()=>call("chat.info"),send:(t,o)=>call("chat.send",[t,o])});
Object.assign(qm.style,{vars:o=>call("style.vars",[o]),get:()=>call("style.get"),sheet:(id,css)=>call("style.sheet",[id,css]),removeSheet:id=>call("style.removeSheet",[id])});
Object.assign(qm.storage,{keys:()=>call("storage.keys"),clear:()=>call("storage.clear"),usage:()=>call("storage.usage")});
Object.assign(qm.page,{waitFor:(s,o)=>call("page.waitFor",[s,o]),text:(s,o)=>call("page.text",[s,o]),attr:(s,n,o)=>call("page.attr",[s,n,o]),count:(s,o)=>call("page.count",[s,o]),
  focus:(s,o)=>call("page.focus",[s,o]),press:(k,s,o)=>call("page.press",[k,s,o]),select:(s,v,o)=>call("page.select",[s,v,o]),check:(s,v,o)=>call("page.check",[s,v,o]),
  hide:(s,o)=>call("page.hide",[s,o]),show:(s,o)=>call("page.show",[s,o]),title:t=>call("page.title",[t])});
${unsafe ? 'qm.unsafe={window:parent,document:parent.document,note:"UNSANDBOXED: this plugin has the same powers as the site itself."};' : ''}
const AsyncFunction=Object.getPrototypeOf(async function(){}).constructor;
(async()=>{ try{ await new AsyncFunction("qm",${JSON.stringify(code)})(qm); call("ready"); }catch(e){ call("crash",[String(e&&e.stack||e)]); } })();`;
  return `<!doctype html><meta charset="utf-8">${unsafe ? "" : `<meta http-equiv="Content-Security-Policy" content="${csp}">`}<script>${bootJs.replace(/<\/script/gi, "<\\/script")}<\/script>`;
}

let baseTitle = null;
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

// ---------------------------------------------------------------- plugin windows (qm.ui) and the old panel
// A window is a themed dialog (a sheet on phones) that is drawn from "blocks" the plugin describes. The plugin never gets
// to put its own HTML on the page: it only picks block types, and the host draws them with the site's own colours.
const BLOCK_TYPES = ["text", "heading", "kv", "button", "buttons", "input", "toggle", "select", "progress", "list", "image", "divider", "badge"];
const el$ = (tag, cls, txt) => { const e = document.createElement(tag); if (cls) e.className = cls; if (txt != null) e.textContent = String(txt); return e; };
const safeSrc = u => /^(https:\/\/|data:image\/(png|jpe?g|gif|webp);base64,)/i.test(String(u)) ? String(u) : "";
function winValues(w) { return { ...w.values }; }
function renderBlocks(run, w, root, blocks) {
  const act = (id, value) => w.id === "panel" && String(id).startsWith("panel:") ? send(run, "panel-button", { label: String(id).slice(6) }) : send(run, "ui-action", { window: w.id, id: String(id), value: value === undefined ? null : value, values: winValues(w) });
  for (const b of (Array.isArray(blocks) ? blocks : []).slice(0, 80)) {
    if (!b || typeof b !== "object" || !BLOCK_TYPES.includes(b.type)) continue;
    const id = String(b.id || "").slice(0, 60);
    if (b.type === "text") root.appendChild(el$("p", "pw-text" + (b.muted ? " muted" : "") + (b.bold ? " bold" : ""), String(b.text || "").slice(0, 2000)));
    else if (b.type === "heading") root.appendChild(el$("h3", "pw-heading", String(b.text || "").slice(0, 120)));
    else if (b.type === "badge") root.appendChild(el$("span", "pw-badge " + (["success", "error", "warn"].includes(b.kind) ? b.kind : ""), String(b.text || "").slice(0, 40)));
    else if (b.type === "divider") root.appendChild(el$("hr", "pw-hr"));
    else if (b.type === "kv") {
      const d = el$("dl", "pw-kv");
      for (const r of (Array.isArray(b.rows) ? b.rows : []).slice(0, 40)) { if (!Array.isArray(r)) continue; d.appendChild(el$("dt", "", String(r[0]).slice(0, 60))); d.appendChild(el$("dd", "", String(r[1]).slice(0, 200))); }
      root.appendChild(d);
    } else if (b.type === "progress") {
      const bar = el$("div", "up-bar"); const i = document.createElement("i"); const v = Number(b.value); i.style.width = Math.round(Math.max(0, Math.min(1, isFinite(v) ? v : 0)) * 100) + "%"; bar.appendChild(i);
      if (b.label) root.appendChild(el$("div", "pw-label", String(b.label).slice(0, 100))); root.appendChild(bar);
    } else if (b.type === "image") {
      const src = safeSrc(b.src); if (!src) continue; const im = document.createElement("img"); im.className = "pw-img"; im.src = src; im.alt = String(b.alt || "").slice(0, 100); im.loading = "lazy"; root.appendChild(im);
    } else if (b.type === "button") {
      const bt = el$("button", "btn" + (b.kind === "primary" ? " primary" : "") + (b.kind === "danger" ? " danger" : "") + " pw-btn", String(b.label || id || "OK").slice(0, 40)); bt.type = "button";
      bt.onclick = () => act(id || b.label); root.appendChild(bt);
    } else if (b.type === "buttons") {
      const row = el$("div", "pw-row");
      for (const x of (Array.isArray(b.items) ? b.items : []).slice(0, 8)) {
        const o = typeof x === "object" && x ? x : { label: x, id: x };
        const bt = el$("button", "btn small" + (o.kind === "primary" ? " primary" : "") + (o.kind === "danger" ? " danger" : ""), String(o.label || o.id || "").slice(0, 30)); bt.type = "button";
        bt.onclick = () => act(o.id || o.label); row.appendChild(bt);
      }
      root.appendChild(row);
    } else if (b.type === "input") {
      const lab = el$("label", "pw-field"); if (b.label) lab.appendChild(el$("span", "pw-label", String(b.label).slice(0, 80)));
      const inp = document.createElement(b.multiline ? "textarea" : "input"); if (!b.multiline) inp.type = b.password ? "password" : "text"; else inp.rows = 3;
      inp.value = id in w.values ? w.values[id] : String(b.value ?? "").slice(0, 2000); inp.placeholder = String(b.placeholder || "").slice(0, 80); inp.maxLength = 2000;
      if (id) { w.values[id] = inp.value; inp.oninput = () => { w.values[id] = inp.value; }; inp.onchange = () => { if (b.live) act(id, inp.value); }; }
      inp.onkeydown = e => { if (e.key === "Enter" && !b.multiline && b.submit) { e.preventDefault(); act(b.submit, inp.value); } };
      lab.appendChild(inp); root.appendChild(lab);
    } else if (b.type === "toggle") {
      const lab = el$("label", "pw-toggle"); const cb = document.createElement("input"); cb.type = "checkbox"; cb.checked = id in w.values ? !!w.values[id] : !!b.value;
      if (id) { w.values[id] = cb.checked; cb.onchange = () => { w.values[id] = cb.checked; if (b.live) act(id, cb.checked); }; }
      lab.appendChild(cb); lab.appendChild(el$("span", "", String(b.label || "").slice(0, 100))); root.appendChild(lab);
    } else if (b.type === "select") {
      const lab = el$("label", "pw-field"); if (b.label) lab.appendChild(el$("span", "pw-label", String(b.label).slice(0, 80)));
      const sel = document.createElement("select");
      for (const o of (Array.isArray(b.options) ? b.options : []).slice(0, 40)) { const v = typeof o === "object" && o ? o : { value: o, label: o }; const op = document.createElement("option"); op.value = String(v.value); op.textContent = String(v.label ?? v.value).slice(0, 60); sel.appendChild(op); }
      sel.value = id in w.values ? w.values[id] : String(b.value ?? sel.value); if (id) { w.values[id] = sel.value; sel.onchange = () => { w.values[id] = sel.value; if (b.live) act(id, sel.value); }; }
      lab.appendChild(sel); root.appendChild(lab);
    } else if (b.type === "list") {
      const ul = el$("div", "pw-list");
      for (const it of (Array.isArray(b.items) ? b.items : []).slice(0, 100)) {
        const o = typeof it === "object" && it ? it : { title: it };
        const row = el$(o.id != null ? "button" : "div", "pw-item"); if (o.id != null) { row.type = "button"; row.onclick = () => act(o.id, o.title); }
        row.appendChild(el$("span", "pw-item-t", String(o.title ?? "").slice(0, 120))); if (o.sub) row.appendChild(el$("span", "pw-item-s", String(o.sub).slice(0, 160)));
        ul.appendChild(row);
      }
      if (!ul.children.length && b.empty) ul.appendChild(el$("div", "pw-text muted", String(b.empty).slice(0, 100)));
      root.appendChild(ul);
    }
  }
}
function paintWindow(run, w) {
  const o = w.o;
  if (!w.el) {
    const back = el$("div", "pw-backdrop"); const box = el$("section", "pw"); box.setAttribute("role", "dialog"); box.setAttribute("aria-modal", "true");
    back.appendChild(box); document.body.appendChild(back); w.el = back; w.box = box;
    back.addEventListener("pointerdown", e => { if (e.target === back && o.dismiss !== false) closeWindow(run, w.id, "backdrop"); });
  }
  const box = w.box; box.className = "pw " + (["sm", "md", "lg"].includes(o.size) ? o.size : "md"); box.replaceChildren();
  const head = el$("header", "pw-head"); const t = el$("div", "pw-title"); t.appendChild(el$("strong", "", String(o.title || run.plugin.name).slice(0, 60))); t.appendChild(el$("span", "pw-by", run.plugin.name)); head.appendChild(t);
  if (o.dismiss !== false) { const x = el$("button", "pw-close", "×"); x.type = "button"; x.setAttribute("aria-label", "Close"); x.onclick = () => closeWindow(run, w.id, "button"); head.appendChild(x); }
  box.appendChild(head);
  const body = el$("div", "pw-body"); renderBlocks(run, w, body, o.blocks); box.appendChild(body);
}
function openWindow(run, o) {
  o = o || {}; const id = String(o.id || "main").slice(0, 40);
  let w = run.windows.get(id);
  if (w && o.reset) w.values = {};
  if (!w) { if (run.windows.size >= 4) throw new Error("Too many windows are open."); w = { id, o: {}, values: {}, el: null, box: null }; run.windows.set(id, w); }
  w.o = o; paintWindow(run, w); return id;
}
function closeWindow(run, id, why) { const w = run.windows.get(id); if (!w) return false; w.el?.remove(); run.windows.delete(id); if (why) send(run, "ui-close", { window: id, reason: why }); return true; }
function closeAllWindows(run) { for (const id of [...run.windows.keys()]) closeWindow(run, id, null); }
document.addEventListener("keydown", e => { if (e.key !== "Escape") return; for (const r of runs.values()) { const ids = [...r.windows.keys()].filter(i => r.windows.get(i).o.dismiss !== false); if (ids.length) { closeWindow(r, ids[ids.length - 1], "escape"); e.preventDefault(); return; } } });
/** The older qm.panel.set({title, lines, progress, buttons}) now opens a window too, so nothing floats in a corner any more. */
function paintPanel(run, o) {
  if (!o) { closeWindow(run, "panel", null); return; }
  const blocks = [];
  for (const l of (Array.isArray(o.lines) ? o.lines : []).slice(0, 30)) blocks.push({ type: "text", text: l });
  if (typeof o.progress === "number" && isFinite(o.progress)) blocks.push({ type: "progress", value: o.progress });
  const bs = (Array.isArray(o.buttons) ? o.buttons : []).slice(0, 8); if (bs.length) blocks.push({ type: "buttons", items: bs.map(x => ({ id: "panel:" + String(x), label: String(x) })) });
  const w0 = run.windows.get("panel"); if (w0) w0.values = {};
  openWindow(run, { id: "panel", title: o.title, blocks, size: "sm", dismiss: true });
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
setInterval(() => { attachKeys(); for (const r of runs.values()) { if (r.buttons.size) injectButtons(r); for (const [wh, bn] of r.banners) if (wh !== "app" && !bn.el.isConnected) { try { paintBanner(r, bn.o); } catch (_) { /* page gone */ } } } }, 1500);      // pages are replaced when you move around: put the buttons back

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
function bannerHost(where) {
  if (where === "call") { if (!ctx.call) return null; const d = targetDoc("call"); return d && d.body ? { doc: d, host: d.body } : null; }
  if (where === "chat") { const d = targetDoc("detail"); return d && d.body ? { doc: d, host: d.body } : null; }
  return { doc: document, host: document.body };
}
function paintBanner(run, o, whereArg) {
  const where = ["app", "call", "chat"].includes(o && o.where) ? o.where : (whereArg || "app");
  const cur = run.banners.get(where);
  if (!o) { cur && cur.el.remove(); run.banners.delete(where); if (where === "app") run.bannerEl = null; return; }
  const h = bannerHost(where); if (!h) throw new Error("That part of the page is not open.");
  const d = h.doc;
  let el = cur && cur.el;
  if (!el || el.ownerDocument !== d || !el.isConnected) { el = d.createElement("div"); h.host.appendChild(el); }
  el.className = "plugin-banner " + where + " " + (["info", "success", "error", "warn"].includes(o.kind) ? o.kind : "info"); el.setAttribute("role", "status");
  el.replaceChildren();
  const t = d.createElement("span"); t.className = "pb-text"; t.textContent = String(o.text || "").slice(0, 200); el.appendChild(t);
  for (const b of (Array.isArray(o.buttons) ? o.buttons : []).slice(0, 3)) { const bt = d.createElement("button"); bt.type = "button"; bt.className = "btn small"; bt.textContent = String(b).slice(0, 30); bt.onclick = () => send(run, "banner-button", { label: String(b), where }); el.appendChild(bt); }
  if (o.dismiss !== false) { const x = d.createElement("button"); x.type = "button"; x.className = "plugin-x"; x.textContent = "×"; x.setAttribute("aria-label", "Close"); x.onclick = () => paintBanner(run, null, where); el.appendChild(x); }
  run.banners.set(where, { el, o: { ...o, where } }); if (where === "app") run.bannerEl = el;
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
  // speech, sound, badge, share, download, files, links
  "speech.say": (run, [t, o]) => {
    need(run, "speech"); if (!window.speechSynthesis) throw new Error("This device cannot speak.");
    const u = new SpeechSynthesisUtterance(String(t ?? "").slice(0, 600)); o = o || {};
    u.rate = clampN(o.rate ?? 1, 0.5, 2, 1); u.pitch = clampN(o.pitch ?? 1, 0, 2, 1); if (o.lang) u.lang = String(o.lang).slice(0, 12);
    speechSynthesis.speak(u); return true;
  },
  "speech.stop": run => { need(run, "speech"); try { speechSynthesis.cancel(); } catch (_) { /* ignore */ } return true; },
  "sound.play": (run, [k]) => {
    need(run, "sound"); const AC = window.AudioContext || window.webkitAudioContext; if (!AC) throw new Error("This device cannot play sounds.");
    const seq = { beep: [[880, .12]], success: [[660, .1], [880, .14]], error: [[300, .2], [220, .25]], alert: [[880, .1], [660, .1], [880, .1]] }[String(k || "beep")] || [[880, .12]];
    const a = (run.audio = run.audio || new AC()); let t = a.currentTime;
    for (const [f, d] of seq) { const o = a.createOscillator(), g = a.createGain(); o.frequency.value = f; g.gain.value = .12; o.connect(g); g.connect(a.destination); o.start(t); o.stop(t + d); t += d + .04; }
    return true;
  },
  "badge.set": (run, [n]) => {
    need(run, "badge"); n = clampN(n, 0, 999, 0); run.badge = n;
    const total = [...runs.values()].reduce((m, r) => m + (r.badge || 0), 0);
    try { if (total && navigator.setAppBadge) navigator.setAppBadge(total); else if (navigator.clearAppBadge) navigator.clearAppBadge(); } catch (_) { /* ignore */ }
    if (baseTitle == null) baseTitle = document.title.replace(/^\(\d+\) /, "");
    document.title = total ? `(${total}) ${baseTitle}` : baseTitle; if (!total) baseTitle = null; return total;
  },
  "share.text": async (run, [t]) => {
    need(run, "share"); t = String(t ?? "").slice(0, 5000); if (!t) throw new Error("Nothing to share.");
    if (navigator.share) { try { await navigator.share({ text: t }); return "shared"; } catch (e) { if (e && e.name === "AbortError") return "cancelled"; } }
    try { await navigator.clipboard.writeText(t); localToast("Copied (sharing isn't available here).", "info", 2500); return "copied"; } catch (_) { throw new Error("The browser did not allow sharing right now."); }
  },
  "download.save": async (run, [name, data, type]) => {
    need(run, "download"); name = String(name || "file.txt").replace(/[^\w. -]+/g, "_").slice(0, 80) || "file.txt";
    const text = typeof data === "string" ? data : JSON.stringify(data ?? "", null, 2); if (text.length > 5_000_000) throw new Error("File too big (5 MB at most).");
    if (!await confirmDialog({ title: "Save a file?", message: `The plugin “${run.plugin.name}” wants to save “${name}” (${Math.ceil(text.length / 1024)} KB) to your device.`, okText: "Save" })) return false;
    const url = URL.createObjectURL(new Blob([text], { type: String(type || "text/plain").slice(0, 60) }));
    const a = Object.assign(document.createElement("a"), { href: url, download: name }); document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 5000); return true;
  },
  "files.pick": async (run, [o]) => {
    need(run, "files"); o = o || {};
    if (!await confirmDialog({ title: "Choose a file?", message: `The plugin “${run.plugin.name}” asks you to pick a file. It only receives the file you choose.`, okText: "Choose file" })) return null;
    const f = await new Promise(res => { const i = document.createElement("input"); i.type = "file"; if (o.accept) i.accept = String(o.accept).slice(0, 100); i.onchange = () => res(i.files[0] || null); i.oncancel = () => res(null); i.click(); });
    if (!f) return null; if (f.size > 2_000_000) throw new Error("That file is too big (2 MB at most).");
    const isText = /^text\/|json|xml|javascript/.test(f.type) || /\.(txt|md|csv|json|js|html|css|log)$/i.test(f.name);
    if (isText) return { name: f.name, size: f.size, type: f.type, text: await f.text() };
    const buf = new Uint8Array(await f.arrayBuffer()); let b = ""; for (let i = 0; i < buf.length; i += 8192) b += String.fromCharCode(...buf.subarray(i, i + 8192));
    return { name: f.name, size: f.size, type: f.type, base64: btoa(b) };
  },
  "links.open": async (run, [u]) => {
    need(run, "links"); let x; try { x = new URL(String(u)); } catch (_) { throw new Error("Not a web address."); }
    if (x.protocol !== "https:") throw new Error("Only https:// links can be opened.");
    if (!await confirmDialog({ title: "Open a link?", message: `The plugin “${run.plugin.name}” wants to open:\n${x.href}`, okText: "Open" })) return false;
    window.open(x.href, "_blank", "noopener,noreferrer"); return true;
  },
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
  "banner.hide": (run, [o]) => { need(run, "panel"); paintBanner(run, null, (o && o.where) || "app"); },
  "banner.clear": run => { need(run, "panel"); for (const k of [...run.banners.keys()]) paintBanner(run, null, k); },
  // windows drawn from blocks (permission "ui")
  "ui.open": (run, [o]) => { need(run, "ui"); return openWindow(run, o); },
  "ui.update": (run, [id, o]) => { need(run, "ui"); const w = run.windows.get(String(id)); if (!w) throw new Error("That window is not open."); w.o = { ...w.o, ...(o || {}) }; paintWindow(run, w); },
  "ui.close": (run, [id]) => { need(run, "ui"); return closeWindow(run, String(id || "main"), null); },
  "ui.list": run => { need(run, "ui"); return [...run.windows.keys()]; },
  "ui.confirm": async (run, [o]) => { need(run, "ui"); o = o || {}; return !!(await confirmDialog({ title: String(o.title || run.plugin.name).slice(0, 80), message: String(o.message || "").slice(0, 400), okText: String(o.ok || "OK").slice(0, 20), danger: !!o.danger })); },
  "ui.prompt": async (run, [o]) => { need(run, "ui"); o = o || {}; const v = await promptDialog({ title: String(o.title || run.plugin.name).slice(0, 80), message: String(o.message || "").slice(0, 400), input: { value: String(o.value || "").slice(0, 500), placeholder: String(o.placeholder || "").slice(0, 80) } }); return v == null || v === false ? null : String(v); },
  // extra choices in the message menu (permission "menu")
  "menu.add": (run, [o]) => {
    need(run, "menu"); o = o || {}; const id = String(o.id || "").slice(0, 40); if (!id) throw new Error("A menu item needs an id.");
    if (!run.menu.has(id) && run.menu.size >= 8) throw new Error("A plugin can add up to 8 message menu items.");
    run.menu.set(id, { id, label: String(o.label || id).slice(0, 30), icon: String(o.icon || "more").slice(0, 20), mine: o.mine === true ? true : o.mine === false ? false : null, textOnly: !!o.textOnly, danger: !!o.danger }); return true;
  },
  "menu.remove": (run, [id]) => { need(run, "menu"); run.menu.delete(String(id)); },
  "menu.clear": run => { need(run, "menu"); run.menu.clear(); },
  "menu.list": run => { need(run, "menu"); return [...run.menu.values()]; },
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
const PERM_OF = { message: "messages", "chat-open": "chat", "chat-close": "chat", button: "buttons", "call-state": "calls", "dev-view": "devinfo", "page-load": "page", key: "keys", command: "commands", "banner-button": "panel", "ui-action": "ui", "ui-close": "ui", "menu-click": "menu" };
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
  if (isBlocked(p) || !p.enabled || p.code.length > MAX_CODE || unreviewed(p).length) return;   // permissions must have been reviewed on the Plugins page
  const frame = document.createElement("iframe");
  // Normal plugins: no allow-same-origin, so they cannot reach the site, its cookies, storage or Firebase login.
  // The "unsandboxed" permission (extremely dangerous, the person had to confirm it by typing) removes that wall on purpose.
  frame.setAttribute("sandbox", p.permissions.includes("unsandboxed") ? "allow-scripts allow-same-origin allow-forms allow-popups allow-modals" : "allow-scripts");
  frame.setAttribute("aria-hidden", "true"); frame.tabIndex = -1; frame.title = "Plugin: " + p.name;
  frame.style.cssText = "position:fixed;width:0;height:0;border:0;opacity:0;pointer-events:none";
  frame.srcdoc = boot(p.code, p);
  runs.set(p.id, { frame, plugin: p, sig: pluginSig(p), state: "starting", error: "", logs: [], css: "", vars: {}, sheets: new Map(), panelEl: null, bannerEl: null, banners: new Map(), windows: new Map(), menu: new Map(), buttons: new Map(), cards: new Map(), keys: new Map(), commands: new Map(), hidden: new Map(), origTitle: null, sent: [], dead: false, search: null });
  document.body.appendChild(frame);
}
const pluginSig = p => JSON.stringify([p.code, p.permissions, p.name, p.version]);
/** Stops a plugin and takes back everything it put on the screen. */
export function stopPlugin(id) {
  const r = runs.get(id); if (!r) return;
  r.dead = true; r.css = ""; r.vars = {}; r.sheets.clear(); applyStyle(r); paintPanel(r, null); closeAllWindows(r); for (const k of [...r.banners.keys()]) paintBanner(r, null, k); r.menu.clear(); restoreHidden(r);
  if (r.origTitle != null) document.title = r.origTitle;
  if (r.badge) { r.badge = 0; api["badge.set"]({ ...r, plugin: { permissions: ["badge"] } }, [0]); }
  try { r.audio?.close(); } catch (_) { /* ignore */ }
  if (r.search) r.search.stop = true; pill(null);
  r.buttons.clear(); r.keys.clear(); r.commands.clear(); r.cards.clear(); injectButtons(r); r.frame.remove(); runs.delete(id);
}
export const stopAll = () => [...runs.keys()].forEach(stopPlugin);
/** Makes what is running match what is saved: plugins that were switched off, deleted or blocked are stopped, changed ones restart, new ones start,
 *  and unchanged ones are left alone. (This used to only start plugins, so switching one off did nothing until Developer mode was toggled.) */
export function startAll() {
  if (!devOn()) { stopAll(); return; }
  const list = loadPlugins();
  const want = new Map(list.filter(p => p.enabled && !isBlocked(p) && p.code.length <= MAX_CODE && !unreviewed(p).length).map(p => [p.id, p]));
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
/** Extra message-menu choices from plugins that hold the "menu" permission; message.js asks for these when the menu opens. */
function menuItems(m) {
  const out = [];
  for (const r of runs.values()) {
    if (r.dead || r.state === "error" || !r.plugin.permissions.includes("menu")) continue;
    for (const it of r.menu.values()) {
      if (it.mine !== null && it.mine !== !!m.fromMe) continue;
      if (it.textOnly && (m.text == null || m.type !== "text")) continue;
      out.push({ plugin: r.plugin.id, by: r.plugin.name, id: it.id, label: it.label, icon: it.icon, danger: it.danger });
    }
  }
  return out;
}
function menuClick(pluginId, id, m) { const r = runs.get(pluginId); if (r && !r.dead) send(r, "menu-click", { id: String(id), message: r.plugin.permissions.includes("messages") ? m : { ...m, text: null } }); }       // the text only goes to plugins that may read messages
export const plugins = { menuItems, menuClick, emit, setContext, startPlugin, stopPlugin, startAll, stopAll, status, devCards, devView, command: runCommand };
