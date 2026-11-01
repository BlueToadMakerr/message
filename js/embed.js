// QuickMessage runs as one "shell" (index.html): chat list on the left, the open chat (message.html / account.html)
// in an <iframe> on the right, and the call (call.html) in a persistent <iframe> layer that survives switching chats.
// Pages loaded inside the shell use this helper to talk to it (same origin, so `parent.QM` is a plain object).
export const QM = (() => {
  try { return window.parent !== window && window.parent.QM ? window.parent.QM : null; } catch (_) { return null; }
})();
export const embedded = !!QM;

/** Leave the current page for the chat list. */
export function toHome() {
  if (QM) QM.closeDetail(); else if (window.parent !== window) toTop("index.html"); else location.replace("index.html");
}

/** Top-level navigation that works from inside the shell too. */
export function toTop(url) {
  try { (window.top || window).location.replace(url); } catch (_) { location.replace(url); }
}

/** Mark the document `split` while the shell shows list + chat side by side (hides redundant back buttons). */
export function trackSplit() {
  if (!QM) return;
  const apply = () => document.documentElement.classList.toggle("split", !!QM.isSplit());
  apply();
  window.parent.addEventListener("resize", apply);
}

/** Standalone (top-level) page → send the visitor into the shell instead. */
export function enterShell(query) {
  if (window.top === window && !new URLSearchParams(location.search).has("standalone")) {
    location.replace("index.html?" + query);
    return true;
  }
  return false;
}

/** Tell the shell this page has fully booted (its watchdog reloads frames that never do). Call at the end of the page's main module. */
export function markReady() {
  window.__qmReady = true;
  try { if (QM && window.frameElement) QM.frameReady(window.frameElement); } catch (_) { /* ignore */ }
}

// Inside the shell, a link that navigates this frame would add a history entry, and Back would then walk the frame to a blank
// page. Same-origin links therefore replace the page instead.
if (QM) document.addEventListener("click", ev => {
  const a = ev.target.closest && ev.target.closest("a[href]");
  if (!a || ev.defaultPrevented || ev.button !== 0 || ev.metaKey || ev.ctrlKey || ev.shiftKey || ev.altKey) return;
  if ((a.target && a.target !== "_self") || a.hasAttribute("download")) return;
  let u; try { u = new URL(a.href, location.href); } catch (_) { return; }
  if (u.origin !== location.origin) return;
  if (u.pathname === location.pathname && u.search === location.search && u.hash) {      // a link to a place on this same page: scroll there ourselves, so no history entry is added (Back would land on the docs again)
    ev.preventDefault();
    let t = null; try { t = document.getElementById(decodeURIComponent(u.hash.slice(1))); } catch (_) { /* ignore */ }
    if (t) t.scrollIntoView({ block: "start" }); else window.scrollTo(0, 0);
    return;
  }
  ev.preventDefault();
  try { location.replace(u.href); } catch (_) { location.href = u.href; }
});
