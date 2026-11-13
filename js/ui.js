// Small UI toolkit: toasts, dialogs (replace alert/confirm/prompt), icons, avatars, formatting.

import "./nozoom.js";

// ---------- icons ----------
const ICONS = {
  play: '<path d="M6 4l14 8-14 8z" fill="currentColor"/>',
  pause: '<path d="M7 4h3v16H7zM14 4h3v16h-3z" fill="currentColor"/>',
  lock: '<rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>',
  info: '<circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/>',
  send: '<path d="M22 2 11 13"/><path d="M22 2 15 22l-4-9-9-4 20-7z"/>',
  back: '<path d="m15 18-6-6 6-6"/>',
  reply: '<path d="M9 17 4 12l5-5"/><path d="M20 18v-2a4 4 0 0 0-4-4H4"/>',
  image: '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="m21 15-5-5L5 21"/>',
  more: '<circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/><circle cx="5" cy="12" r="1"/>',
  bell: '<path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/>',
  bellOff: '<path d="M8.7 3A6 6 0 0 1 18 8a21.3 21.3 0 0 0 .6 5"/><path d="M17 17H3s3-2 3-9a4.67 4.67 0 0 1 .3-1.7"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/><path d="m2 2 20 20"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  users: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
  copy: '<rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
  down: '<path d="m6 9 6 6 6-6"/>',
  download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m7 10 5 5 5-5"/><path d="M12 15V3"/>',
  chat: '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>',
  close: '<path d="M18 6 6 18M6 6l12 12"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
  mic: '<path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><path d="M12 19v3M8 22h8"/>',
  camera: '<path d="M15 8.5 20 6v12l-5-2.5z"/><rect x="3" y="6" width="12" height="12" rx="2"/>',
  monitor: '<rect x="3" y="4" width="18" height="14" rx="2"/><path d="M8 21h8M12 18v3"/>',
  refresh: '<path d="M20 11a8 8 0 0 0-14.9-4L3 10"/><path d="M3 4v6h6"/><path d="M4 13a8 8 0 0 0 14.9 4L21 14"/><path d="M21 20v-6h-6"/>',
  smartphone: '<rect x="7" y="2" width="10" height="20" rx="2"/><path d="M11 18h2"/>',
  phone: '<path d="M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1 1 .3 1.9.7 2.8a2 2 0 0 1-.5 2.1L8 9.9a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.5c.9.4 1.8.6 2.8.7a2 2 0 0 1 1.8 2.1z"/>',
  headphones: '<path d="M3 14h3a2 2 0 0 1 2 2v3a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-7a9 9 0 0 1 18 0v7a2 2 0 0 1-2 2h-1a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2h3"/>',
  headphonesOff: '<path d="M3 14h3a2 2 0 0 1 2 2v3a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-7a9 9 0 0 1 18 0v7a2 2 0 0 1-2 2h-1a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2h3"/><path d="m2 2 20 20"/>',
  micOff: '<path d="m2 2 20 20"/><path d="M9 9v3a3 3 0 0 0 5.12 2.12M15 9.34V5a3 3 0 0 0-5.94-.6"/><path d="M17 16.95A7 7 0 0 1 5 12v-2m14 0v2a7 7 0 0 1-.11 1.23"/><path d="M12 19v3M8 22h8"/>',
  cameraOff: '<path d="M10.66 6H14a2 2 0 0 1 2 2v2.5l5.25-3.06A.5.5 0 0 1 22 7.87v8.2"/><path d="M16 16a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h2"/><path d="m2 2 20 20"/>',
  monitorOff: '<path d="M17 17H4a2 2 0 0 1-2-2V5c0-1.1.9-2 2-2h14"/><path d="M22 15V5a2 2 0 0 0-2-2"/><path d="M8 21h8M12 17v4"/><path d="m2 2 20 20"/>',
  phoneOff: '<path d="M10.68 13.31a16 16 0 0 0 3.41 2.6l1.27-1.27a2 2 0 0 1 2.11-.45c.91.34 1.85.57 2.81.7A2 2 0 0 1 22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.42 19.42 0 0 1-3.33-2.67m-2.67-3.34a19.79 19.79 0 0 1-3.07-8.63A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.13.96.36 1.9.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91"/><path d="m22 2-20 20"/>',
  pin: '<path d="M12 17v5"/><path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z"/>',
  maximize: '<path d="M8 3H5a2 2 0 0 0-2 2v3m18 0V5a2 2 0 0 0-2-2h-3m0 18h3a2 2 0 0 0 2-2v-3M3 16v3a2 2 0 0 0 2 2h3"/>',
  minimize: '<path d="M8 3v3a2 2 0 0 1-2 2H3m18 0h-3a2 2 0 0 1-2-2V3m0 18v-3a2 2 0 0 1 2-2h3M3 16h3a2 2 0 0 1 2 2v3"/>',
  userPlus: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M19 8v6M22 11h-6"/>',
  volume: '<path d="M11 5 6 9H2v6h4l5 4z"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14"/>',
  volumeX: '<path d="M11 5 6 9H2v6h4l5 4z"/><path d="m22 9-6 6M16 9l6 6"/>',
  popout: '<path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>',
  file: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/>',
  pip: '<rect x="2" y="3" width="20" height="14" rx="2"/><rect x="12" y="10" width="8" height="5" rx="1"/><path d="M8 21h8M12 17v4"/>',
  grid: '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>',
  alert: '<circle cx="12" cy="12" r="10"/><path d="M12 8v4M12 16h.01"/>',
  wifiOff: '<path d="M12 20h.01M8.5 16.43a5 5 0 0 1 7 0M5 12.86a10 10 0 0 1 5.17-2.7M2 8.82a15 15 0 0 1 4.17-2.65m4.84-.55A15 15 0 0 1 22 8.82M19 12.86a10 10 0 0 0-2-1.7"/><path d="m2 2 20 20"/>'
};

