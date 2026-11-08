import { hydrateIcons, toast, confirmDialog, copyText, avatarEl } from "./ui.js";
import { auth } from "./firebase.js";
import { onAuthStateChanged } from "./sdk.js";
import { QM, markReady } from "./embed.js";
import { listBots, createBot, saveBot, regenerateToken, deleteBot, apiBase } from "./bots.js";

hydrateIcons();
const $ = id => document.getElementById(id);
const el = (tag, props = {}, ...kids) => { const e = Object.assign(document.createElement(tag), props); e.append(...kids); return e; };
let me = null, editing = null;                        // editing: bot id, "" for a new one

import("./mode.js").then(m => {
  $("apiUrl").textContent = apiBase();
  $("apiHow").textContent = m.PRIVATE
    ? "Your program sends requests to this address with the header Authorization: Bearer <token>."
    : "Database address. Your program writes its requests into the database (botInbox) with its token, and the worker answers (botOutbox) and passes on new messages (botEvents): nothing to open or expose. docs/bots/qmbot.py is a ready-made client.";
});

/** Shows a token once, with a copy button. Resolves when the person closes it. */
function showToken(title, id, token, again = false) {
  return new Promise(resolve => {
    const dlg = el("dialog", { className: "modal small" }), form = el("form", { method: "dialog" });
    const box = el("pre", { className: "dev-pre", textContent: token, style: "word-break:break-all;white-space:pre-wrap;user-select:all" });
    const copy = el("button", { type: "button", className: "btn", textContent: "Copy token" }); copy.onclick = async () => { await copyText(token); toast("Token copied.", "success", 1500); };
    form.append(el("h2", { textContent: title }),
      el("p", { className: "modal-text", textContent: `Bot id: ${id}\n\nThis is the bot's password. Anyone who has it can post as this bot and read the plain messages in its chats. Only you (its owner) can see it here. If it leaks, make a new one (the old one stops working at once).` }),
      box, el("div", { className: "modal-actions" }, copy, el("button", { type: "submit", className: "btn primary", textContent: "I saved it" })));
    dlg.append(form); document.body.append(dlg);
    dlg.addEventListener("close", () => { dlg.remove(); resolve(); });
    dlg.showModal();
  });
}

async function paint() {
  const box = $("list"); box.replaceChildren();
  let bots = [];
  try { bots = await listBots(me); } catch (e) { box.append(el("p", { className: "plugin-issue error", textContent: "Couldn't load your bots: " + e.message })); }
  $("empty").hidden = bots.length > 0;
  for (const b of bots) {
    const row = el("div", { className: "plugin-row" });
    row.dataset.id = b.id;
    const head = el("div", { className: "row", style: "align-items:center;gap:.6rem" }, avatarEl(b.name, b.pfp || "", "avatar sm"),
      el("span", {}, el("strong", { textContent: b.name }), el("span", { className: "risk-badge", textContent: "BOT", style: "margin-left:.4rem" }), el("br"), el("small", { className: "muted", textContent: b.id + (b.webhook ? " · webhook on" : "") })));
    row.append(head);
    const btns = el("div", { className: "row wrap", style: "margin-top:.4rem" });
    const add = (t, fn, cls = "") => { const x = el("button", { type: "button", className: "btn small " + cls, textContent: t }); x.onclick = fn; btns.append(x); };
    add("Copy id", async () => { await copyText(b.id); toast("Bot id copied.", "success", 1500); });
    if (b.token) add("Show token", () => showToken("Token", b.id, b.token, true));
    else row.append(el("div", { className: "plugin-issue warn", role: "alert", textContent: "This bot was made before bots talked through the database. Press “New token” to get a token that works." }));
    add("Edit", () => openEditor(b));
    add("New token", async () => {
      if (!await confirmDialog({ title: "Make a new token?", message: "The old token stops working immediately. Update your program with the new one.", okText: "Make new token", danger: true })) return;
      try { await showToken("New token", b.id, await regenerateToken(b.id)); } catch (e) { toast(e.message, "error"); }
    });
    add("Delete", async () => {
      if (!await confirmDialog({ title: "Delete this bot?", message: `“${b.name}” and its token are removed for good. Its old messages stay in the chats. (You may want to remove it from chats too.)`, okText: "Delete", danger: true })) return;
      try { await deleteBot(me, b.id); toast("Bot deleted.", "success", 1500); paint(); } catch (e) { toast("Couldn't delete: " + e.message, "error"); }
    }, "danger");
    row.append(btns); box.append(row);
  }
}
function openEditor(b) {
  editing = b ? b.id : "";
  $("edTitle").textContent = b ? "Edit bot" : "New bot";
  $("edName").value = b?.name || ""; $("edPfp").value = b?.pfp || ""; $("edHook").value = b?.webhook || ""; $("edErr").textContent = "";
  $("edHookRow").hidden = $("edHookHelp").hidden = !b;                 // a webhook is set after the bot exists
  $("editor").classList.remove("hidden"); $("editor").scrollIntoView({ block: "start" });
}
$("newBtn").onclick = () => openEditor(null);
$("edCancel").onclick = () => { $("editor").classList.add("hidden"); editing = null; };
$("edSave").onclick = async () => {
  $("edErr").textContent = "";
  try {
    if (editing) { await saveBot(editing, { name: $("edName").value, pfp: $("edPfp").value, webhook: $("edHook").value }); toast("Saved.", "success", 1500); }
    else {
      const r = await createBot(me, $("edName").value, $("edPfp").value);
      $("editor").classList.add("hidden"); editing = null; await paint();
      await showToken("Bot created", r.id, r.token); return;
    }
    $("editor").classList.add("hidden"); editing = null; paint();
  } catch (e) { $("edErr").textContent = e.message || "That didn't work."; }
};
onAuthStateChanged(auth, u => { me = u && u.uid; if (me) paint(); });
markReady();
