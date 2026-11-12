// Text / code files that travel inside the message itself (a data link), a built-in viewer and light syntax colouring.
import { icon } from "./ui.js";

export const MAX_TEXT_BYTES = 400 * 1024;           // bigger text files go to the file host like any other file
const EXT = {
  js: "js", mjs: "js", cjs: "js", jsx: "js", ts: "js", tsx: "js", json: "json", py: "py", rb: "py", sh: "sh", bash: "sh", zsh: "sh", ps1: "sh", bat: "sh",
  html: "html", htm: "html", xml: "html", svg: "html", vue: "html", css: "css", scss: "css", less: "css",
  java: "c", kt: "c", c: "c", h: "c", cpp: "c", hpp: "c", cc: "c", cs: "c", go: "c", rs: "c", swift: "c", php: "c", dart: "c", scala: "c",
  sql: "sql", yml: "yaml", yaml: "yaml", toml: "yaml", ini: "yaml", cfg: "yaml", conf: "yaml", env: "yaml", md: "md", txt: "txt", log: "txt", csv: "txt", tsv: "txt", rtf: "txt"
};
export const extOf = n => (/\.([A-Za-z0-9]+)$/.exec(n || "") || [])[1]?.toLowerCase() || "";
export const langOf = n => EXT[extOf(n)] || "txt";
export const isTextFile = f => { const t = f.type || ""; return /^text\//.test(t) || /json|xml|javascript|x-sh|x-python|yaml/.test(t) || (!!EXT[extOf(f.name)] && !/^(image|video|audio)\//.test(t)); };

const KW = {
  js: "async await break case catch class const continue default delete do else export extends finally for from function if import in instanceof let new of return static super switch this throw try typeof var void while yield true false null undefined",
  py: "and as assert async await break class continue def del elif else except finally for from global if import in is lambda None not or pass raise return try while with yield True False self end begin module unless then puts",
  c: "abstract bool break case catch char class const continue default do double else enum extends false final finally float for fn func go if implements import int interface let long mut namespace new null nil override package private protected public return self short static string struct super switch this throw trait true try type use val var void while where impl pub mod match echo",
  sh: "if then else elif fi for while do done case esac function in echo exit export local return set unset cd ls rm cp mv mkdir cat grep sudo",
  sql: "select from where insert into values update set delete create table drop alter add join left right inner outer on group by order having limit as and or not null primary key index distinct union like in is",
  css: "", html: "", json: "true false null", yaml: "true false null yes no", md: "", txt: ""
};
const COMMENT = { js: "//", c: "//", py: "#", sh: "#", yaml: "#", sql: "--", css: "", html: "", json: "", md: "", txt: "" };
const esc = s => s.replace(/[&<>]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));

