// Pre-paint theme guard. Loaded from index.html as a plain blocking <script>
// in <head> — it must run before the first paint, and a classic (non-async,
// non-deferred) script in <head> does exactly that. It lives in its own file
// rather than inline so the Content-Security-Policy can be `script-src 'self'`
// with no 'unsafe-inline' (see security-headers.conf).
(function () {
  try {
    var t = localStorage.getItem("theme");
    var dark = t === "dark" || (!t && window.matchMedia("(prefers-color-scheme: dark)").matches);
    if (dark) {
      document.documentElement.classList.add("dark");
      var m = document.querySelector('meta[name="theme-color"]');
      if (m) m.setAttribute("content", "#0b1220");
    }
  } catch (e) {}
})();
