// "Start sharing" dialog: shows the sending settings for THIS share (prefilled from Account → Screen sharing) and a Start button.
import { PRESETS, RES, getScreenPrefs, setScreenPrefs, storedScreenPrefs, setScreenOverride, DEFAULTS } from "../screenprefs.js";
import { confirmDialog } from "../ui.js";
import { screenHelpNode } from "../screenhelp.js";

const opt = (v, t) => `<option value="${v}">${t}</option>`;

/** @returns {Promise<boolean>} true when the person pressed "Start sharing" (the chosen settings are then active for this share). */
export async function askScreenSettings() {
  const stored = { ...DEFAULTS, ...storedScreenPrefs() };
  const p = { ...getScreenPrefs() };
  const isApp = !!(window.QMApp && window.QMApp.startScreen);
  const box = document.createElement("div"); box.className = "stack share-settings";
  box.innerHTML = `
    <small class="muted">Quality for this share. Higher settings use more bandwidth, CPU and battery.</small>
    <label class="lbl">Preset</label><select class="field" data-k="preset">${Object.entries(PRESETS).map(([k, v]) => opt(k, v.label)).join("")}${opt("custom", "Custom")}</select>
    ${isApp ? "" : `<label class="lbl">Resolution</label><select class="field" data-k="res">${Object.entries(RES).map(([k, v]) => opt(k, v)).join("")}</select>`}
    ${isApp ? `<label class="lbl">Largest side</label><select class="field" data-k="res">${Object.entries(RES).map(([k, v]) => opt(k, v)).join("")}</select>
    <label class="lbl">Picture quality: <span data-o="jpeg"></span>%</label><input type="range" min="30" max="95" data-k="jpeg">
    <label class="lbl">Frames per second: <span data-o="afps"></span></label><input type="range" min="1" max="30" data-k="afps">`
    : `<label class="lbl">Frame rate: <span data-o="fps"></span> fps</label><input type="range" min="1" max="60" data-k="fps">
    <label class="lbl">Maximum bitrate (kbps, 0 = automatic)</label><input class="field" type="number" min="0" max="50000" step="100" data-k="bitrate">
    <label class="lbl">Optimise for</label><select class="field" data-k="hint">${opt("detail", "Sharp text and detail")}${opt("motion", "Smooth motion")}${opt("text", "Text")}${opt("auto", "Let the browser decide")}</select>
    <label class="switch-row"><input type="checkbox" data-k="audio"> <span>Share sound too</span></label>`}
    <label class="switch-row"><input type="checkbox" data-k="save"> <span>Save these as my defaults</span></label>`;
  const $ = k => box.querySelector(`[data-k="${k}"]`);
  box.insertBefore(screenHelpNode(isApp), $("save").closest("label"));
  const num = ["fps", "bitrate", "jpeg", "afps"];
  const paint = () => {
    $("preset").value = p.preset in PRESETS ? p.preset : "custom";
    for (const k of ["res", "fps", "bitrate", "hint", "jpeg", "afps"]) if ($(k)) $(k).value = p[k];
    if ($("audio")) $("audio").checked = !!p.audio;
    for (const k of ["fps", "jpeg", "afps"]) { const o = box.querySelector(`[data-o="${k}"]`); if (o) o.textContent = p[k]; }
  };
  box.addEventListener("input", e => {
    const k = e.target.dataset && e.target.dataset.k; if (!k || k === "save") return;
    if (k === "preset") { if (e.target.value !== "custom") Object.assign(p, PRESETS[e.target.value], { preset: e.target.value }); }
    else { p[k] = e.target.type === "checkbox" ? e.target.checked : num.includes(k) ? Number(e.target.value) : e.target.value; p.preset = "custom"; }
    paint();
  });
  paint();
  const go = await confirmDialog({ title: "Start sharing your screen", node: box, okText: "Start sharing", cancelText: "Cancel" });
  if (!go) return false;
  const { label, ...clean } = p;
  if ($("save").checked) { setScreenPrefs({ ...stored, ...clean }); setScreenOverride(null); }
  else setScreenOverride({ ...stored, ...clean });
  return true;
}
