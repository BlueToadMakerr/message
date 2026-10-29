// First-login welcome tour: a few short pages about what is worth knowing (profile customisation, privacy, encryption, calls and files).
// It appears once for a brand-new account (per device), and can be opened again from Account → Welcome tour.
import { icon } from "./ui.js";

const KEY = uid => "qm-tour-" + uid;
const seen = uid => { try { return localStorage.getItem(KEY(uid)) === "1"; } catch (_) { return false; } };
const mark = uid => { try { localStorage.setItem(KEY(uid), "1"); } catch (_) { /* ignore */ } };

const PAGES = [
  { ico: "chat", title: "Welcome to QuickMessage", body: [
    "A small, fast chat app with messages, voice and video calls, screen sharing and file sharing.",
    "This is a short tour of the things most worth knowing. It takes under a minute, and you can open it again any time from Account → Welcome tour."
  ], note: "Heads up: QuickMessage was designed and written entirely with AI. It's an independent project, so rough edges are possible." },
  { ico: "users", title: "Make it yours", body: [
    "Open Account (your picture at the top) to set your display name and profile picture. That's how people see you in chats and calls.",
    "Under Colours you can pick a light, dark or system look, an accent colour (or your own custom colours), a midnight dark theme and, on Android, your phone's Material You colours. Changes preview live."
  ], go: "Account" },
  { ico: "lock", title: "Your privacy, your choice", body: [
    "Your email address is never shown to anyone. \"Let people add me by email\" decides whether someone can find you by email; when it's off, they need your UID (copy it from Account).",
    "\"Link previews\" shows what a link is (title, picture, video). Fetching a preview asks this site's server to open the link, so you can switch it off.",
    "Both switches are in Account → Privacy."
  ], go: "Account" },
  { ico: "lock", title: "Message encryption", body: [
    "Each chat can be end-to-end encrypted (chat options → Encryption). Messages, images, audio and files are scrambled on your device with a key only the chat's members hold, so the server can't read them.",
    "Your key lives on your device. Your recovery code is the only way to unlock encrypted chats on a new device, so save it somewhere safe (Account → Encryption → Show recovery code). Lose both and old encrypted messages can't be read.",
    "Not encrypted: chat names and photos, who is in a chat, and message times. Notifications for encrypted chats may just say \"New message\"."
  ], go: "Account" },
  { ico: "phone", title: "Calls, screens and files", body: [
    "Start a voice or video call from any chat, share your screen, and keep browsing other chats while a call runs.",
    "Big files are uploaded to a temporary host and expire after 3 days. Uploads carry on even if you leave the chat, and the chat list shows which chats are still uploading.",
    "Turn on notifications (the bell) so you hear about messages and calls when the app isn't open."
  ] }
];

/** Opens the tour. opts.openAccount: called when "Open Account" is pressed; opts.uid: marks the tour as seen when it ends. */
export function showTour(opts = {}) {
  return new Promise(resolve => {
    const d = document.createElement("dialog");
    d.className = "modal tour";
    d.setAttribute("aria-label", "Welcome tour");
    let i = 0;
    const done = why => { if (opts.uid) mark(opts.uid); d.close(why); };
    const paint = () => {
      const p = PAGES[i], last = i === PAGES.length - 1;
      d.replaceChildren();
      const wrap = document.createElement("div"); wrap.className = "tour-page";
      const ic = document.createElement("div"); ic.className = "tour-ico"; ic.innerHTML = icon(p.ico, 30);
      const h = document.createElement("h2"); h.textContent = p.title;
      wrap.append(ic, h);
      for (const t of p.body) { const el = document.createElement("p"); el.textContent = t; wrap.append(el); }
      if (p.note) { const n = document.createElement("p"); n.className = "tour-note"; n.textContent = p.note; wrap.append(n); }
      if (p.go && opts.openAccount) {
        const g = document.createElement("button"); g.type = "button"; g.className = "btn small tour-go"; g.textContent = "Open " + p.go;
        g.onclick = () => { done("go"); opts.openAccount(); };
        wrap.append(g);
      }
      const dots = document.createElement("div"); dots.className = "tour-dots";
      PAGES.forEach((_, n) => { const s = document.createElement("span"); if (n === i) s.className = "on"; dots.append(s); });
      const act = document.createElement("div"); act.className = "modal-actions";
      const skip = document.createElement("button"); skip.type = "button"; skip.className = "btn"; skip.textContent = last ? "Close" : "Skip"; skip.onclick = () => done("skip");
      if (i > 0) { const b = document.createElement("button"); b.type = "button"; b.className = "btn"; b.textContent = "Back"; b.onclick = () => { i--; paint(); }; act.append(b); }
      else act.append(skip);
      const nx = document.createElement("button"); nx.type = "button"; nx.className = "btn primary"; nx.textContent = last ? "Get started" : "Next";
      nx.onclick = () => last ? done("ok") : (i++, paint());
      act.append(nx);
      d.append(wrap, dots, act);
      nx.focus();
    };
    d.addEventListener("cancel", () => { if (opts.uid) mark(opts.uid); });
    d.addEventListener("close", () => { d.remove(); resolve(d.returnValue); });
    paint();
    document.body.append(d);
    d.showModal();
  });
}

/** Shows the tour once for a brand-new account (created in this sign-in); returns true when it was shown. */
export function maybeShowTour(user, opts = {}) {
  if (!user || seen(user.uid)) return false;
  const m = user.metadata || {};
  const created = Date.parse(m.creationTime || ""), last = Date.parse(m.lastSignInTime || "");
  const fresh = opts.force || (created && last && Math.abs(last - created) < 2 * 60 * 1000);
  if (!fresh) return false;
  showTour({ ...opts, uid: user.uid });
  return true;
}
