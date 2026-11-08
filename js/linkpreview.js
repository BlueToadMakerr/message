// Link previews: finds links in a message and shows what they are.
//  - images / videos / audio files → shown inline
//  - YouTube / Vimeo → a thumbnail that turns into the player when clicked (privacy-friendly nocookie embed)
//  - everything else → a card (title, description, picture) fetched by link-preview.php, plus an embeddable player when the site offers one
// Turn off per device in Account → Link previews.
import { auth, db } from "./firebase.js";
import { ref, get } from "./sdk.js";
import { customDbUrl } from "./dburl.js";
import { openImage } from "./viewer.js";
import { audioPlayer, videoPlayer } from "./player.js";
import { saverOn } from "./datasaver.js";

const URL_RE = /https?:\/\/[^\s<>"']+/gi;
const MAX_PER_MESSAGE = 2;
import { PRIVATE } from "./mode.js";
export const previewsOn = () => { if (PRIVATE) return false; try { return localStorage.getItem("qm-previews") !== "off"; } catch (_) { return true; } };
export const setPreviews = on => { try { localStorage.setItem("qm-previews", on ? "on" : "off"); } catch (_) { /* ignore */ } };

const cache = new Map();             // url -> Promise<{data, retry}>   (this page only)
const clean = u => u.replace(/[).,;:!?]+$/, "");
const extOf = u => { try { return new URL(u).pathname.split(".").pop().toLowerCase(); } catch (_) { return ""; } };

function youtubeId(u) {
  try {
    const x = new URL(u), h = x.hostname.replace(/^www\.|^m\./, "");
    if (h === "youtu.be") return x.pathname.slice(1).split("/")[0] || null;
    if (h === "youtube.com" || h === "music.youtube.com") {
      if (x.pathname === "/watch") return x.searchParams.get("v");
      const m = /^\/(shorts|embed|live)\/([\w-]{6,})/.exec(x.pathname); if (m) return m[2];
    }
  } catch (_) { /* ignore */ }
  return null;
}
function vimeoId(u) { try { const x = new URL(u); if (/(^|\.)vimeo\.com$/.test(x.hostname)) { const m = /^\/(\d{5,})/.exec(x.pathname); return m ? m[1] : null; } } catch (_) { /* ignore */ } return null; }

// Where a preview comes from, in order:
//  1. the shared cache in the database (linkPreviews/{id}, written by link-preview.php) — free of charge to the server, good for a week;
//  2. link-preview.php, which fetches the page (just its first part) and stores the good result in that cache.
// If the server finds nothing to show for a link that WAS cached, or can't be reached, the cached preview keeps being shown.
// A link that has no preview at all is not cached anywhere. A network failure is retried when the connection is back.
const DAY = 864e5, WEEK = 7 * DAY;      // links with a price are refreshed daily, everything else weekly
async function idOf(url) {
  const h = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(url));
  return [...new Uint8Array(h)].slice(0, 16).map(b => b.toString(16).padStart(2, "0")).join("");
}
const usingCustomDb = () => !!customDbUrl();     // another database: its previews never go into the default one
const hasContent = m => !!(m && (m.title || m.description || m.image));

async function loadMeta(url, priv) {
  priv = priv || usingCustomDb();
  let stale = null;
  if (!priv) {
    try {
      const snap = await get(ref(db, `linkPreviews/${await idOf(url)}`));
      const e = snap.val();
      if (e && hasContent(e.d)) {
        if (Date.now() - (e.t || 0) < (e.d.price ? DAY : WEEK)) return { data: e.d, retry: false };
        stale = e.d;                                           // older than a week: ask for an update, but keep this as the fallback
      }
    } catch (_) { /* the database can't be reached right now: the server request below decides */ }
  }
  try {
    const idToken = await auth.currentUser.getIdToken();
    const r = await fetch("link-preview.php", { method: "POST", body: new URLSearchParams({ idToken, url, ...(priv ? { private: "1" } : {}) }) });
    if (!r.ok) return { data: stale, retry: r.status >= 500 || r.status === 429 };
    const j = await r.json();
    if (hasContent(j)) return { data: j, retry: false };
    return { data: stale, retry: false };                      // the page has no preview (any more): show the old one if there is one
  } catch (_) {
    return { data: stale, retry: true };                       // no network / server unreachable: try again when it is back
  }
}

