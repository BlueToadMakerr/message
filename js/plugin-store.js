// Plugin storage + compatibility checks, shared by the shell (js/plugins.js) and the Plugins page (js/plugins-page.js).
import { SITE_VERSION, API_VERSION, cmpVer, validVer } from "./version.js";

const KEY = "qm-plugins";
export const PERMISSIONS = {
  toast:    { label: "Show messages (toasts)", risk: "low" },
  style:    { label: "Change how the site looks (CSS)", risk: "low" },
  me:       { label: "Read your name and account id", risk: "medium" },
  chat:     { label: "Know which chat is open; put text in the message box", risk: "medium" },
  messages: { label: "Read the text of messages shown on your screen", risk: "high" },
  panel:    { label: "Show a small panel on the screen", risk: "low" },
  network:  { label: "Contact other websites (can send data out)", risk: "high" }
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
