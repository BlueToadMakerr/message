// Plugin host (runs in the app shell, only while Developer mode is on).
// Every enabled plugin runs inside its own sandboxed <iframe> (no access to this page, your account, cookies or storage) and talks to the
// site only through the messages handled here. Each call is checked against the permissions the plugin declared. Docs: plugin-docs.html
import { devOn, onDev } from "./dev.js";
import { loadPlugins, pluginIssues, isBlocked, MAX_CODE } from "./plugin-store.js";
import { SITE_VERSION, API_VERSION } from "./version.js";
import { localToast } from "./ui.js";

const runs = new Map();                 // plugin id -> { frame, plugin, handlers, panelEl, styles }
let ctx = { uid: null, name: "", chatId: null };
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
  chat:{current:()=>call("chat.current"),insertText:t=>call("chat.insertText",[t])},
  panel:{set:o=>call("panel.set",[o]),hide:()=>call("panel.hide")},
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
document.addEventListener("load", e => { if (e.target && e.target.tagName === "IFRAME") for (const r of runs.values()) if (r.css) setTimeout(() => applyStyle(r), 0); }, true);

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
  ready: run => { run.state = "running"; },
  crash: (run, [e]) => { run.state = "crashed"; run.error = String(e).slice(0, 600); api.log(run, ["crashed: " + run.error]); localToast(`Plugin “${run.plugin.name}” crashed: ${run.error.split("\n")[0]}`, "error", 6000); }
};

function send(run, event, data) { try { run.frame.contentWindow.postMessage({ qm: 1, event, data }, "*"); } catch (_) { /* frame gone */ } }
const wants = (run, event) => event === "message" ? run.plugin.permissions.includes("messages") : (event === "chat-open" || event === "chat-close") ? run.plugin.permissions.includes("chat") : true;

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
  runs.set(p.id, { frame, plugin: p, state: "starting", error: "", logs: [], css: "", panelEl: null });
  document.body.appendChild(frame);
}
export function stopPlugin(id) {
  const r = runs.get(id); if (!r) return;
  r.css = ""; applyStyle(r); paintPanel(r, null); r.frame.remove(); runs.delete(id);
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
  ctx = { ...ctx, ...c };
  if (chatChanged) { if (old) emit("chat-close", { chatId: old }); if (ctx.chatId) emit("chat-open", { chatId: ctx.chatId }); }
}

onDev(on => { if (on) startAll(); else stopAll(); });
addEventListener("storage", e => { if (e.key === "qm-plugins" && devOn()) startAll(); });
if (devOn()) setTimeout(startAll, 800);
export const plugins = { emit, setContext, startPlugin, stopPlugin, startAll, stopAll, status };
