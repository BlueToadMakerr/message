// Plugin storage + compatibility checks, shared by the shell (js/plugins.js) and the Plugins page (js/plugins-page.js).
import { SITE_VERSION, API_VERSION, cmpVer, validVer } from "./version.js";

const KEY = "qm-plugins";
export const PERMISSIONS = {
  toast:    { label: "Show messages (toasts)", risk: "low" },
  style:    { label: "Change how the site looks (CSS)", risk: "low" },
  me:       { label: "Read your name and account id", risk: "medium" },
  chat:     { label: "Know which chat is open; put text in the message box", risk: "medium" },
  messages: { label: "Read the text of messages shown on your screen", risk: "high" },
  panel:    { label: "Show small panels and banners (including on the call screen)", risk: "low" },
  network:  { label: "Contact other websites (can send data out)", risk: "high" },
  page:     { label: "Control the page: read what is on screen, click, type, scroll, search the chat", risk: "high" },
  buttons:  { label: "Add buttons to the chat, chat list and call screens", risk: "low" },
  calls:    { label: "Know when you are in a call", risk: "medium" },
  devinfo:  { label: "Read developer info and add cards to developer views", risk: "medium" },
  send:      { label: "Send messages in the open chat for you", risk: "high" },
  clipboard: { label: "Copy text to the clipboard", risk: "medium" },
  notify:    { label: "Show notifications and vibrate", risk: "low" },
  keys:      { label: "Add keyboard shortcuts", risk: "low" },
  commands:  { label: "Add slash commands (/name) to the message box", risk: "low" },
  ui:        { label: "Open its own windows with forms, lists and buttons", risk: "low" },
  menu:      { label: "Add choices to the message menu (and receive the message you pick)", risk: "medium" }
};
export const MAX_CODE = 200000;

export function loadPlugins() { try { const l = JSON.parse(localStorage.getItem(KEY) || "[]"); return Array.isArray(l) ? l : []; } catch (_) { return []; } }
export function savePlugins(list) { localStorage.setItem(KEY, JSON.stringify(list)); }
export const newPluginId = () => "p" + Math.random().toString(36).slice(2, 10);

/** Clean a plugin object (from the editor or an imported file); throws Error with a readable message. */
export function normalize(raw) {
  if (!raw || typeof raw !== "object") throw new Error("Not a plugin file.");
  const name = String(raw.name || "").trim().slice(0, 60);
  if (!name) throw new Error("A plugin needs a name.");
  const version = String(raw.version || "1.0.0").trim();
  if (!validVer(version)) throw new Error("Version must look like 1.0.0.");
  const code = String(raw.code || "");
  if (code.length > MAX_CODE) throw new Error("The code is too long (200,000 characters at most).");
  const apiVersion = Number.isInteger(raw.apiVersion) ? raw.apiVersion : API_VERSION;
  const minSite = raw.minSite ? String(raw.minSite).trim() : "";
  if (minSite && !validVer(minSite)) throw new Error("“Minimum site version” must look like 1.44.0.");
  const updateUrl = raw.updateUrl ? String(raw.updateUrl).trim() : "";
  if (updateUrl && !/^https:\/\//i.test(updateUrl)) throw new Error("The update address must start with https://");
  return {
    id: /^p[a-z0-9]{3,16}$/.test(raw.id || "") ? raw.id : newPluginId(),
    name, version, apiVersion, minSite, updateUrl,
    description: String(raw.description || "").slice(0, 300), author: String(raw.author || "").slice(0, 60),
    permissions: [...new Set((Array.isArray(raw.permissions) ? raw.permissions : []).filter(p => PERMISSIONS[p]))],
    code, enabled: raw.enabled === true, added: raw.added || Date.now()
  };
}

/** Problems with a plugin on this site: [{level: "warn" | "error", text}]. Empty = fine. */
export function pluginIssues(p) {
  const out = [];
  if (p.apiVersion < API_VERSION) out.push({ level: "warn", text: `Outdated: written for plugin API v${p.apiVersion}; this site uses v${API_VERSION}. It may not work properly. Ask its author for an update (see "What changed" in the docs).` });
  if (p.apiVersion > API_VERSION) out.push({ level: "error", text: `Needs a newer site: it uses plugin API v${p.apiVersion}, this site has v${API_VERSION}. Update the site (or reload) to use it.` });
  if (p.minSite && cmpVer(p.minSite, SITE_VERSION) > 0) out.push({ level: "error", text: `Needs site version ${p.minSite} or newer; this site is ${SITE_VERSION}.` });
  return out;
}
export const isBlocked = p => pluginIssues(p).some(i => i.level === "error");

/** Looks for a newer copy of the plugin at its update address (JSON with {version, apiVersion?, minSite?, downloadUrl?}). */
export async function checkPluginUpdate(p) {
  if (!p.updateUrl) return { ok: true, none: true };
  try {
    const r = await fetch(p.updateUrl, { cache: "no-store" });
    const j = await r.json();
    if (!r.ok || !validVer(j.version)) throw new Error("Unexpected answer");
    return { ok: true, newer: cmpVer(j.version, p.version) > 0, latest: j.version, info: j };
  } catch (e) { return { ok: false, error: String(e && e.message || e) }; }
}

/** Turns what people paste (a GitHub page link, say) into the address of the plain file. */
export function directPluginUrl(u) {
  u = String(u || "").trim();
  let x; try { x = new URL(u); } catch (_) { throw new Error("That doesn't look like a web address."); }
  const local = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(x.hostname);
  if (x.protocol !== "https:" && !(x.protocol === "http:" && local)) throw new Error("The address must start with https://");
  const m = x.hostname === "github.com" && x.pathname.match(/^\/([^/]+)\/([^/]+)\/blob\/(.+)$/);
  if (m) return `https://raw.githubusercontent.com/${m[1]}/${m[2]}/${m[3]}`;
  return x.href;
}
/** Downloads a plugin file from a web address and checks it. It comes back switched OFF; the person reviews permissions first. */
export async function fetchPluginFromUrl(url) {
  const href = directPluginUrl(url);
  let r;
  try { r = await fetch(href, { cache: "no-store", credentials: "omit", redirect: "follow" }); }
  catch (_) { throw new Error("Couldn't download it. The site may be offline, or it doesn't allow other websites to read the file (GitHub raw links and jsDelivr work)."); }
  if (!r.ok) throw new Error("The site answered " + r.status + ".");
  const text = await r.text();
  if (text.length > MAX_CODE + 20000) throw new Error("That file is too big for a plugin.");
  let raw; try { raw = JSON.parse(text); } catch (_) { throw new Error("That isn't a plugin file (expected JSON exported from the Plugins page)."); }
  if (!raw || typeof raw !== "object") throw new Error("That isn't a plugin file.");
  const p = normalize({ ...raw, updateUrl: raw.updateUrl || href, enabled: false });
  return { plugin: p, url: href };
}
