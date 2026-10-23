// The page itself never zooms (pinch, ctrl+wheel, ctrl +/-): images have their own zoom viewer (viewer.js) instead.
const stop = e => e.preventDefault();
addEventListener("wheel", e => { if (e.ctrlKey) e.preventDefault(); }, { passive: false });
for (const t of ["gesturestart", "gesturechange", "gestureend"]) addEventListener(t, stop);
addEventListener("keydown", e => { if ((e.ctrlKey || e.metaKey) && ["+", "-", "=", "_", "0"].includes(e.key)) e.preventDefault(); });
addEventListener("touchmove", e => { if (e.touches.length > 1 && !(e.target.closest && e.target.closest(".qm-viewer"))) e.preventDefault(); }, { passive: false });
try { document.documentElement.style.touchAction = "pan-x pan-y"; } catch (_) { /* ignore */ }
