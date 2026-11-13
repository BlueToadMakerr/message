// First-login welcome tour. Short, visual and hands-on: a dummy app and chat to try things in, and real controls for the things you can change
// (name, picture, colours, privacy: these really save). "Skip tour" closes everything; "Skip this demo" jumps to the next page.
// It appears once for a brand-new account (per device) and can be opened again from Account → Welcome tour.
import { icon, avatarEl, toast } from "./ui.js";
import { db } from "./firebase.js";
import { ref, update } from "./sdk.js";
import { getProfile, invalidateProfile } from "./users.js";
import { applyTheme, getTheme, ACCENT_PRESETS, getAppearance, setAppearance } from "./theme.js";
import { previewsOn, setPreviews } from "./linkpreview.js";

const KEY = uid => "qm-tour-" + uid;
const seen = uid => { try { return localStorage.getItem(KEY(uid)) === "1"; } catch (_) { return false; } };
const mark = uid => { try { localStorage.setItem(KEY(uid), "1"); } catch (_) { /* ignore */ } };

const h = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
const btn = (cls, text, fn) => { const b = h("button", cls, text); b.type = "button"; if (fn) b.onclick = fn; return b; };
/** A pointer label: "text" with an arrow towards the thing it explains (dir: up | down | left | right). */
const call = (text, dir = "up") => h("span", "tcall tc-" + dir, text);
const para = text => h("p", "", text);

/** The little "things to try" list: tick(name) ticks one off. */
function tasks(list) {
  const box = h("ul", "ttasks"), items = {};
  for (const [k, label] of list) { const li = h("li", "", label); items[k] = li; box.append(li); }
  return { box, tick: k => items[k] && items[k].classList.add("done") };
}

// ------------------------------------------------------------------ pages
function pWelcome() {
  const w = h("div", "tour-page");
  const ic = h("div", "tour-ico"); ic.innerHTML = icon("chat", 30);
  w.append(ic, h("h2", "", "Welcome to QuickMessage"),
    para("A small, fast chat app: messages, voice and video calls, screen sharing and file sharing."),
    para("This tour is hands-on: you'll try a dummy chat, and the settings you change really are saved. You can skip a demo, or the whole tour, at any time."),
    h("p", "tour-note", "Heads up: QuickMessage was designed and written entirely with AI. It's an independent project, so rough edges are possible."));
  return { node: w };
}

function pWhere(ctx) {
  const w = h("div", "tour-page");
  w.append(h("h2", "", "Finding your way"), para("This is the main screen. Tap the highlighted spots to see what they do."));
  const phone = h("div", "tmock");
  const head = h("div", "tm-head");
  head.append(h("strong", "", "QuickMessage"), h("span", "grow"));
  const av = h("button", "tm-av tpulse"); av.type = "button"; av.textContent = "Y"; av.setAttribute("aria-label", "Account");
  head.append(av);
  const list = h("div", "tm-list");
  for (const [n, t] of [["Sam", "Hey! Want to call later?"], ["Team", "Alex: files are uploaded 📎"]]) {
    const r = h("div", "tm-chat"); const a = h("span", "tm-avatar", n[0]); const b = h("div", "tm-chat-b"); b.append(h("strong", "", n), h("small", "", t)); r.append(a, b); list.append(r);
  }
  const fab = h("button", "tm-fab tpulse", "+ New chat"); fab.type = "button";
  phone.append(head, list, fab);
  const tip = h("div", "tour-tip", "Tap a highlighted spot.");
  const T = tasks([["acc", "Tap your picture (top right)"], ["new", "Tap “+ New chat”"]]);
  av.onclick = () => { tip.textContent = "Your picture opens Account: your profile, colours, privacy, encryption, notifications and more."; T.tick("acc"); };
  fab.onclick = () => { tip.textContent = "Start a chat by pasting a friend's friend code (they find it on their Account page) or their email address."; T.tick("new"); };
  const cA = call("Account & settings", "left"); cA.classList.add("c-acc");
  const cN = call("Start a chat", "down"); cN.classList.add("c-new");
  phone.append(cA, cN);
  w.append(phone, T.box, tip);
  return { node: w };
}

