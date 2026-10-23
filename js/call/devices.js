// Audio devices and microphone volume. Saved per device in localStorage so Account → Audio and the in-call audio dialog share one setting.
import { audioCtx } from "./audio.js";
const K = { mic: "qm-mic-dev", spk: "qm-spk-dev", vol: "qm-mic-vol", appIn: "qm-app-in", appOut: "qm-app-out" };
const get = k => { try { return localStorage.getItem(k) || ""; } catch (_) { return ""; } };
const put = (k, v) => { try { v === "" || v == null ? localStorage.removeItem(k) : localStorage.setItem(k, String(v)); } catch (_) { /* ignore */ } };

/** { mic: deviceId|"", spk: deviceId|"", micVol: 0…2 (1 = unchanged) } */
export function audioPrefs() {
  const v = Number(get(K.vol));
  return { mic: get(K.mic), spk: get(K.spk), appIn: get(K.appIn), appOut: get(K.appOut), micVol: Number.isFinite(v) && get(K.vol) !== "" ? Math.max(0, Math.min(200, v)) / 100 : 1 };
}
export function setAudioPrefs({ mic, spk, micVolPct, appIn, appOut }) {
  if (appIn !== undefined) put(K.appIn, appIn);
  if (appOut !== undefined) put(K.appOut, appOut);
  if (mic !== undefined) put(K.mic, mic);
  if (spk !== undefined) put(K.spk, spk);
  if (micVolPct !== undefined) put(K.vol, micVolPct === 100 ? "" : micVolPct);
}
/** The Android app lists and routes audio devices itself (QMApp.audioDevices / setAudioInput / setAudioOutput); null in a normal browser. */
export function nativeAudio() {
  try { return window.QMApp && typeof window.QMApp.audioDevices === "function" ? JSON.parse(window.QMApp.audioDevices()) : null; } catch (_) { return null; }
}
/** Tell Android where to send / take the call's sound (saved choice). Safe to call repeatedly. */
export function applyNativeAudio() {
  const q = window.QMApp, p = audioPrefs();
  try { if (q && q.setAudioInput && p.appIn) q.setAudioInput(p.appIn); } catch (_) { /* ignore */ }
  try { if (q && q.setAudioOutput && p.appOut) q.setAudioOutput(p.appOut); } catch (_) { /* ignore */ }
}
export const canPickOutput = () => !!(window.HTMLMediaElement && "setSinkId" in HTMLMediaElement.prototype);

// ---- output (speaker) routing: every element that plays other people's audio registers here
const sinks = new Set();
async function applySink(el) {
  const id = audioPrefs().spk;
  if (!el.setSinkId) return;
  try { await el.setSinkId(id || ""); } catch (_) { /* device gone: stay on the default */ }
}
export function registerSink(el) { sinks.add(el); applySink(el); }
export function unregisterSink(el) { sinks.delete(el); }
export function applyOutput() {
  if (nativeAudio()) { applyNativeAudio(); return; }
  sinks.forEach(applySink);
  try { const c = audioCtx(); if (c && c.setSinkId) c.setSinkId(audioPrefs().spk || "").catch(() => {}); } catch (_) { /* ignore */ }   // the >100 % boosted path
}

export async function listDevices() {
  let devs = [];
  try { devs = await navigator.mediaDevices.enumerateDevices(); } catch (_) { /* ignore */ }
  return { inputs: devs.filter(d => d.kind === "audioinput"), outputs: devs.filter(d => d.kind === "audiooutput"), labelled: devs.some(d => d.label) };
}

/**
 * The audio settings form (microphone, speakers, microphone volume).
 * `onChange()` runs after any change has been saved, so a running call can apply it at once.
 */
export function audioSettingsNode(onChange = () => {}) {
  const root = document.createElement("div"); root.className = "stack audio-settings";
  root.innerHTML = `
    <label class="lbl">Microphone</label><select class="field" data-k="mic"></select>
    <label class="lbl">Speakers / headphones</label><select class="field" data-k="spk"></select>
    <small class="muted" data-k="nospk" hidden>This browser can't choose where sound plays; it uses the system default.</small>
    <small class="muted" data-k="appnote" hidden>Android moves a headset's microphone and speaker together.</small>
    <label class="lbl">Microphone volume: <span data-k="volOut"></span></label>
    <input type="range" min="0" max="200" step="5" data-k="vol">
    <small class="muted">100% is unchanged. Above that you get louder (and noisier); below it people hear you quieter.</small>
    <button type="button" class="btn" data-k="allow" hidden>Allow microphone to list my devices</button>`;
  const $ = k => root.querySelector(`[data-k="${k}"]`);
  const fill = (sel, list, cur, def) => {
    sel.replaceChildren(new Option(def, ""));
    list.forEach((d, i) => { if (d.deviceId && d.deviceId !== "default" && d.deviceId !== "communications") sel.add(new Option(d.label || `${def.split(" ")[0]} ${i + 1}`, d.deviceId)); });
    sel.value = [...sel.options].some(o => o.value === cur) ? cur : "";
  };
  const paint = async () => {
    const p = audioPrefs(), nat = nativeAudio();
    if (nat) {                                              // Android app: the phone's own audio devices
      const fillN = (sel, list, cur, def) => { sel.replaceChildren(new Option(def, "")); list.forEach(d => sel.add(new Option(d.name, d.id))); sel.value = [...sel.options].some(o => o.value === cur) ? cur : ""; };
      fillN($("mic"), nat.inputs || [], p.appIn, "Automatic");
      fillN($("spk"), nat.outputs || [], p.appOut, "Automatic");
      $("spk").disabled = false; $("nospk").hidden = true; $("allow").hidden = true; $("appnote").hidden = false;
      $("vol").value = Math.round(p.micVol * 100); $("volOut").textContent = Math.round(p.micVol * 100) + "%";
      return;
    }
    const { inputs, outputs, labelled } = await listDevices();
    fill($("mic"), inputs, p.mic, "System default microphone");
    fill($("spk"), outputs, p.spk, "System default output");
    $("spk").disabled = !canPickOutput(); $("nospk").hidden = canPickOutput();
    $("vol").value = Math.round(p.micVol * 100); $("volOut").textContent = Math.round(p.micVol * 100) + "%";
    $("allow").hidden = labelled || !navigator.mediaDevices;
  };
  $("mic").onchange = () => { if (nativeAudio()) { setAudioPrefs({ appIn: $("mic").value }); applyNativeAudio(); onChange("native"); } else { setAudioPrefs({ mic: $("mic").value }); onChange("mic"); } };
  $("spk").onchange = () => { if (nativeAudio()) { setAudioPrefs({ appOut: $("spk").value }); applyNativeAudio(); onChange("native"); } else { setAudioPrefs({ spk: $("spk").value }); onChange("spk"); } };
  $("vol").oninput = () => { $("volOut").textContent = $("vol").value + "%"; };
  $("vol").onchange = () => { setAudioPrefs({ micVolPct: Number($("vol").value) }); onChange("vol"); };
  $("allow").onclick = async () => {
    try { (await navigator.mediaDevices.getUserMedia({ audio: true })).getTracks().forEach(t => t.stop()); } catch (_) { /* denied */ }
    paint();
  };
  navigator.mediaDevices && navigator.mediaDevices.addEventListener && navigator.mediaDevices.addEventListener("devicechange", paint);
  const onNative = () => { if (!root.isConnected) removeEventListener("qm-audio-devices", onNative); else paint(); };     // Android: the app reports plugged-in / removed devices
  addEventListener("qm-audio-devices", onNative);
  paint();
  return root;
}
