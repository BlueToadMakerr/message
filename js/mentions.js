// @mentions: finding them in text, drawing them as pills, and the Discord-style picker that opens when you type "@" in the message box.
// A message that mentions people carries `mentions: { <uid>: true }` (plain, even in encrypted chats: the server needs it to know whom to notify).
// Only those people are notified; a message without a mention notifies everyone, as before. "@everyone" is just a highlighted word that notifies everyone.
import { avatarEl } from "./ui.js";

const WORD = /[\p{L}\p{N}_]/u;
const isWord = ch => { try { return !!ch && WORD.test(ch); } catch (_) { return !!ch && /[A-Za-z0-9_]/.test(ch); } };
export const EVERYONE = "everyone";

/** Finds "@Name" tokens. people: [{uid, name}]. Returns [{start, end, uid|null, everyone?}] (non-overlapping, in order). */
export function findMentions(text, people) {
  const out = [], t = String(text || ""), low = t.toLowerCase();
  const names = people.filter(p => p.name).map(p => ({ uid: p.uid, n: p.name.toLowerCase(), len: p.name.length })).sort((a, b) => b.len - a.len);
  let i = 0;
  while ((i = t.indexOf("@", i)) >= 0) {
    const prev = i > 0 ? t[i - 1] : "";
    if (prev && isWord(prev)) { i++; continue; }                         // an e-mail address, not a mention
    let hit = null;
    if (low.startsWith(EVERYONE, i + 1) && !isWord(t[i + 1 + EVERYONE.length])) hit = { uid: null, everyone: true, len: EVERYONE.length };
    else for (const p of names) if (low.startsWith(p.n, i + 1) && !isWord(t[i + 1 + p.len])) { hit = { uid: p.uid, len: p.len }; break; }
    if (hit) { out.push({ start: i, end: i + 1 + hit.len, uid: hit.uid, everyone: !!hit.everyone }); i += 1 + hit.len; } else i++;
  }
  return out;
}

/** What a message being sent should carry: {uids} (notify only these) or {everyone:true} (no filter). */
export function mentionsOf(text, people, me) {
  const found = findMentions(text, people);
  if (found.some(f => f.everyone)) return { uids: [], everyone: true };
  return { uids: [...new Set(found.map(f => f.uid).filter(u => u && u !== me))].slice(0, 20), everyone: false };
}

/** Turns the @name tokens inside a bubble's text into pills. `people` are the names that count (for a received message: the people it mentions). */
export function decorate(bubble, people, me) {
  if (!bubble || !bubble.textContent.includes("@")) return;
  const walker = document.createTreeWalker(bubble, NodeFilter.SHOW_TEXT, { acceptNode: n => n.parentElement && n.parentElement.closest("a, .reply-quote, button, .link-preview, .mention") ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT });
  const nodes = []; while (walker.nextNode()) nodes.push(walker.currentNode);
  for (const node of nodes) {
    const text = node.nodeValue, found = findMentions(text, people);
    if (!found.length) continue;
    const frag = document.createDocumentFragment(); let at = 0;
    for (const f of found) {
      if (f.start > at) frag.append(text.slice(at, f.start));
      const s = document.createElement("span");
      s.className = "mention" + (f.everyone ? " everyone" : "") + (f.uid && f.uid === me ? " me" : "");
      s.textContent = text.slice(f.start, f.end);
      if (f.uid) s.dataset.uid = f.uid;
      frag.append(s); at = f.end;
    }
    if (at < text.length) frag.append(text.slice(at));
    node.replaceWith(frag);
  }
}

/**
 * The picker + the coloured highlight behind the typed @names.
 * opts: { input, people: () => [{uid, name, pfp}], onInsert?: () => void }
 * Returns { refresh() } — call it after the box's value is changed by code.
 */
