// The guide's search box: finds guide pages from /guide/tree.json (titles, summaries, keywords) and /guide/search.json (the text).
(function () {
  var q = document.getElementById("gs-q"), r = document.getElementById("gs-r"), pages = null;
  if (!q || !r) return;
  function flat(groups) {
    var out = [];
    groups.forEach(function (g) { g.topics.forEach(function (t) { out.push(t); (t.children || []).forEach(function (c) { out.push(c); }); }); });
    return out;
  }
  function load(done) {
    if (pages) return done();
    Promise.all([fetch("/guide/tree.json").then(function (x) { return x.json(); }), fetch("/guide/search.json").then(function (x) { return x.json(); })])
      .then(function (a) {
        pages = flat(a[0].groups).map(function (p) {
          return { p: p, t: p.title.toLowerCase(), k: (p.keywords || []).join(" ").toLowerCase(), b: (p.summary + " " + (a[1][p.slug] || "")).toLowerCase() };
        });
        done();
      })
      .catch(function () { r.textContent = "Search is not available right now."; r.setAttribute("data-none", ""); });
  }
  function run() {
    var words = q.value.toLowerCase().split(/\s+/).filter(Boolean), hits = [];
    r.textContent = ""; r.removeAttribute("data-none");
    if (!words.length) return;
    pages.forEach(function (e) {
      var score = 0;
      for (var i = 0; i < words.length; i++) {
        var w = words[i];
        if (e.t.indexOf(w) >= 0) score += 5; else if (e.k.indexOf(w) >= 0) score += 3; else if (e.b.indexOf(w) >= 0) score += 1; else return;
      }
      hits.push([score, e.p]);
    });
    hits.sort(function (a, b) { return b[0] - a[0]; });
    if (!hits.length) { r.textContent = "Nothing found."; r.setAttribute("data-none", ""); return; }
    hits.slice(0, 12).forEach(function (h) {
      var li = document.createElement("li"), a = document.createElement("a"), b = document.createElement("b"), s = document.createElement("span");
      a.href = "/guide/" + h[1].slug + "/"; b.textContent = h[1].title; s.textContent = h[1].summary;
      a.appendChild(b); a.appendChild(s); li.appendChild(a); r.appendChild(li);
    });
  }
  q.addEventListener("input", function () { load(run); });
})();
