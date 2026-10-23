// A small "What do these settings do?" section, shown in Account and in the start-sharing dialog.
const WEB = [
  ["Resolution", "The biggest picture size to ask for. Bigger is sharper (good for text) but needs more bandwidth and processing power. \"Automatic\" lets the browser choose."],
  ["Frame rate (fps)", "How many times per second the picture updates. \"Frame rate\" and \"fps\" (frames per second) are the same thing. 5–15 is fine for slides and documents, 30–60 is smooth for games and video."],
  ["Maximum bitrate", "A cap on how much data per second you send (kbps). 0 means automatic. Higher lets the picture stay sharp while things move, but needs a fast upload."],
  ["Optimise for", "Tells the browser what matters more: sharp text and detail, smooth motion, or let it decide."],
  ["When the connection is slow, give up…", "What the browser sacrifices when it can't keep up: frame rate (stays sharp but choppy), sharpness (stays smooth but blurrier), a bit of both, or its own choice."],
  ["Video codec", "How the video is compressed. Automatic is right for almost everyone; AV1 and VP9 look better at the same bitrate but use more CPU, H.264 is often hardware accelerated."],
  ["Share sound too", "Also sends the sound playing on the screen or tab, when the browser offers it."]
];
const APP = [
  ["Largest side", "The longest edge of the pictures the app sends. Bigger is sharper but heavier."],
  ["Picture quality", "How strongly each picture is compressed (30–95 %). Higher is clearer and uses more data."],
  ["Frames per second", "How many pictures per second the app sends. It means the same as \"frame rate\" in a browser: higher is smoother and uses more battery and data."],
  ["Share sound too", "Also sends the sound playing on the phone, when Android allows it."]
];
export function screenHelpNode(isApp = !!window.QMApp) {
  const d = document.createElement("details"); d.className = "adv";
  const sm = document.createElement("summary"); sm.textContent = "What do these settings mean?"; d.append(sm);
  const dl = document.createElement("dl"); dl.className = "help-list";
  for (const [t, x] of isApp ? APP : WEB) { const dt = document.createElement("dt"); dt.textContent = t; const dd = document.createElement("dd"); dd.textContent = x; dl.append(dt, dd); }
  const tip = document.createElement("p"); tip.className = "muted"; tip.style.fontSize = ".8rem";
  tip.textContent = "Max everything turns every setting up as high as it goes: the sharpest, smoothest picture, but it needs a fast connection and a strong device, and may make calls stutter. These settings only change what you send; what you watch from others is always the best the sender provides, and your browser lowers it on its own if your connection can't keep up.";
  d.append(dl, tip);
  return d;
}
