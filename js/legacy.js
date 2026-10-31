// Runs first on index.html, written in plain old JavaScript (ES3) so even a Nintendo Wii browser can execute it.
// Very old browsers can't run the real app (it uses modules, promises, fetch...). On a private server they are sent to legacy/ (a small text chat);
// on the Firebase site they are sent there too (the legacy client talks to proxy.php). Otherwise they get a plain explanation. Switch by hand: Account -> Compatibility mode, or add ?legacy=1 / ?legacy=0 to the address.
(function () {
  var q = location.search, force = false, auto = true, priv = window.__QM_PRIVATE === 1;
  try {
    if (/[?&]legacy=0/.test(q)) localStorage.removeItem('qm-legacy');
    if (/[?&]legacy=1/.test(q)) localStorage.setItem('qm-legacy', '1');
    force = localStorage.getItem('qm-legacy') === '1';
    auto = localStorage.getItem('qm-legacy-auto') !== 'off';
  } catch (e) { /* no storage: behave as default */ }
  var modern = !!(window.Promise && window.fetch && window.URLSearchParams && 'noModule' in document.createElement('script'));
  var target = location.href.replace(/[?#].*$/, '').replace(/[^\/]*$/, '') + 'legacy/';
  if (force || (!modern && auto)) { location.replace(target); return; }
  if (!modern) {
    document.write('<p style="font:18px Arial;padding:16px">This browser is too old for QuickMessage. ' +
      '<a href="' + target + '">Open the compatibility version</a>.' + '</p>');
    return;
  }
  // Modern enough to try, but a script may still fail to start (older Safari / Chrome): after a while offer the compatibility version.
  setTimeout(function () {
    if (window.__qmBooted) return;
    var d = document.createElement('div');
    d.style.cssText = 'position:fixed;left:0;right:0;bottom:0;padding:10px;background:#fde68a;color:#111;font:16px Arial;text-align:center;z-index:9999';
    d.innerHTML = 'Taking long? <a href="' + target + '" onclick="try{localStorage.setItem(\'qm-legacy\',\'1\')}catch(e){}">Use the compatibility version</a>';
    document.body && document.body.appendChild(d);
  }, 12000);
})();