function fetchMeta(url, priv) {
  const k = (priv ? "p:" : "") + url;
  if (!cache.has(k)) {
    cache.set(k, (async () => {
      const hit = (() => { try { return sessionStorage.getItem("qm-lp:" + k); } catch (_) { return null; } })();
      if (hit) return { data: JSON.parse(hit), retry: false };
      const r = await loadMeta(url, priv);
      if (r.retry) cache.delete(k);                            // don't remember a failure
      else if (r.data) { try { sessionStorage.setItem("qm-lp:" + k, JSON.stringify(r.data)); } catch (_) { /* full */ } }
      return r;
    })());
  }
  return cache.get(k);
}

const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };

function playerCard(url, thumb, title, iframeSrc, host, creator) {
  const c = el("div", "lp-card lp-video");
  const stage = el("button", "lp-stage"); stage.type = "button"; stage.setAttribute("aria-label", "Play video");
  if (thumb) { const i = new Image(); i.src = thumb; i.alt = ""; i.loading = "lazy"; i.referrerPolicy = "no-referrer"; stage.append(i); }
  stage.append(el("span", "lp-play", "▶"));
  stage.addEventListener("click", () => {
    const f = document.createElement("iframe");
    f.src = iframeSrc; f.allow = "autoplay; fullscreen; picture-in-picture; encrypted-media"; f.allowFullscreen = true;
    f.referrerPolicy = "strict-origin-when-cross-origin"; f.className = "lp-frame";
    f.setAttribute("sandbox", "allow-scripts allow-same-origin allow-presentation allow-popups");
    stage.replaceWith(f);
  });
  const meta = el("a", "lp-meta"); meta.href = url; meta.target = "_blank"; meta.rel = "noopener noreferrer";
  meta.append(el("span", "lp-site", host), el("strong", "lp-title", title || url));
  if (creator) meta.append(el("span", "lp-desc", creator));
  c.append(stage, meta);
  return c;
}

// ------------------------------------------------------------------ rich card pieces
const fmtDate = v => { const d = new Date(v); return isNaN(d) ? "" : d.toLocaleDateString([], { year: "numeric", month: "short", day: "numeric" }); };
const fmtDur = v => {
  if (typeof v === "number" || /^\d+$/.test(String(v))) { const s = +v; if (!s) return ""; const h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60), r = s % 60; return h ? `${h}:${String(m).padStart(2, "0")}:${String(r).padStart(2, "0")}` : `${m}:${String(r).padStart(2, "0")}`; }
  const m = /^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/i.exec(String(v)); return m ? [m[1] && m[1] + " h", m[2] && m[2] + " min", m[3] && m[3] + " s"].filter(Boolean).join(" ") : "";
};
function money(p) {
  const n = parseFloat(String(p.amount).replace(/,(\d{2})$/, ".$1").replace(/,/g, ""));
  if (!isFinite(n)) return String(p.amount);
  try { return p.currency ? new Intl.NumberFormat([], { style: "currency", currency: p.currency }).format(n) : n.toLocaleString(); } catch (_) { return (p.currency ? p.currency + " " : "") + n; }
}
const chip = (text, cls = "") => el("span", "lp-chip " + cls, text);
const row = (label, text) => { const r = el("div", "lp-row"); r.append(el("span", "lp-k", label), el("span", "lp-v", text)); return r; };
const stars = r => "★".repeat(Math.round(Math.min(5, (r.value / (r.best || 5)) * 5))) + "☆".repeat(5 - Math.round(Math.min(5, (r.value / (r.best || 5)) * 5)));