function pChat() {
  const w = h("div", "tour-page");
  w.append(h("h2", "", "A chat, up close"), para("This is a dummy chat: nothing is sent to anyone."));
  const phone = h("div", "tmock tall");
  const head = h("div", "tm-head");
  const call_ = btn("tm-ico tpulse", "", null); call_.innerHTML = icon("phone", 16); call_.setAttribute("aria-label", "Call");
  const lock = btn("tm-ico", "", null); lock.innerHTML = icon("lock", 16); lock.setAttribute("aria-label", "Encryption");
  head.append(h("span", "tm-avatar", "S"), h("strong", "", "Sam (demo)"), h("span", "grow"), lock, call_);
  const msgs = h("div", "tm-msgs");
  const bubble = (txt, own) => { const b = h("div", "tm-bub" + (own ? " own" : ""), txt); msgs.append(b); msgs.scrollTop = msgs.scrollHeight; return b; };
  bubble("Hey! 👋 Welcome to QuickMessage.", false);
  bubble("Try sending me something below.", false);
  const sheet = h("div", "tm-sheet hidden");
  const comp = h("div", "tm-comp");
  const att = btn("tm-ico tpulse", "", null); att.innerHTML = icon("image", 16); att.setAttribute("aria-label", "Attach");
  const input = h("input", "tm-input"); input.placeholder = "Type a message…"; input.maxLength = 120;
  const send = btn("tm-send", "Send");
  comp.append(att, input, send);
  const tip = h("div", "tour-tip", "Go on, try the highlighted buttons and send a message.");
  const T = tasks([["send", "Send a message"], ["attach", "Tap the attach button"], ["call", "Tap the call button"], ["lock", "Tap the lock"], ["menu", "Tap a message to see its options"]]);
  const sendIt = () => {
    const t = input.value.trim(); if (!t) return;
    bubble(t, true); input.value = ""; T.tick("send");
    setTimeout(() => bubble(["Got it! ✅", "Nice 🙂", "That arrived instantly.", "Looks great!"][Math.floor(Math.random() * 4)], false), 700);
  };
  send.onclick = sendIt; input.addEventListener("keydown", e => { if (e.key === "Enter") { e.preventDefault(); sendIt(); } });
  att.onclick = () => {
    sheet.classList.toggle("hidden"); sheet.replaceChildren();
    for (const [i, t] of [["image", "Choose a file"], ["camera", "Camera: photo or video"], ["mic", "Record audio"]]) { const r = h("div", "tm-sheet-row"); r.innerHTML = icon(i, 16); r.append(h("span", "", t)); sheet.append(r); }
    tip.textContent = "Attach photos, videos and any file, take a photo or video, or record audio. Small ones go inside the chat; big ones are uploaded to a free file host (you choose which in Account → File hosting). You're asked to confirm before anything is sent.";
    T.tick("attach");
  };
  call_.onclick = () => { tip.textContent = "Start a voice or video call, share your screen, and keep browsing other chats while it runs. A bar at the top lets you jump back."; T.tick("call"); };
  lock.onclick = () => { tip.textContent = "Chats can be end-to-end encrypted (chat options → Encryption). The lock marks encrypted messages."; T.tick("lock"); };
  msgs.addEventListener("click", e => {
    const b = e.target.closest(".tm-bub"); if (!b) return;
    msgs.querySelectorAll(".tm-pop").forEach(x => x.remove());
    const pop = h("div", "tm-pop"); pop.append(h("span", "", "Reply"), h("span", "", "Info"), h("span", "", "Delete"));
    b.after(pop); T.tick("menu");
    tip.textContent = "Each message has its own menu: reply, see who read it and when, copy, delete. Your own messages can be deleted for everyone.";
  });
  const c1 = call("Attach / camera / voice", "down"); c1.classList.add("c-att");
  const c2 = call("Call", "up"); c2.classList.add("c-call");
  phone.append(head, msgs, sheet, comp, c1, c2);
  w.append(phone, T.box, tip);
  return { node: w };
}

