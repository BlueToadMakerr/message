// "Private server" mode: the site runs against the Python server in server/ instead of Firebase (see docs/SERVER-PRIVATE.md).
// It is on when the page is served by that server (it adds window.__QM_PRIVATE), or when this browser was pointed at one (localStorage qm-private).
const KEY = "qm-private";
export function privateBase() {
  try { if (window.__QM_PRIVATE === 1 || (window.top && window.top.__QM_PRIVATE === 1)) return ""; } catch (_) { /* cross-origin top */ }
  try { const v = localStorage.getItem(KEY); if (v && /^https?:\/\//i.test(v)) return v.replace(/\/+$/, ""); } catch (_) { /* ignore */ }
  return null;                          // null = Firebase mode
}
export const PRIVATE = privateBase() !== null;
if (PRIVATE) document.documentElement.classList.add("private-mode");
export const setPrivateServer = url => { try { url ? localStorage.setItem(KEY, url) : localStorage.removeItem(KEY); } catch (_) { /* ignore */ } };