/** One line → HTML with <span class="tk-…"> colours. Always escaped first, never trusts the file. */
export function colorLine(line, lang) {
  if (lang === "txt") return esc(line);
  const kw = new Set((KW[lang] || "").split(" ").filter(Boolean));
  const c = COMMENT[lang] || "";
  let out = "", i = 0;
  const n = line.length;
  while (i < n) {
    const ch = line[i], rest = line.slice(i);
    if (lang === "md" && i === 0 && /^(#{1,6}\s|[-*]\s|>\s)/.test(line)) return `<span class="tk-k">${esc(line)}</span>`;
    if (c && rest.startsWith(c)) { out += `<span class="tk-c">${esc(rest)}</span>`; break; }
    if (lang === "html" && rest.startsWith("<!--")) { const e = line.indexOf("-->", i); const t = e < 0 ? rest : line.slice(i, e + 3); out += `<span class="tk-c">${esc(t)}</span>`; i += t.length; continue; }
    if (lang === "css" && rest.startsWith("/*")) { const e = line.indexOf("*/", i); const t = e < 0 ? rest : line.slice(i, e + 2); out += `<span class="tk-c">${esc(t)}</span>`; i += t.length; continue; }
    if (ch === '"' || ch === "'" || ch === "`") {
      let j = i + 1; while (j < n && line[j] !== ch) { if (line[j] === "\\") j++; j++; }
      const t = line.slice(i, Math.min(n, j + 1)); out += `<span class="tk-s">${esc(t)}</span>`; i += t.length; continue;
    }
    if (lang === "html" && ch === "<") { const m = /^<\/?[A-Za-z][\w:-]*/.exec(rest); if (m) { out += `<span class="tk-k">${esc(m[0])}</span>`; i += m[0].length; continue; } }
    if (/\d/.test(ch) && !/\w/.test(line[i - 1] || "")) { const m = /^\d[\d_.]*(?:e[+-]?\d+)?|^0x[\da-f]+/i.exec(rest); out += `<span class="tk-n">${esc(m[0])}</span>`; i += m[0].length; continue; }
    if (/[A-Za-z_$]/.test(ch)) {
      const m = /^[\w$-]+/.exec(rest)[0], w = lang === "sql" ? m.toLowerCase() : m;
      if (kw.has(w)) out += `<span class="tk-k">${esc(m)}</span>`;
      else if (lang === "css" && /^\s*:/.test(rest.slice(m.length))) out += `<span class="tk-k">${esc(m)}</span>`;
      else if ((lang === "json" || lang === "yaml") && /^\s*:/.test(rest.slice(m.length))) out += `<span class="tk-f">${esc(m)}</span>`;
      else if (/^\s*\(/.test(rest.slice(m.length)) && lang !== "css") out += `<span class="tk-f">${esc(m)}</span>`;
      else out += esc(m);
      i += m.length; continue;
    }
    out += esc(ch); i++;
  }
  return out;
}

/** data:...;base64,xxxx (or plain text) → the text. */
export function textOfData(content) {
  const s = String(content || "");
  const m = /^data:[^,]*?(;base64)?,/i.exec(s);
  if (!m) return s;
  const body = s.slice(m[0].length);
  if (!m[1]) { try { return decodeURIComponent(body); } catch (_) { return body; } }
  const bin = atob(body), bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder("utf-8").decode(bytes);
}

let dlg = null;
/** The built-in viewer: line numbers, colours, copy and download. */
export function openCode({ name, content, text, lang }) {
  const body = text != null ? text : textOfData(content);
  lang = lang || langOf(name);
  if (!dlg) {
    dlg = document.createElement("dialog"); dlg.className = "modal code-dialog";
    dlg.innerHTML = `<div class="modal-body"><div class="modal-head"><h2 class="cv-name"></h2><button type="button" class="icon-btn cv-close" aria-label="Close">${icon("close", 20)}</button></div><div class="cv-meta muted"></div><div class="cv-scroll"><pre class="cv-pre"></pre></div><div class="row"><button type="button" class="btn grow cv-copy">Copy</button><button type="button" class="btn grow cv-dl">Download</button></div></div>`;
    document.body.append(dlg);
    dlg.querySelector(".cv-close").onclick = () => dlg.close();
    dlg.addEventListener("click", e => { if (e.target === dlg) dlg.close(); });
  }
  dlg.querySelector(".cv-name").textContent = name || "Text file";
  const lines = body.split("\n"), shown = lines.slice(0, 5000);
  dlg.querySelector(".cv-meta").textContent = `${lines.length} line${lines.length === 1 ? "" : "s"}${lines.length > 5000 ? " (first 5000 shown)" : ""} · ${lang}`;
  const pre = dlg.querySelector(".cv-pre");
  pre.innerHTML = shown.map((l, i) => `<span class="cv-ln"><i>${i + 1}</i>${colorLine(l.replace(/\r$/, ""), lang) || " "}</span>`).join("");
  dlg.querySelector(".cv-copy").onclick = async () => { try { await navigator.clipboard.writeText(body); dlg.querySelector(".cv-copy").textContent = "Copied"; setTimeout(() => { dlg.querySelector(".cv-copy").textContent = "Copy"; }, 1200); } catch (_) {} };
  dlg.querySelector(".cv-dl").onclick = () => {
    const u = URL.createObjectURL(new Blob([body], { type: "text/plain" })), a = document.createElement("a");
    a.href = u; a.download = name || "file.txt"; document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(u), 2000);
  };
  dlg.showModal();
}
