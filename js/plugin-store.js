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
  menu:      { label: "Add choices to the message menu (and receive the message you pick)", risk: "medium" },
  speech:    { label: "Speak text out loud", risk: "low" },
  sound:     { label: "Play short sounds", risk: "low" },
  badge:     { label: "Show a number on the app icon / tab title", risk: "low" },
  share:     { label: "Open the share sheet (or copy) with text it chooses", risk: "low" },
  download:  { label: "Save files to your device (you see the download)", risk: "medium" },
  files:     { label: "Ask you to pick a file and read it", risk: "medium" },
  links:     { label: "Ask to open a web link (you confirm each one)", risk: "medium" },
  unsandboxed: { label: "UNSANDBOXED: run with FULL access to this site, your account and your messages", risk: "critical" }
};
/** What each permission really allows, in plain words (shown when you review a plugin). */
export const PERM_INFO = {
  toast: "Pops up short messages at the bottom of the screen.",
  style: "Can restyle the whole site (colours, fonts, hide parts). It cannot read anything.",
  me: "Can see your display name and your account id (UID).",
  chat: "Knows which chat you have open and can put text into your message box (it cannot send it).",
  messages: "Can read the text of messages that are on your screen, including decrypted ones. This is as sensitive as shoulder-surfing.",
  panel: "Can show small panels and banners, also on the call screen.",
  network: "The plugin can contact any website. Combined with another permission it can send what it learned (messages, names) out of your device.",
  page: "Can read what is on screen, click buttons, type into fields and scroll for you. It can act as you inside the app.",
  buttons: "Can add buttons in the chat header, the chat list and the call screen.",
  calls: "Knows when you are in a call and with which chat.",
  devinfo: "Can read developer information and add cards to the developer views.",
  send: "Can send messages in the open chat as you, without asking each time.",
  clipboard: "Can put text on your clipboard (it can overwrite what you copied).",
  notify: "Can show system notifications and make your phone vibrate.",
  keys: "Can add keyboard shortcuts.",
  commands: "Can add slash commands to the message box and see what you type after the slash.",
  ui: "Can open its own windows with text, forms, lists and buttons (drawn by the site, so they match the theme).",
  menu: "Adds choices to every message's menu. When you pick one it receives that message (its text only if it also has the 'messages' permission).",
  speech: "Can read text aloud with your device's voice.",
  sound: "Can play short beeps and alert sounds.",
  badge: "Can show a count on the app icon or in the tab title.",
  share: "Can open your device's share sheet with text it chooses (you pick where it goes).",
  download: "Can save a file it creates to your device. Your browser shows the download.",
  files: "Can open a file picker. It only gets the one file you choose.",
  links: "Can ask to open a web link. Nothing opens until you confirm that exact address.",
  unsandboxed: "The plugin is NOT locked in its safe box any more. It runs inside the site itself with the same powers as the site: it can read your messages and keys, act as you, send messages, change settings, read what you type (including passwords) and contact any server. Extremely dangerous."
};
export const UNSANDBOXED_WARNING = "Having a plugin unsandboxed is EXTREMELY DANGEROUS. It runs with the full power of the site: it can read all your messages and encryption keys, send messages as you, read what you type (including passwords) and send everything to anyone. Do NOT run anything you do not trust completely with this permission, and never enable it because someone online asked you to.";
const RISK_RANK = { low: 0, medium: 1, high: 2, critical: 3 };
export const riskOf = perms => (perms || []).reduce((m, k) => (RISK_RANK[PERMISSIONS[k]?.risk] ?? 0) > RISK_RANK[m] ? PERMISSIONS[k].risk : m, "low");
/** [{key, label, risk, info}] for a list of permission keys, most dangerous first. */
export function describePermissions(perms) {
  return (perms || []).filter(k => PERMISSIONS[k]).map(k => ({ key: k, label: PERMISSIONS[k].label, risk: PERMISSIONS[k].risk, info: PERM_INFO[k] || "" }))
    .sort((a, b) => RISK_RANK[b.risk] - RISK_RANK[a.risk]);
}
/** Permissions the person has not reviewed yet. A plugin saved before reviewing existed (no `approved` list) counts as reviewed, except "unsandboxed", which always needs a deliberate yes. */
export function unreviewed(p) {
  const ok = Array.isArray(p.approved) ? p.approved : (p.permissions || []).filter(k => k !== "unsandboxed");
  return (p.permissions || []).filter(k => !ok.includes(k));
}
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
    code, enabled: raw.enabled === true, added: raw.added || Date.now(), approved: []
  };                                   // note: "approved" is never taken from a file; the Plugins page sets it after you review the permissions
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
