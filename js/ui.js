// Small UI toolkit: toasts, dialogs (replace alert/confirm/prompt), icons, avatars, formatting.

// ---------- icons ----------
const ICONS = {
  send: '<path d="M22 2 11 13"/><path d="M22 2 15 22l-4-9-9-4 20-7z"/>',
  back: '<path d="m15 18-6-6 6-6"/>',
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
  mic: '<path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><path d="M12 19v3M8 22h8"/>',
  camera: '<path d="M15 8.5 20 6v12l-5-2.5z"/><rect x="3" y="6" width="12" height="12" rx="2"/>',
  monitor: '<rect x="3" y="4" width="18" height="14" rx="2"/><path d="M8 21h8M12 18v3"/>',
  refresh: '<path d="M20 11a8 8 0 0 0-14.9-4L3 10"/><path d="M3 4v6h6"/><path d="M4 13a8 8 0 0 0 14.9 4L21 14"/><path d="M21 20v-6h-6"/>',
  phone: '<path d="M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1 1 .3 1.9.7 2.8a2 2 0 0 1-.5 2.1L8 9.9a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.5c.9.4 1.8.6 2.8.7a2 2 0 0 1 1.8 2.1z"/>'
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

export function avatarEl(name, url, cls = "avatar") {
  const wrap = document.createElement("span");
  wrap.className = cls;
  const label = (name || "?").trim();
  const initials = label.split(/\s+/).slice(0, 2).map(w => w[0] || "").join("").toUpperCase() || "?";
  const fallback = () => {
    wrap.replaceChildren(document.createTextNode(initials));
    wrap.classList.add("initials");
    wrap.style.background = `hsl(${hueFor(label)} 55% 42%)`;
  };
  if (url && /^(https?:|data:image\/)/i.test(url)) {
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