export function attachMentionBox({ input, people }) {
  const wrap = document.createElement("div");
  wrap.className = "input-wrap";
  input.parentNode.insertBefore(wrap, input);
  wrap.append(input);
  const mirror = document.createElement("div"); mirror.className = "input-mirror"; mirror.setAttribute("aria-hidden", "true"); wrap.append(mirror);
  const pop = document.createElement("div"); pop.className = "mention-pop hidden"; pop.setAttribute("role", "listbox"); wrap.append(pop);

  let items = [], sel = 0, tokenStart = -1;
  const esc = s => String(s).replace(/[&<>]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));

  function paintMirror() {
    const text = input.value, found = findMentions(text, people());
    let html = "", at = 0;
    for (const f of found) { html += esc(text.slice(at, f.start)) + '<mark class="' + (f.everyone ? "everyone" : "") + '">' + esc(text.slice(f.start, f.end)) + "</mark>"; at = f.end; }
    html += esc(text.slice(at)) + "\n";
    mirror.innerHTML = html;
    mirror.style.paddingRight = "calc(.95rem + " + Math.max(0, input.offsetWidth - input.clientWidth - 2) + "px)";      // a scrollbar narrows the text area: wrap the same way
    mirror.scrollTop = input.scrollTop;
  }

  function close() { pop.classList.add("hidden"); pop.replaceChildren(); items = []; tokenStart = -1; input.removeAttribute("aria-activedescendant"); }

  function query() {
    const caret = input.selectionStart, before = input.value.slice(0, caret), at = before.lastIndexOf("@");
    if (at < 0 || input.selectionEnd !== caret) return null;
    if (at > 0 && !/\s/.test(before[at - 1])) return null;
    const q = before.slice(at + 1);
    if (q.length > 30 || /\n/.test(q)) return null;
    return { at, q };
  }

  function open() {
    const k = query();
    if (!k) { close(); return; }
    const q = k.q.toLowerCase(), list = people();
    let hits = list.filter(p => p.name && p.name.toLowerCase().includes(q));
    hits.sort((a, b) => (b.name.toLowerCase().startsWith(q) - a.name.toLowerCase().startsWith(q)) || a.name.localeCompare(b.name));
    items = hits.slice(0, 6).map(p => ({ ...p }));
    if (list.length > 1 && EVERYONE.startsWith(q)) items.push({ uid: null, name: EVERYONE, everyone: true });
    if (!items.length) { close(); return; }
    tokenStart = k.at; sel = Math.min(sel, items.length - 1);
    pop.replaceChildren();
    const head = document.createElement("div"); head.className = "mp-head"; head.textContent = k.q ? 'Members matching "' + k.q + '"' : "Mention someone"; pop.append(head);
    items.forEach((it, i) => {
      const row = document.createElement("div"); row.className = "mp-item" + (i === sel ? " on" : ""); row.id = "mp-" + i; row.setAttribute("role", "option");
      if (it.everyone) { const ic = document.createElement("span"); ic.className = "avatar sm mp-all"; ic.textContent = "@"; row.append(ic); }
      else row.append(avatarEl(it.name, it.pfp || "", "avatar sm"));
      const name = document.createElement("span"); name.className = "mp-name";
      const lo = it.name.toLowerCase(), j = q ? lo.indexOf(q) : -1;
      if (j >= 0) { name.append(it.name.slice(0, j)); const b = document.createElement("b"); b.textContent = it.name.slice(j, j + q.length); name.append(b, it.name.slice(j + q.length)); } else name.textContent = it.name;
      row.append(name);
      if (it.everyone) { const s = document.createElement("small"); s.textContent = "Notify everyone"; row.append(s); }
      row.addEventListener("mousedown", e => { e.preventDefault(); pick(i); });         // mousedown: the box must not lose focus
      row.addEventListener("touchstart", e => { e.preventDefault(); pick(i); }, { passive: false });
      pop.append(row);
    });
    pop.classList.remove("hidden");
    input.setAttribute("aria-activedescendant", "mp-" + sel);
  }

  function pick(i) {
    const it = items[i], k = query(); if (!it || !k) { close(); return; }
    const v = input.value, caret = input.selectionStart, ins = "@" + it.name + " ";
    input.value = v.slice(0, k.at) + ins + v.slice(caret);
    const pos = k.at + ins.length; input.setSelectionRange(pos, pos);
    close(); input.dispatchEvent(new Event("input", { bubbles: true })); input.focus();
  }

  const move = d => { sel = (sel + d + items.length) % items.length; pop.querySelectorAll(".mp-item").forEach((r, i) => r.classList.toggle("on", i === sel)); input.setAttribute("aria-activedescendant", "mp-" + sel); const r = pop.querySelector(".mp-item.on"); r && r.scrollIntoView({ block: "nearest" }); };

  // capture phase: runs before the box's own "Enter sends" handler
  input.addEventListener("keydown", e => {
    if (pop.classList.contains("hidden") || !items.length || e.isComposing) return;
    if (e.key === "ArrowDown") { e.preventDefault(); e.stopImmediatePropagation(); move(1); }
    else if (e.key === "ArrowUp") { e.preventDefault(); e.stopImmediatePropagation(); move(-1); }
    else if (e.key === "Enter" || e.key === "Tab") { e.preventDefault(); e.stopImmediatePropagation(); pick(sel); }
    else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation(); close(); }
  }, true);
  input.addEventListener("input", () => { sel = 0; paintMirror(); open(); });
  input.addEventListener("click", open);
  input.addEventListener("keyup", e => { if (["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)) open(); });
  input.addEventListener("blur", () => setTimeout(close, 120));
  input.addEventListener("scroll", () => { mirror.scrollTop = input.scrollTop; });
  new ResizeObserver(paintMirror).observe(input);
  paintMirror();
  return { refresh() { paintMirror(); close(); } };
}

/**
 * Swipe a message to the right to reply (touch / pen). The row follows the finger, a reply arrow fades in, a tiny buzz marks the point of no return.
 * opts: { container, onReply(el), canReply?(el) }
 */
export function attachSwipeReply({ container, onReply, canReply = () => true, iconHtml = "" }) {
  const TRIGGER = 64, MAX = 110, EDGE = 24;
  let s = null;
  const skip = t => t.closest && t.closest("a, button, audio, video, input, textarea, select, .audio-player, .msg-menu, .media-wrap, .reply-quote");
  container.addEventListener("pointerdown", e => {
    if (e.pointerType === "mouse" || !e.isPrimary) return;
    const el = e.target.closest && e.target.closest(".msg");
    if (!el || skip(e.target) || e.clientX < EDGE || !canReply(el)) return;
    s = { el, id: e.pointerId, x: e.clientX, y: e.clientY, mode: "wait", armed: false, ico: null };
  });
  container.addEventListener("pointermove", e => {
    if (!s || e.pointerId !== s.id) return;
    const dx = e.clientX - s.x, dy = e.clientY - s.y;
    if (s.mode === "wait") {
      if (Math.abs(dy) > 10 && Math.abs(dy) > Math.abs(dx)) { s = null; return; }               // it is a scroll
      if (dx < 10 || Math.abs(dx) < Math.abs(dy) * 1.4) return;                                  // not clearly sideways yet
      s.mode = "drag"; s.el.classList.add("swiping"); s.el.classList.remove("swipe-back");
      s.ico = document.createElement("span"); s.ico.className = "swipe-ico"; s.ico.innerHTML = iconHtml; s.el.append(s.ico);
      try { container.setPointerCapture(e.pointerId); } catch (_) { /* ignore */ }
      try { getSelection().removeAllRanges(); } catch (_) { /* ignore */ }
    }
    const off = dx <= 0 ? 0 : dx < TRIGGER ? dx : Math.min(MAX, TRIGGER + (dx - TRIGGER) * 0.3);
    s.el.style.transform = "translateX(" + off + "px)";
    const k = Math.min(1, off / TRIGGER);
    s.ico.style.opacity = String(k); s.ico.style.transform = "scale(" + (0.5 + 0.5 * k) + ")";
    const armed = dx >= TRIGGER;
    if (armed !== s.armed) { s.armed = armed; s.ico.classList.toggle("armed", armed); if (armed) { try { navigator.vibrate && navigator.vibrate(12); } catch (_) { /* ignore */ } } }
    e.preventDefault();
  });
  const end = (e, cancelled) => {
    if (!s || e.pointerId !== s.id) return;
    const { el, ico, armed, mode } = s; s = null;
    if (mode !== "drag") return;
    el.classList.remove("swiping"); el.classList.add("swipe-back"); el.style.transform = "";
    setTimeout(() => { el.classList.remove("swipe-back"); ico && ico.remove(); }, 260);
    if (armed && !cancelled) onReply(el);
  };
  container.addEventListener("pointerup", e => end(e, false));
  container.addEventListener("pointercancel", e => end(e, true));
  // a swipe must not also count as a tap / long-press on the bubble
  container.addEventListener("click", e => { if (e.target.closest && e.target.closest(".msg.swipe-back")) { e.preventDefault(); e.stopPropagation(); } }, true);
}
