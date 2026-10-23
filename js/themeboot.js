/* Applies the saved appearance before the page paints (a classic script so it runs synchronously in <head>):
 *   theme      "system" | "light" | "dark"          (localStorage "theme")
 *   midnight   "1": in dark mode every dark surface is pure black   ("qm-midnight")
 *   accent     "#rrggbb": the colour of buttons, links, own messages ("qm-accent")
 *   material   "1": Android 12+ only, take the colours from the wallpaper ("qm-material", colours from QMApp.systemColors())
 * Everything is stored per device. Other open pages / frames follow through the storage event and the "qm-theme" channel.
 * BASE below must match the :root colours in style.css (they are only used when something is customised).
 */
(function () {
  var R = document.documentElement;
  var ls = function (k) { try { return localStorage.getItem(k); } catch (e) { return null; } };
  var HEX = /^#[0-9a-f]{6}$/i;

  // [light, dark]
  var BASE = {
    bg: ["#f4f5f9", "#0e1014"], surface: ["#ffffff", "#171a21"], surface2: ["#eef0f6", "#1f232c"], surface3: ["#e4e7f0", "#272c37"],
    border: ["#e1e4ee", "#2a2f3a"], text: ["#161a23", "#e8eaf0"], accent: ["#4f46e5", "#6d68f2"], accentHover: ["#4338ca", "#7f7af5"],
    accentSoft: ["#e9e8ff", "#25244a"], ownBubble: ["#4f46e5", "#5b56e0"], otherBubble: ["#ffffff", "#1f232c"]
  };
  var VAR = { bg: "--bg", surface: "--surface", surface2: "--surface-2", surface3: "--surface-3", border: "--border", accent: "--accent", accentHover: "--accent-hover", accentSoft: "--accent-soft", ownBubble: "--own-bubble", otherBubble: "--other-bubble" };

  function rgb(h) { var n = parseInt(h.slice(1), 16); return [n >> 16, (n >> 8) & 255, n & 255]; }
  function hex(c) { return "#" + c.map(function (v) { v = Math.max(0, Math.min(255, Math.round(v))); return (v < 16 ? "0" : "") + v.toString(16); }).join(""); }
  function mix(a, b, t) { var x = rgb(a), y = rgb(b); return hex([x[0] + (y[0] - x[0]) * t, x[1] + (y[1] - x[1]) * t, x[2] + (y[2] - x[2]) * t]); }
  function toHsl(h) {
    var c = rgb(h).map(function (v) { return v / 255; }), mx = Math.max(c[0], c[1], c[2]), mn = Math.min(c[0], c[1], c[2]), l = (mx + mn) / 2, s = 0, hh = 0, d = mx - mn;
    if (d) { s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn); hh = mx === c[0] ? (c[1] - c[2]) / d + (c[1] < c[2] ? 6 : 0) : mx === c[1] ? (c[2] - c[0]) / d + 2 : (c[0] - c[1]) / d + 4; hh *= 60; }
    return [hh, s, l];
  }
  function fromHsl(h, s, l) {
    var k = function (n) { return (n + h / 30) % 12; }, a = s * Math.min(l, 1 - l);
    var f = function (n) { return l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1))); };
    return hex([f(0) * 255, f(8) * 255, f(4) * 255]);
  }
  var clamp = function (v, a, b) { return Math.max(a, Math.min(b, v)); };

  /** The colours Android 12+ derives from the wallpaper (app only; cached so frames without the bridge still get them). */
  function sysColors() {
    try {
      if (window.QMApp && typeof window.QMApp.systemColors === "function") {
        var s = window.QMApp.systemColors();
        if (s) { try { localStorage.setItem("qm-sys-colors", s); } catch (e) { /* ignore */ } return JSON.parse(s); }
      }
    } catch (e) { /* ignore */ }
    try { return JSON.parse(ls("qm-sys-colors") || "null"); } catch (e) { return null; }
  }

  function build() {
    var midnight = ls("qm-midnight") === "1", accent = ls("qm-accent") || "", sys = ls("qm-material") === "1" ? sysColors() : null;
    var t = {}, k;
    for (k in BASE) t[k] = BASE[k].slice();
    var custom = false, callBg = null;

    if (sys && sys.a1 && sys.n1 && HEX.test(sys.a1["600"] || "") && HEX.test(sys.a1["200"] || "")) {       // Material You
      var a = sys.a1, n = sys.n1;
      custom = true;
      t.accent = [a["600"], a["200"]]; t.accentHover = [a["700"] || a["600"], a["100"] || a["200"]];
      t.accentSoft = [a["100"] || mix(a["600"], "#ffffff", 0.85), a["800"] || mix(a["200"], "#000000", 0.75)];
      t.ownBubble = [a["600"], a["600"]];
      t.bg = [n["50"], mix(n["900"], n["1000"] || "#000000", 0.5)];
      t.surface = [n["10"] || "#ffffff", mix(n["900"], n["800"], 0.6)];
      t.surface2 = [n["100"], n["800"]]; t.surface3 = [mix(n["100"], n["200"], 0.5), mix(n["800"], n["700"], 0.5)];
      t.border = [n["100"], mix(n["800"], n["700"], 0.5)];
      t.otherBubble = [n["10"] || "#ffffff", n["800"]];
    } else if (HEX.test(accent)) {                                                                         // your own colour
      var hsl = toHsl(accent), h = hsl[0], s = hsl[1];
      var ds = Math.min(s, 0.75), lightC = fromHsl(h, s, clamp(hsl[2], 0.26, 0.46)), darkC = fromHsl(h, ds, clamp(hsl[2], 0.56, 0.68));     // softer on dark so it isn't neon
      custom = true;
      t.accent = [lightC, darkC];
      t.accentHover = [fromHsl(h, s, clamp(hsl[2], 0.26, 0.46) - 0.06), fromHsl(h, ds, clamp(hsl[2], 0.56, 0.68) + 0.07)];
      t.accentSoft = [mix(lightC, "#ffffff", 0.88), mix(t.bg[1], darkC, 0.22)];
      t.ownBubble = [lightC, fromHsl(h, ds, clamp(hsl[2], 0.42, 0.55))];
    }

    if (midnight) {                                                                                        // dark mode only: the dark slot of every surface goes black
      custom = true; callBg = "#000000";
      t.bg[1] = "#000000"; t.surface[1] = "#000000"; t.surface2[1] = "#0c0c0f"; t.surface3[1] = "#17171b"; t.border[1] = "#1e1e24"; t.otherBubble[1] = "#111114";
      t.accentSoft[1] = mix("#000000", t.accent[1], 0.2);
    }

    var css = "";
    if (custom) {
      for (k in VAR) css += VAR[k] + ":light-dark(" + t[k][0] + "," + t[k][1] + ");";
      if (callBg) css += "--call-bg:" + callBg + ";--tile-bg:#0c0c0f;";
    }
    return { css: css, midnight: midnight };
  }

  function apply(first) {                                    // light/dark/system itself is kept in sync by js/bars.js after the first paint
    var tag = document.getElementById("qm-theme-vars");
    if (first === true && !R.hasAttribute("data-fixed-theme")) R.dataset.theme = ls("theme") || "system";
    var b = build();
    if (b.midnight) R.setAttribute("data-midnight", "1"); else R.removeAttribute("data-midnight");
    if (!b.css) { if (tag) tag.remove(); return; }
    if (!tag) { tag = document.createElement("style"); tag.id = "qm-theme-vars"; (document.head || R).appendChild(tag); }
    var css = ":root:root{" + b.css + "}";                    // :root:root beats the stylesheet's :root even though this runs first
    if (tag.textContent !== css) tag.textContent = css;
  }

  window.__qmThemeApply = apply;
  apply(true);
  addEventListener("storage", function (e) { if (!e.key || /^(qm-midnight|qm-accent|qm-material)$/.test(e.key)) apply(false); });
  try { new BroadcastChannel("qm-theme").onmessage = function () { apply(false); }; } catch (e) { /* old browser */ }
})();