/** Opening a link. In the Android app, if the site offers an Android app that is installed, ask where to open it. */
function openLink(url, android) {
  try {
    if (android && android.package && window.QMApp && window.QMApp.canOpenApp && window.QMApp.canOpenApp(android.package, url)) { askWhere(url, android); return; }
  } catch (_) { /* ignore */ }
  window.open(url, "_blank", "noopener,noreferrer");
}
function askWhere(url, android) {
  const d = document.createElement("dialog"); d.className = "modal lp-where";
  d.innerHTML = `<form method="dialog" class="stack"><h2></h2><p class="muted"></p><div class="modal-actions" style="flex-direction:column;align-items:stretch"><button class="btn primary" value="app" type="submit"></button><button class="btn" value="web" type="submit">Open in browser</button><button class="btn" value="x" type="submit">Cancel</button></div></form>`;
  const app = android.app || "the app";
  d.querySelector("h2").textContent = "Open this link";
  d.querySelector("p").textContent = `${new URL(url).hostname} has an Android app (${app}) installed on this phone.`;
  d.querySelector("button[value=app]").textContent = "Open in " + app;
  document.body.append(d);
  d.addEventListener("close", () => {
    const v = d.returnValue; d.remove();
    if (v === "app") { try { window.QMApp.openInApp(android.package, url); } catch (_) { window.open(url, "_blank", "noopener,noreferrer"); } }
    else if (v === "web") window.open(url, "_blank", "noopener,noreferrer");
  });
  d.showModal();
}

function mapBlock(loc) {
  const box = el("div", "lp-loc");
  const line = el("div", "lp-row"); line.append(el("span", "lp-k", "📍"), el("span", "lp-v", [loc.name, loc.address].filter(Boolean).join(" · ") || (loc.lat + ", " + loc.lng)));
  box.append(line);
  if (loc.phone) box.append(row("☎", loc.phone));
  if (loc.hours) box.append(row("🕒", loc.hours));
  if (loc.priceRange) box.append(row("💲", loc.priceRange));
  if (loc.starts) box.append(row("📅", fmtDate(loc.starts) || loc.starts));
  if (typeof loc.lat === "number") {
    const acts = el("div", "lp-acts");
    const show = el("button", "lp-act", "Show map"); show.type = "button";
    show.onclick = () => {
      const d = 0.006, f = document.createElement("iframe");
      f.className = "lp-map"; f.loading = "lazy"; f.referrerPolicy = "no-referrer"; f.setAttribute("sandbox", "allow-scripts allow-same-origin");
      f.src = `https://www.openstreetmap.org/export/embed.html?bbox=${loc.lng - d},${loc.lat - d},${loc.lng + d},${loc.lat + d}&layer=mapnik&marker=${loc.lat},${loc.lng}`;
      show.replaceWith(f);
    };
    const open = el("a", "lp-act", "Open in maps");
    open.href = window.QMApp ? `geo:${loc.lat},${loc.lng}?q=${loc.lat},${loc.lng}` : `https://www.openstreetmap.org/?mlat=${loc.lat}&mlon=${loc.lng}#map=16/${loc.lat}/${loc.lng}`;
    if (!window.QMApp) { open.target = "_blank"; open.rel = "noopener noreferrer"; }
    acts.append(show, open); box.append(acts);
  }
  return box;
}