function pProfile(ctx) {
  const w = h("div", "tour-page");
  w.append(h("h2", "", "Make it yours"), para("These really save: change them here, or later in Account."));
  const row = h("div", "tp-row");
  const avHost = h("div", "tp-av");
  const name = h("input", "field"); name.maxLength = 40; name.placeholder = "Display name";
  const pfp = h("input", "field"); pfp.type = "url"; pfp.placeholder = "Profile picture URL (optional)";
  const fields = h("div", "tp-fields"); fields.append(h("label", "lbl", "Display name"), name, h("label", "lbl", "Profile picture"), pfp);
  row.append(avHost, fields);
  const theme = h("select", "field"); for (const [v, t] of [["system", "Match my device"], ["light", "Light"], ["dark", "Dark"]]) theme.append(new Option(t, v));
  theme.value = getTheme();
  const sw = h("div", "swatches");
  const cur = () => getAppearance().accent || "";
  const paintSw = () => sw.querySelectorAll(".swatch").forEach(b => b.classList.toggle("on", b.dataset.c === cur()));
  for (const c of ACCENT_PRESETS) { const b = h("button", "swatch"); b.type = "button"; b.style.background = c; b.dataset.c = c; b.setAttribute("aria-label", "Accent " + c); b.onclick = () => { setAppearance({ accent: c }); paintSw(); saved("Colour saved on this device"); }; sw.append(b); }
  const status = h("div", "tour-tip tp-status", "");
  const saved = t => { status.textContent = "✓ " + t; };
  const paintAv = () => avHost.replaceChildren(avatarEl(name.value.trim() || "You", pfp.value.trim(), "avatar"));
  let t = 0;
  const saveProfile = async () => {
    const dn = name.value.trim(); if (!dn) return;
    try { await update(ref(db, `accsettings/${ctx.uid}/settings`), { displayName: dn.slice(0, 40), pfp: pfp.value.trim().slice(0, 2000), theme: theme.value }); invalidateProfile(ctx.uid); saved("Profile saved"); }
    catch (_) { status.textContent = "Couldn't save that right now. You can set it in Account later."; }
  };
  const later = () => { clearTimeout(t); t = setTimeout(saveProfile, 600); };
  name.oninput = () => { paintAv(); later(); }; pfp.oninput = () => { paintAv(); later(); };
  theme.onchange = () => { applyTheme(theme.value); saveProfile(); };
  ctx.onLeave = () => { clearTimeout(t); saveProfile(); };
  getProfile(ctx.uid).then(p => { name.value = p.displayName === "Unknown user" ? "" : p.displayName; pfp.value = p.pfp || ""; paintAv(); });
  paintAv(); paintSw();
  w.append(row, h("label", "lbl", "Appearance"), theme, h("label", "lbl", "Accent colour"), sw, status,
    para("In Account → Colours you can also pick a midnight dark theme, your own colours for every part of the app, and (on Android) your phone's Material You colours."));
  return { node: w };
}

