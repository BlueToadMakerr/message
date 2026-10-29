/* Solves the host's JavaScript "browser check" (loaded first in every page, in the website and in both apps; the iPhone app also injects an identical copy
 * into every frame before the page runs: ios/QuickMessage/challenge.js).
 *
 * Free hosts such as InfinityFree answer requests that did not come from a "real" browser run with a small JavaScript test page
 * (<script src="/aes.js"> + an inline script that sets a "__test" cookie and redirects). A page navigation passes it by itself, but a script / module /
 * stylesheet / fetch() that gets that test page back instead of its file breaks the app ("Unexpected token '<'", a notification that "failed" because the
 * answer wasn't JSON...). This solves the test the same way the page would (runs the host's own aes.js on the numbers in the test page, in a sandboxed
 * function), stores the cookie, and then repeats the fetch / reloads the page once.
 * window.__qmChallenge = { solve(html, baseUrl), isChallenge(text), fetch(input, init) } - fetch() is the plain one without this handling.
 */
(function () {
  if (window.__qmChallenge) return;
  var nativeFetch = window.fetch ? window.fetch.bind(window) : null;
  if (!nativeFetch) return;
  var sameOrigin = function (u) { try { return new URL(u, location.href).origin === location.origin; } catch (e) { return false; } };
  var isChallenge = function (t) { return typeof t === "string" && t.length < 6000 && /slowAES/.test(t) && /__test/.test(t) && /aes\.js/.test(t); };
  var solving = null;

  /** Runs the test page's own scripts without a page: returns { cookie, next } (the cookie it would set, where it would redirect to). */
  function solve(html, base) {
    if (solving) return solving;
    solving = (function () {
      var m = /<script[^>]+src=["']([^"']*aes\.js[^"']*)["']/i.exec(html);
      var src = new URL(m ? m[1] : "/aes.js", base || location.href).href;
      var inline = ""; html.replace(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi, function (_, code) { if (/slowAES\.decrypt/.test(code)) inline = code; return ""; });
      if (!inline) return Promise.reject(new Error("unknown test page"));
      return nativeFetch(src, { credentials: "include", cache: "force-cache" }).then(function (r) { return r.text(); }).then(function (aes) {
        var doc = { cookie: "" }, loc = { href: "" };
        new Function("document", "location", aes + "\n;" + inline)(doc, loc);
        if (!/__test=/.test(doc.cookie)) throw new Error("no cookie");
        document.cookie = doc.cookie;
        return { cookie: doc.cookie, next: loc.href };
      });
    })();
    var done = function () { solving = null; };
    solving.then(done, done);
    return solving;
  }
  window.__qmChallenge = { solve: solve, isChallenge: isChallenge, fetch: nativeFetch };

  // fetch(): a non-page URL that answers with the test page is solved and asked again
  window.fetch = function (input, init) {
    var again; try { again = input instanceof Request ? input.clone() : input; } catch (e) { again = input; }
    return nativeFetch(input, init).then(function (res) {
      try {
        var ct = res.headers.get("content-type") || "", p = new URL(res.url || location.href).pathname;
        if (!/text\/html/i.test(ct) || !sameOrigin(res.url) || /\.html?$|\/$/.test(p)) return res;
        return res.clone().text().then(function (t) {
          if (!isChallenge(t)) return res;
          return solve(t, res.url).then(function () { return nativeFetch(again, init); }, function () { return res; });
        });
      } catch (e) { return res; }
    });
  };

  // scripts / stylesheets / modules that failed to load: solve, then reload the page once
  var firstScript = function () { var s = document.querySelector("script[src]"); return s ? s.src : location.href; };
  var busy = false;
  function recover(url) {
    if (busy) return;
    var last = 0; try { last = +sessionStorage.getItem("qm-challenge") || 0; } catch (e) { /* ignore */ }
    if (Date.now() - last < 20000) return;                          // at most one automatic reload every 20 s
    busy = true;
    nativeFetch(url, { cache: "no-store", credentials: "include" }).then(function (r) { return r.text(); }).then(function (t) {
      if (!isChallenge(t)) { busy = false; return; }
      return solve(t, url).then(function () {
        try { sessionStorage.setItem("qm-challenge", String(Date.now())); } catch (e) { /* ignore */ }
        location.reload();
      });
    }).catch(function () { busy = false; });
  }
  addEventListener("error", function (e) {
    var t = e.target;
    if (t && t !== window && /^(SCRIPT|LINK)$/.test(t.tagName || "")) { var u = t.src || t.href; if (u && sameOrigin(u)) recover(u); return; }
    if (/Unexpected token '<'|expected expression, got '<'/i.test(String(e.message || ""))) recover(firstScript());
  }, true);
  addEventListener("unhandledrejection", function (e) {
    var msg = String((e.reason && (e.reason.message || e.reason)) || "");
    if (/dynamically imported module|Importing a module script failed|Unexpected token '<'/i.test(msg)) recover(firstScript());
  });
})();