function extras(m, url) {
  const x = el("div", "lp-extra");
  if (m.price) {
    const pr = el("div", "lp-price");
    pr.append(el("strong", "lp-amt", money(m.price)));
    if (m.price.was) pr.append(el("s", "lp-was", money({ ...m.price, amount: m.price.was })));
    if (m.price.availability) pr.append(chip(m.price.availability.replace(/([a-z])([A-Z])/g, "$1 $2"), /InStock|in stock/i.test(m.price.availability) ? "good" : ""));
    pr.append(el("small", "lp-live", "updates daily"));
    x.append(pr);
  }
  if (m.rating) x.append(row(stars(m.rating), `${m.rating.value}${m.rating.count ? " (" + m.rating.count.toLocaleString() + ")" : ""}`));
  const e = m.entertainment;
  if (e) {
    const bits = [];
    const kind = String(e.kind || "").replace(/^(video|music)\./, "").replace(/[._]/g, " "); if (kind) bits.push(kind);
    if (e.released) bits.push(fmtDate(e.released) || e.released);
    const d = fmtDur(e.duration); if (d) bits.push(d);
    if (bits.length) x.append(row("🎬", bits.join(" · ")));
    if (e.artists && e.artists.length) x.append(row("🎤", e.artists.join(", ")));
    if (e.album) x.append(row("💿", e.album));
    if (e.directors && e.directors.length) x.append(row("Directed by", e.directors.join(", ")));
    if (e.actors && e.actors.length) x.append(row("Starring", e.actors.join(", ")));
    if (e.creator) x.append(row("Series", e.creator));
    if (e.genres && e.genres.length) { const g = el("div", "lp-chips"); e.genres.forEach(t => g.append(chip(t))); x.append(g); }
  }
  const a = m.article;
  if (a) {
    if (a.authors && a.authors.length) x.append(row("✍️", a.authors.join(", ")));
    const bits = [];
    if (a.published) bits.push("Published " + (fmtDate(a.published) || a.published));
    if (a.modified && fmtDate(a.modified) !== fmtDate(a.published)) bits.push("Edited " + (fmtDate(a.modified) || a.modified));
    if (a.minutes) bits.push(a.minutes + " min read");
    if (bits.length) x.append(row("🗞", bits.join(" · ")));
    const t = [a.section, ...(a.tags || [])].filter(Boolean).slice(0, 5);
    if (t.length) { const g = el("div", "lp-chips"); t.forEach(v => g.append(chip(v))); x.append(g); }
  }
  const p = m.profile;
  if (p) {
    if (p.name) x.append(row("👤", p.name + (p.username ? " (@" + p.username.replace(/^@/, "") + ")" : "")));
    if (p.job || p.works) x.append(row("💼", [p.job, p.works].filter(Boolean).join(" · ")));
    if (p.followers) x.append(row("👥", p.followers.toLocaleString() + " followers"));
  }
  const b = m.book;
  if (b) {
    if (b.authors && b.authors.length) x.append(row("✍️", b.authors.join(", ")));
    const bits = [b.released && (fmtDate(b.released) || b.released), b.pages && b.pages + " pages", b.isbn && "ISBN " + b.isbn].filter(Boolean);
    if (bits.length) x.append(row("📖", bits.join(" · ")));
    if (b.tags && b.tags.length) { const g = el("div", "lp-chips"); b.tags.forEach(v => g.append(chip(v))); x.append(g); }
  }
  if (m.recipe) x.append(row("🍳", [m.recipe.time && fmtDur(m.recipe.time), m.recipe.yield && m.recipe.yield + " servings", m.recipe.calories].filter(Boolean).join(" · ")));
  (m.facts || []).forEach(([k, v]) => x.append(row(k, v)));
  if (m.location) x.append(mapBlock(m.location));
  return x.children.length ? x : null;
}