function pPrivacy(ctx) {
  const w = h("div", "tour-page");
  w.append(h("h2", "", "Your privacy, your choice"), para("Your email is never shown to anyone. These two switches really save:"));
  const status = h("div", "tour-tip", "");
  const slot = h("div");                  // the email switch goes here once the profile has loaded
  w.append(slot);
  const row = (title, sub, on, fn) => {
    const l = h("label", "switch-row"); const c = h("input"); c.type = "checkbox"; c.checked = on; c.onchange = () => fn(c.checked);
    const s = h("span"); const b = h("strong", "", title); s.append(b, h("br"), h("small", "muted", sub)); l.append(c, s); return l;
  };
  getProfile(ctx.uid).then(p => {
    slot.append(row("Let people add me by email", "When this is off, people need your friend code (it's on your Account page) to start a chat with you.", p.emailAdd !== false, async v => {
      try { await update(ref(db, `accsettings/${ctx.uid}/settings`), { emailAdd: v }); invalidateProfile(ctx.uid); status.textContent = v ? "✓ People can add you by email." : "✓ People need your friend code to add you."; } catch (_) { status.textContent = "Couldn't save that right now."; }
    }));
  });
  w.append(row("Link previews", "Shows what a link is (title, picture, video). Fetching one asks this site's server to open the link, so turn it off if you prefer.", previewsOn(), v => { setPreviews(v); status.textContent = v ? "✓ Link previews on." : "✓ Link previews off."; }), status,
    para("Everything else about privacy (who can see your name and picture) is in Account → Privacy."));
  return { node: w };
}

function pEncrypt(ctx) {
  const w = h("div", "tour-page");
  w.append(h("h2", "", "Message encryption"), para("Each chat can be end-to-end encrypted. See what that means:"));
  const flow = h("div", "tflow");
  const a = h("div", "tf-box", "You type"); const m1 = h("div", "tf-box tf-lock"); m1.innerHTML = icon("lock", 18); m1.append(h("small", "", "scrambled on your device"));
  const srv = h("div", "tf-box tf-srv", "Server sees only scrambled data"); const m2 = h("div", "tf-box tf-lock"); m2.innerHTML = icon("lock", 18); m2.append(h("small", "", "unscrambled on theirs"));
  const b = h("div", "tf-box", "They read");
  flow.append(a, h("span", "tf-arrow", "→"), m1, h("span", "tf-arrow", "→"), srv, h("span", "tf-arrow", "→"), m2, h("span", "tf-arrow", "→"), b);
  const tip = h("div", "tour-tip", "Tap a box.");
  flow.addEventListener("click", e => {
    const x = e.target.closest(".tf-box"); if (!x) return;
    tip.textContent = x === a ? "Messages, images, audio and files are encrypted with a key only the chat's members hold." : x.classList.contains("tf-srv") ? "Not encrypted: chat names and photos, who is in a chat, and message times. Notifications for encrypted chats may just say “New message”." : "Only people in the chat have the key, so only they can read it.";
  });
  const steps = h("ol", "tsteps");
  for (const t of ["Open a chat, then its ⋯ menu → Options → Encryption to switch it on.", "Save your recovery code (Account → Encryption → Show recovery code). It's the only way to unlock encrypted chats on a new device.", "Lose the code and every device and old encrypted messages can't be read by anyone."]) steps.append(h("li", "", t));
  w.append(flow, tip, steps);
  if (ctx.openAccount) { const g = btn("btn small tour-go", "Open Account → Encryption", () => { ctx.finish("go"); ctx.openAccount(); }); w.append(g); }
  return { node: w };
}

function pFind() {
  const w = h("div", "tour-page");
  const ic = h("div", "tour-ico"); ic.innerHTML = icon("search", 30);
  w.append(ic, h("h2", "", "Find, pin and mute"));
  const list = h("div", "tfind");
  for (const [t, d] of [
    ["Search", "In a chat, tap the magnifier at the top: it opens one menu with two tabs, Search and Settings (tapping the chat's name opens Settings). The search box searches the people in the chat, its pins, every photo, video, audio and file, and the messages. Use the tabs (People, Pins, Photos…) to browse one kind. Older history is only fetched when you scroll to the end of the results, so it stays light on data."],
    ["Pins", "Open a message's menu and choose Pin. It is pinned for everyone in the chat: it shows at the top of the chat and in the Pins tab. Choose Unpin to remove it."],
    ["Mute", "Chat menu → Settings → Notifications. Pick messages, calls or both, and for how long (an hour, a day, a week, until you turn it off, or your own time). It holds on all your devices."],
    ["Files", "Tap the paperclip to add several photos or files above the message box, write a message, and send everything at once. Text and code files open in a built-in viewer with colours."]
  ]) { const r = h("div", "tfind-row"); r.append(h("strong", "", t), h("p", "", d)); list.append(r); }
  w.append(list);
  return { node: w };
}

