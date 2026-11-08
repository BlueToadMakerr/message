// "Updating…" indicator. Anything that shows saved (offline) data while the live data is still on its way calls begin(); the returned function
// ends it. One small pill at the top of the app shows it: "Updating…", "Still updating… slow connection", or "Offline — showing saved data".
// All frames share one counter (kept on the top window); the pill lives in the top window.
const top = (() => { try { void window.top.document; return window.top; } catch (_) { return window; } })();
const S = top.__qmSync || (top.__qmSync = { items: new Map(), seq: 0, subs: new Set() });
const poke = () => S.subs.forEach(f => { try { f(); } catch (_) { /* ignore */ } });
export function begin(label) { const id = ++S.seq; S.items.set(id, { label, at: Date.now() }); poke(); return () => { if (S.items.delete(id)) poke(); }; }
export const pending = () => S.items.size;

if (window === top && !S.ui) {
  S.ui = true;
  let el = null, shownAt = 0;
  const paint = () => {
    const n = S.items.size;
    if (!n) { if (el) { el.remove(); el = null; } return; }
    const offline = navigator.onLine === false;
    const oldest = Math.min(...[...S.items.values()].map(i => i.at)), age = Date.now() - oldest;
    if (!offline && age < 700) return;                                      // quick updates never flash
    if (!el) {
      if (!document.body) return;
      el = document.createElement("div"); el.className = "sync-pill"; el.setAttribute("role", "status"); el.setAttribute("aria-live", "polite");
      el.innerHTML = '<span class="spinner"></span><span class="sp-text"></span>'; document.body.append(el); shownAt = Date.now();
    }
    el.classList.toggle("offline", offline);
    el.querySelector(".sp-text").textContent = offline ? "Offline — showing saved data" : age > 10000 ? "Still updating… slow connection" : "Updating…";
  };
  S.subs.add(paint); setInterval(paint, 700);
  addEventListener("online", paint); addEventListener("offline", paint);
}