function richCard(url, m, onLayout) {
  const c = el("div", "lp-card lp-rich");
  if (m.color) c.style.borderLeft = `4px solid ${m.color}`;
  const host = (() => { try { return new URL(url).hostname; } catch (_) { return ""; } })();
  // media: our own video / audio player, an embedded player, or the picture (which opens in the zoom viewer)
  if (m.video) c.append(videoPlayer(m.video.url, { poster: m.image, onLayout }));
  else if (m.embed) c.append(playerCard(url, m.image, m.title, m.embed, m.site || host, null).firstChild);
  else if (m.image) {
    const i = new Image(); i.src = m.image; i.alt = m.imageAlt || ""; if (m.imageAlt) i.title = m.imageAlt;
    i.loading = "lazy"; i.referrerPolicy = "no-referrer"; i.className = "lp-thumb";
    i.addEventListener("load", () => onLayout && onLayout(i)); i.addEventListener("error", () => i.remove());
    i.addEventListener("click", () => openImage(m.image, { alt: m.imageAlt || "" }));
    c.append(i);
  }
  if (m.audio) { const w = el("div", "lp-audio"); w.append(audioPlayer(m.audio.url)); c.append(w); }
  const meta = el("a", "lp-meta"); meta.href = url; meta.target = "_blank"; meta.rel = "noopener noreferrer";
  meta.addEventListener("click", e => { if (m.android) { e.preventDefault(); openLink(url, m.android); } });
  const site = el("span", "lp-site");
  if (m.icon) { const f = new Image(); f.src = m.icon; f.alt = ""; f.className = "lp-fav"; f.referrerPolicy = "no-referrer"; f.addEventListener("error", () => f.remove()); site.append(f); }
  site.append(document.createTextNode(m.site || host));
  meta.append(site);
  if (m.title) meta.append(el("strong", "lp-title", m.title));
  if (m.description) meta.append(el("span", "lp-desc", m.description));
  c.append(meta);
  const x = extras(m, url); if (x) c.append(x);
  if (m.android) {
    const hint = el("div", "lp-app", "");   // only shown in the Android app, and only if the app is installed
    hint.hidden = true;
    try { if (window.QMApp && window.QMApp.canOpenApp && window.QMApp.canOpenApp(m.android.package, url)) { hint.hidden = false; hint.textContent = "📱 Opens in " + (m.android.app || "its app") + " if you like"; } } catch (_) { /* ignore */ }
    c.append(hint);
  }
  return c;
}

async function build(url, onLayout, priv) {
  const ext = extOf(url);
  if (["png", "jpg", "jpeg", "gif", "webp", "avif", "bmp"].includes(ext)) {
    const i = new Image(); i.className = "lp-img"; i.loading = "lazy"; i.referrerPolicy = "no-referrer"; i.alt = "";
    i.addEventListener("load", () => onLayout && onLayout(i)); i.addEventListener("error", () => i.remove());
    i.addEventListener("click", () => openImage(url));
    i.src = url; return { node: i };
  }
  if (["mp4", "webm", "mov", "m4v", "ogv"].includes(ext)) return { node: videoPlayer(url, { onLayout }) };
  if (["mp3", "wav", "m4a", "aac", "flac", "opus", "ogg"].includes(ext)) return { node: audioPlayer(url) };
  const yt = youtubeId(url);
  const { data: meta, retry } = await fetchMeta(url, priv);
  if (yt) {
    const card = playerCard(url, `https://i.ytimg.com/vi/${yt}/hqdefault.jpg`, meta?.title, `https://www.youtube-nocookie.com/embed/${encodeURIComponent(yt)}?autoplay=1&rel=0`, "YouTube", meta?.creator);
    return { node: card, retry };
  }
  const vm = vimeoId(url);
  if (vm) return { node: playerCard(url, meta?.image, meta?.title, `https://player.vimeo.com/video/${vm}?autoplay=1`, "Vimeo"), retry };
  if (!meta || !(meta.title || meta.description || meta.image || meta.video || meta.audio)) return { node: null, retry };
  return { node: richCard(url, meta, onLayout), retry };
}