function pEnd() {
  const w = h("div", "tour-page");
  const ic = h("div", "tour-ico"); ic.innerHTML = icon("phone", 30);
  w.append(ic, h("h2", "", "Calls, files and notifications"),
    para("Start a voice or video call from any chat, share your screen, and keep browsing while a call runs."),
    para("Big files are uploaded to a free file host and expire after a while. Uploads carry on even if you leave the chat, and the chat list shows which chats are still uploading."),
    para("Turn on notifications (the bell) to hear about messages and calls when the app isn't open."),
    para("Got an idea? Account → Suggest a feature goes straight to the developer's email. You can reopen this tour from Account → Welcome tour."));
  const src = h("a", "", "QuickMessage is open source: view the code on GitHub"); src.href = "https://github.com/BlueToadMakerr/message"; src.target = "_blank"; src.rel = "noopener noreferrer"; src.style.display = "block"; src.style.marginTop = ".6rem";
  w.append(src);
  return { node: w };
}

const PAGES = [
  { fn: pWelcome }, { fn: pWhere, demo: true }, { fn: pChat, demo: true }, { fn: pProfile, demo: true, needsUser: true }, { fn: pPrivacy, demo: true, needsUser: true }, { fn: pFind }, { fn: pEncrypt, demo: true }, { fn: pEnd }
];

/** Opens the tour. opts.uid: marks it seen and lets the profile / privacy demos save; opts.openAccount(): the buttons that jump to Account. */
export function showTour(opts = {}) {
  return new Promise(resolve => {
    const pages = PAGES.filter(p => !p.needsUser || opts.uid);
    const d = document.createElement("dialog");
    d.className = "modal tour";
    d.setAttribute("aria-label", "Welcome tour");
    let i = 0, ctx = null;
    const finish = why => { try { ctx && ctx.onLeave && ctx.onLeave(); } catch (_) { /* ignore */ } if (opts.uid) mark(opts.uid); d.close(why); };
    const go = n => { try { ctx && ctx.onLeave && ctx.onLeave(); } catch (_) { /* ignore */ } i = n; paint(); };
    const paint = () => {
      const p = pages[i], last = i === pages.length - 1;
      ctx = { uid: opts.uid, openAccount: opts.openAccount, finish, onLeave: null };
      d.replaceChildren();
      const body = h("div", "modal-body tour-body");
      const top = h("div", "tour-top");
      top.append(h("span", "tour-step", `${i + 1} / ${pages.length}`), h("span", "grow"), btn("link-btn tour-skipall", "Skip tour", () => finish("skip")));
      const page = p.fn(ctx).node;
      const dots = h("div", "tour-dots"); pages.forEach((_, n) => { const s = h("span"); if (n === i) s.className = "on"; dots.append(s); });
      const act = h("div", "modal-actions tour-actions");
      if (i > 0) act.append(btn("btn", "Back", () => go(i - 1)));
      act.append(h("span", "grow"));
      if (p.demo) act.append(btn("btn tour-skipdemo", "Skip this demo", () => go(i + 1)));
      act.append(btn("btn primary", last ? "Get started" : "Next", () => last ? finish("ok") : go(i + 1)));
      body.append(top, page, dots, act);
      d.append(body);
    };
    d.addEventListener("cancel", () => { try { ctx && ctx.onLeave && ctx.onLeave(); } catch (_) { /* ignore */ } if (opts.uid) mark(opts.uid); });
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
