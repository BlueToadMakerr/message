// "X declined your call": the person who declined writes live/{caller}/declines/{chat}; the caller shows a notice and clears it.
import { db } from "./firebase.js";
import { ref, onValue, remove } from "./sdk.js";
import { getProfile } from "./users.js";
import { toast } from "./ui.js";

const seen = new Set();
export function watchDeclines(uid) {
  return onValue(ref(db, `live/${uid}/declines`), snap => {
    const all = snap.val() || {};
    for (const [chatId, d] of Object.entries(all)) {
      if (!d || !d.by) { continue; }
      remove(ref(db, `live/${uid}/declines/${chatId}`)).catch(() => {});
      const id = chatId + ":" + d.ts;
      if (seen.has(id) || Date.now() - (d.ts || 0) > 120000) continue;
      seen.add(id);
      try { window.QM && window.QM.declined && window.QM.declined(chatId, d.by); } catch (_) { /* ignore */ }
      getProfile(d.by).then(p => {
        const text = `${p.displayName} declined your call`;
        toast("📵 " + text, "info", 6000);
        try { if (document.hidden && "Notification" in window && Notification.permission === "granted") new Notification("Call declined", { body: text, tag: "decline-" + chatId }); } catch (_) { /* ignore */ }
      });
    }
  }, () => {});
}