/** Adds preview cards under a text bubble. enc: the message is end-to-end encrypted, so its links are never put in the shared cache. */
export function attachPreviews(bubble, text, { onLayout, enc } = {}) {
  if (!previewsOn() || !text) return;
  const urls = [...new Set((String(text).match(URL_RE) || []).map(clean))].filter(u => { try { return /^https?:$/.test(new URL(u).protocol); } catch (_) { return false; } }).slice(0, MAX_PER_MESSAGE);
  if (!urls.length) return;
  const box = el("div", "lp-box");
  bubble.append(box);
  urls.forEach(u => {
    let shown = null, tries = 0;
    const run = () => build(u, onLayout, !!enc).then(({ node, retry }) => {
      if (!previewsOn() || bubble.isConnected === false) return;
      if (node && !shown) { shown = node; box.append(node); onLayout && onLayout(box); }
      if (retry && ++tries <= 8) waitForNetwork(run);          // couldn't reach the server: look again once the connection is back
    }).catch(() => {});
    // Data Saver: a preview downloads a page (and its picture), so it waits for a tap
    if (saverOn()) {
      const g = el("button", "media-lazy saver-gate"); g.type = "button"; g.textContent = "\ud83d\udd17 Tap to load link preview (Data Saver)";
      g.onclick = () => { g.remove(); run(); };
      box.append(g);
    } else run();
  });
}

// Runs fn when the device is back online (or after a pause if the browser doesn't say), once.
function waitForNetwork(fn) {
  let done = false;
  const go = () => { if (done) return; done = true; removeEventListener("online", go); clearTimeout(t); fn(); };
  addEventListener("online", go);
  const t = setTimeout(() => { if (navigator.onLine !== false) go(); else { done = true; removeEventListener("online", go); waitForNetwork(fn); } }, 30000);
}


// ---------------------------------------------------------------- developer mode: what we know about a link
export const urlsIn = text => [...new Set((String(text || "").match(URL_RE) || []).map(clean))].filter(u => { try { return /^https?:$/.test(new URL(u).protocol); } catch (_) { return false; } });

/** Facts about a link without contacting the site: its parts, what kind of link it is, and the preview stored in the shared cache (if any). */
export async function inspectUrl(url, { enc = false } = {}) {
  const out = { url };
  try {
    const x = new URL(url);
    out.parts = { protocol: x.protocol, host: x.hostname, port: x.port || "(default)", path: x.pathname, query: [...x.searchParams.keys()], hash: x.hash || "", length: url.length };
  } catch (_) { out.parts = null; }
  out.kind = youtubeId(url) ? `YouTube video ${youtubeId(url)}` : vimeoId(url) ? `Vimeo video ${vimeoId(url)}` : (["jpg", "jpeg", "png", "gif", "webp", "avif", "svg"].includes(extOf(url)) ? "image file" : ["mp4", "webm", "mov", "m4v"].includes(extOf(url)) ? "video file" : ["mp3", "wav", "ogg", "m4a", "aac", "opus"].includes(extOf(url)) ? "audio file" : "web page");
  out.insecure = /^http:/i.test(url);
  out.previewsOn = previewsOn();
  out.encryptedMessage = !!enc;
  out.sharedCache = null;
  if (!enc && !usingCustomDb()) {
    try {
      const e = (await get(ref(db, `linkPreviews/${await idOf(url)}`))).val();
      out.sharedCache = e ? { ageHours: Math.round(((Date.now() - (e.t || 0)) / 36e5) * 10) / 10, fresh: Date.now() - (e.t || 0) < (e.d && e.d.price ? DAY : WEEK), data: e.d || null } : "not cached";
    } catch (e) { out.sharedCache = "couldn't read: " + (e && e.message || e); }
  } else out.sharedCache = enc ? "never cached (end-to-end encrypted message)" : "not used (custom database)";
  return out;
}
/** Fetch the preview right now (same path the chat uses) so a developer can see what the server returns. */
export async function fetchPreviewNow(url, enc) {
  const t0 = performance.now();
  const r = await loadMeta(url, enc);
  return { ms: Math.round(performance.now() - t0), retryLater: r.retry, data: r.data };
}
