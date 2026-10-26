/* Applies the saved appearance before the page paints (a classic script so it runs synchronously in <head>):
 *   theme      "system" | "light" | "dark"          (localStorage "theme")
 *   midnight   "1": in dark mode every dark surface is pure black   ("qm-midnight")
 *   accent     "#rrggbb": buttons, links, highlights               ("qm-accent")
 *   material   "1": Android 12+ only, colours from the wallpaper   ("qm-material", colours from QMApp.systemColors())
 *   colors     {"light":{bg,surface,own,other,text}, "dark":{…}}   ("qm-colors") your own colours per light / dark mode
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
    border: ["#e1e4ee", "#2a2f3a"], text: ["#161a23", "#e8eaf0"], muted: ["#6b7385", "#8d95a8"],
    accent: ["#4f46e5", "#6d68f2"], accentHover: ["#4338ca", "#7f7af5"], accentSoft: ["#e9e8ff", "#25244a"],
    btn: ["#4f46e5", "#c4c1ff"], btnHover: ["#4338ca", "#d6d4ff"], onBtn: ["#ffffff", "#1d1a66"],
    ownBubble: ["#4f46e5", "#5b56e0"], otherBubble: ["#ffffff", "#1f232c"]
  };
  var VAR = {
    bg: "--bg", surface: "--surface", surface2: "--surface-2", surface3: "--surface-3", border: "--border", text: "--text", muted: "--muted",
    accent: "--accent", accentHover: "--accent-hover", accentSoft: "--accent-soft", btn: "--btn", btnHover: "--btn-hover", onBtn: "--on-btn",
    ownBubble: "--own-bubble", otherBubble: "--other-bubble"
  };

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
  function lum(h) { var c = rgb(h).map(function (v) { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }); return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]; }
  function contrast(a, b) { var x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); }

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
  function myColors() { try { var o = JSON.parse(ls("qm-colors") || "null"); return o && typeof o === "object" ? o : {}; } catch (e) { return {}; } }

  var lastTokens = null;

  function build() {
    var midnight = ls("qm-midnight") === "1", accent = ls("qm-accent") || "", sys = ls("qm-material") === "1" ? sysColors() : null, mine = myColors();
    var t = {}, k;
    for (k in BASE) t[k] = BASE[k].slice();
    var custom = false, callBg = null;

    if (sys && sys.a1 && sys.n1 && HEX.test(sys.a1["600"] || "") && HEX.test(sys.a1["200"] || "")) {       // Material You
      var a = sys.a1, n = sys.n1;
      custom = true;
      t.accent = [a["600"], a["200"]]; t.accentHover = [a["700"] || a["600"], a["100"] || a["200"]];
      t.accentSoft = [a["100"] || mix(a["600"], "#ffffff", 0.85), a["800"] || mix(a["200"], "#000000", 0.75)];
      t.btn = [a["600"], a["200"]]; t.btnHover = [a["700"] || a["600"], a["100"] || a["200"]]; t.onBtn = ["#ffffff", a["800"] || "#1d1a66"];
      t.ownBubble = [a["600"], a["600"]];
      t.bg = [n["50"], mix(n["900"], n["1000"] || "#000000", 0.5)];
      t.surface = [n["10"] || "#ffffff", mix(n["900"], n["800"], 0.6)];
      t.surface2 = [n["100"], n["800"]]; t.surface3 = [mix(n["100"], n["200"], 0.5), mix(n["800"], n["700"], 0.5)];
      t.border = [n["100"], mix(n["800"], n["700"], 0.5)];
      t.otherBubble = [n["10"] || "#ffffff", n["800"]];
    } else if (HEX.test(accent)) {                                                                         // your own accent colour
      var hsl = toHsl(accent), h = hsl[0], s = hsl[1];
      var ds = Math.min(s, 0.75), lL = clamp(hsl[2], 0.26, 0.46), dL = clamp(hsl[2], 0.56, 0.68);
      var lightC = fromHsl(h, s, lL), darkC = fromHsl(h, ds, dL);                                           // softer on dark so it isn't neon
      custom = true;
      t.accent = [lightC, darkC];
      t.accentHover = [fromHsl(h, s, lL - 0.06), fromHsl(h, ds, dL + 0.07)];
      t.accentSoft = [mix(lightC, "#ffffff", 0.88), mix(t.bg[1], darkC, 0.22)];
      t.btn = [lightC, fromHsl(h, Math.min(s, 0.9), 0.85)];                                                  // light mode: dark button, white text. dark mode: bright button, dark text
      t.btnHover = [fromHsl(h, s, lL - 0.06), fromHsl(h, Math.min(s, 0.9), 0.91)];
      t.onBtn = ["#ffffff", fromHsl(h, Math.min(s, 0.6), 0.16)];
      t.ownBubble = [lightC, fromHsl(h, ds, clamp(hsl[2], 0.42, 0.55))];
    }

    if (midnight) {                                                                                        // dark mode only: the dark slot of every surface goes black
      custom = true; callBg = "#000000";
      t.bg[1] = "#000000"; t.surface[1] = "#000000"; t.surface2[1] = "#0c0c0f"; t.surface3[1] = "#17171b"; t.border[1] = "#1e1e24"; t.otherBubble[1] = "#111114";
      t.accentSoft[1] = mix("#000000", t.accent[1], 0.2);
    }

    [0, 1].forEach(function (i) {                                                                          // your own colours, separately for light and dark mode
      var o = mine[i ? "dark" : "light"]; if (!o) return;
      var has = function (key) { return HEX.test(o[key] || ""); };
      if (!(has("bg") || has("surface") || has("own") || has("other") || has("text"))) return;
      custom = true;
      var bgc = has("bg") ? o.bg : t.bg[i];
      var srf = has("surface") ? o.surface : has("bg") ? mix(bgc, lum(bgc) < 0.45 ? "#ffffff" : "#000000", 0.05) : t.surface[i];
      if (has("bg") || has("surface")) {
        var dir = lum(srf) < 0.45 ? "#ffffff" : "#000000";
        t.bg[i] = bgc; t.surface[i] = srf;
        t.surface2[i] = mix(srf, dir, 0.07); t.surface3[i] = mix(srf, dir, 0.13); t.border[i] = mix(srf, dir, 0.16); t.otherBubble[i] = mix(srf, dir, 0.07);
        t.text[i] = lum(bgc) < 0.45 ? "#e8eaf0" : "#161a23";
      }
      if (has("text") && contrast(o.text, bgc) >= 3 && contrast(o.text, srf) >= 3) t.text[i] = o.text;
      if (has("bg") || has("surface") || has("text")) t.muted[i] = mix(t.text[i], bgc, 0.45);
      if (has("other")) t.otherBubble[i] = o.other;
      if (has("own")) { var c = o.own, g = 0; while (contrast("#ffffff", c) < 3 && g++ < 12) c = mix(c, "#000000", 0.12); t.ownBubble[i] = c; }   // white text sits on it, so keep it dark enough
      if (has("bg") && midnight && i === 1) callBg = o.bg;
    });

    if (custom && !callBg) callBg = t.bg[1];                  // the call page / call layer always use the dark colours
    lastTokens = t;
    var css = "";
    if (custom) {                                            // plain rules (no light-dark(): Safari before 17.5 ignores it)
      var L = "", D = "";
      for (k in VAR) { L += VAR[k] + ":" + t[k][0] + ";"; D += VAR[k] + ":" + t[k][1] + ";"; }
      if (callBg) L += "--call-bg:" + callBg + ";" + (midnight ? "--tile-bg:#0c0c0f;" : "");
      css = ":root:root:root{" + L + "}@media (prefers-color-scheme:dark){:root:root:not([data-theme=\"light\"]){" + D + "}}:root:root[data-theme=\"dark\"]{" + D + "}";
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
    if (tag.textContent !== b.css) tag.textContent = b.css;     // more specific than the stylesheet's own :root blocks, so it wins even though it comes first
  }

  window.__qmThemeApply = apply;
  /** The colour every token currently has: { bg: [light, dark], … } (used by the colour pickers in Account). */
  window.__qmThemeTokens = function () { if (!lastTokens) build(); return lastTokens; };
  apply(true);
  addEventListener("storage", function (e) { if (!e.key || /^(qm-midnight|qm-accent|qm-material|qm-colors)$/.test(e.key)) apply(false); });
  try { new BroadcastChannel("qm-theme").onmessage = function () { apply(false); }; } catch (e) { /* old browser */ }

  // The web app manifest is built here and handed over as a data: link, so no manifest.json file is needed (some web hosts refuse to serve one).
  // Inside a data: manifest relative links don't work, so every address is made absolute from this page's own location.
  try {
    var base = new URL("./", document.baseURI).href, abs = function (p) { return new URL(p, base).href; };
    var man = {
      name: "QuickMessage", short_name: "QuickMsg", description: "A simple, lightweight private messaging app.",
      start_url: abs("index.html"), scope: base, display: "standalone", orientation: "portrait", background_color: "#4f46e5", theme_color: "#4f46e5",
      icons: [{ src: abs("icons/icon-192.png"), sizes: "192x192", type: "image/png", purpose: "any" }, { src: abs("icons/icon-512.png"), sizes: "512x512", type: "image/png", purpose: "any" }]
    };
    var lk = document.createElement("link"); lk.rel = "manifest"; lk.id = "qm-manifest";
    lk.href = "data:application/manifest+json;charset=utf-8," + encodeURIComponent(JSON.stringify(man));
    (document.head || R).appendChild(lk);
  } catch (e) { /* no manifest: the site still works, it just can't be installed */ }
})();