export function icon(name, size = 20) {
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name] || ""}</svg>`;
}

// Fill every [data-icon] element on the page.
export function hydrateIcons(root = document) {
  root.querySelectorAll("[data-icon]").forEach(el => {
    el.innerHTML = icon(el.dataset.icon, Number(el.dataset.size) || 20);
  });
}

// ---------- toasts ----------
export function toast(message, kind = "info", ms = 3500) {
  // Pages embedded in the app shell (chat, account, call, the call's chat panel) hand the toast to the top page, so every
  // toast shows in one stack instead of overlapping inside separate iframes.
  try { if (window.top !== window && typeof window.top.__qmToast === "function") return window.top.__qmToast(message, kind, ms); } catch (_) { /* cross-origin top: show locally */ }
  return localToast(message, kind, ms);
}
export function localToast(message, kind = "info", ms = 3500) {
  let host = document.getElementById("toasts");
  if (!host) {
    host = document.createElement("div");
    host.id = "toasts";
    host.setAttribute("aria-live", "polite");
    document.body.appendChild(host);
  }
  const t = document.createElement("div");
  t.className = `toast ${kind}`;
  t.textContent = message;
  host.appendChild(t);
  requestAnimationFrame(() => t.classList.add("show"));
  setTimeout(() => {
    t.classList.remove("show");
    setTimeout(() => t.remove(), 300);
  }, ms);
}

// ---------- dialogs ----------
function openDialog({ title, message, node, input, okText = "OK", cancelText = "Cancel", danger = false, hideCancel = false }) {
  return new Promise(resolve => {
    const d = document.createElement("dialog");
    d.className = "modal small";
    const form = document.createElement("form");
    form.method = "dialog";

    if (title) { const h = document.createElement("h2"); h.textContent = title; form.append(h); }
    if (node) form.append(node);
    if (message) { const p = document.createElement("p"); p.className = "modal-text"; p.textContent = message; form.append(p); }

    let field = null;
    if (input) {
      field = document.createElement(input.multiline ? "textarea" : "input");
      if (!input.multiline) field.type = input.type || "text";
      else field.rows = 3;
      field.className = "field";
      field.value = input.value || "";
      field.placeholder = input.placeholder || "";
      field.autocomplete = input.type === "password" ? "current-password" : "off";
      if (input.maxLength) field.maxLength = input.maxLength;
      form.append(field);
    }

    const actions = document.createElement("div");
    actions.className = "modal-actions";
    if (!hideCancel) {
      const cancel = document.createElement("button");
      cancel.type = "button";
      cancel.className = "btn";
      cancel.textContent = cancelText;
      cancel.onclick = () => d.close("cancel");
      actions.append(cancel);
    }
    const ok = document.createElement("button");
    ok.type = "submit";
    ok.value = "ok";
    ok.className = "btn " + (danger ? "danger" : "primary");
    ok.textContent = okText;
    actions.append(ok);
    form.append(actions);

    d.append(form);
    document.body.append(d);
    d.addEventListener("close", () => {
      const accepted = d.returnValue === "ok";
      resolve(field ? (accepted ? field.value : null) : accepted);
      d.remove();
    });
    d.addEventListener("click", e => { if (e.target === d) d.close("cancel"); });
    d.showModal();
    (field || ok).focus();
    if (field && field.select && !input.multiline) field.select();
  });
}

export const confirmDialog = opts => openDialog(opts);
export const promptDialog = opts => openDialog({ ...opts, input: opts.input || {} });
export const alertDialog = opts => openDialog({ ...opts, hideCancel: true });

// Close a static <dialog> when its backdrop is clicked.
export function wireDialog(d) {
  d.addEventListener("click", e => { if (e.target === d) d.close(); });
}

// ---------- avatars ----------
function hueFor(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) % 360;
  return h;
}

let avIO = null;
/** @param lazy true: the picture is only fetched/decoded once the avatar scrolls into view (long lists such as the chat list); initials show meanwhile */
export function avatarEl(name, url, cls = "avatar", lazy = false) {
  const wrap = document.createElement("span");
  wrap.className = cls;
  const label = (name || "?").trim();
  const initials = label.split(/\s+/).slice(0, 2).map(w => w[0] || "").join("").toUpperCase() || "?";
  const fallback = () => {
    wrap.replaceChildren(document.createTextNode(initials));
    wrap.classList.add("initials");
    wrap.style.background = `hsl(${hueFor(label)} 55% 42%)`;
  };
  if (url && lazy && typeof IntersectionObserver === "function" && /^(https?:|data:image\/)/i.test(url)) {
    fallback();
    avIO ||= new IntersectionObserver(es => es.forEach(e => {
      if (!e.isIntersecting) return;
      avIO.unobserve(e.target); const w = e.target, u = w._qmUrl; w._qmUrl = null; if (!u) return;
      const img = new Image(); img.alt = ""; img.referrerPolicy = "no-referrer";
      img.onload = () => { w.replaceChildren(img); w.classList.remove("initials"); w.style.background = ""; };
      img.src = u;                                    // on error the initials simply stay
    }), { rootMargin: "200px" });
    wrap._qmUrl = url; avIO.observe(wrap);
  } else if (url && /^(https?:|data:image\/)/i.test(url)) {
    const img = new Image();
    img.alt = "";
    img.referrerPolicy = "no-referrer";
    img.onerror = fallback;
    img.src = url;
    wrap.append(img);
  } else {
    fallback();
  }
  return wrap;
}

// ---------- text helpers ----------
// Build text with clickable links using DOM nodes only (no innerHTML => no XSS).
export function linkify(text) {
  const frag = document.createDocumentFragment();
  const re = /https?:\/\/[^\s<>]+/gi;
  let last = 0, m;
  const str = String(text ?? "");
  while ((m = re.exec(str))) {
    let url = m[0];
    let trail = "";
    const t = url.match(/[.,!?;:)\]'"]+$/);
    if (t) { trail = t[0]; url = url.slice(0, -trail.length); }
    if (m.index > last) frag.append(document.createTextNode(str.slice(last, m.index)));
    const a = document.createElement("a");
    a.href = url;
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    a.textContent = url;
    frag.append(a);
    if (trail) frag.append(document.createTextNode(trail));
    last = m.index + m[0].length;
  }
  if (last < str.length) frag.append(document.createTextNode(str.slice(last)));
  return frag;
}

export function safeMediaUrl(url, kind) {
  if (typeof url !== "string") return null;
  const u = url.trim();
  if (/^https?:\/\//i.test(u)) return u;
  if (kind === "image" && /^data:image\/[\w.+-]+;base64,/i.test(u)) return u;
  if (kind === "audio" && /^data:audio\/[\w.+-]+;base64,/i.test(u)) return u;
  if (kind === "video" && /^data:video\/[\w.+-]+;base64,/i.test(u)) return u;
  return null;
}

export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast("Copied", "success", 1500);
  } catch {
    toast("Couldn't copy", "error");
  }
}

// ---------- time ----------
export function formatMsgTime(ts) {
  const d = new Date(ts), now = new Date();
  const time = d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  if (d.toDateString() === now.toDateString()) return time;
  if (d.getFullYear() === now.getFullYear())
    return d.toLocaleDateString([], { month: "short", day: "numeric" }) + ", " + time;
  return d.toLocaleDateString([], { month: "short", day: "numeric", year: "numeric" }) + ", " + time;
}

export function formatListTime(ts) {
  if (!ts) return "";
  const d = new Date(ts), now = new Date();
  if (d.toDateString() === now.toDateString())
    return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  const y = new Date(now); y.setDate(now.getDate() - 1);
  if (d.toDateString() === y.toDateString()) return "Yesterday";
  if (now - d < 6 * 864e5) return d.toLocaleDateString([], { weekday: "short" });
  return d.toLocaleDateString([], { month: "short", day: "numeric", year: d.getFullYear() === now.getFullYear() ? undefined : "2-digit" });
}

// ---------- auth errors ----------
export function authErrorMessage(err) {
  switch (err && err.code) {
    case "auth/invalid-credential":
    case "auth/wrong-password":
    case "auth/user-not-found": return "Incorrect email or password.";
    case "auth/email-already-in-use": return "An account with that email already exists. Try logging in.";
    case "auth/weak-password": return "Password must be at least 6 characters.";
    case "auth/invalid-email": return "That email address doesn't look right.";
    case "auth/too-many-requests": return "Too many attempts. Wait a bit and try again.";
    case "auth/network-request-failed": return "Network error. Check your connection.";
    case "auth/requires-recent-login": return "Please log in again to do that.";
    case "auth/popup-closed-by-user":
    case "auth/cancelled-popup-request": return null;
    default: return (err && err.message) || "Something went wrong.";
  }
}