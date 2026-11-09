#!/usr/bin/env python3
"""Builds the guide from guide-src/guides.txt plus the hand-written overview pages.

Outputs (all committed, GitHub Pages serves them as they are):
  guide/<slug>/index.html   every new guide page
  guide/<slug>.md           a Markdown version of EVERY guide (overview pages included)
  guide/tree.json, guide/tree.md   the full tree, for people and for the support assistant
  guide/all/index.html      every guide on one page
  guide/index.html          the guide home (regenerated list)
  sitemap.xml
and refreshes the side navigation and "More on this topic" lists inside the existing overview pages.
Run: python3 tools/build_guides.py
"""
import re, os, html, json, glob, datetime, sys
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__))); os.chdir(ROOT)
SITE = "https://maestro-pro.app"
GROUPS = ["Start here", "Plans and licences", "Practise", "Sound and words", "Write and keep", "Together", "Settings and help", "Your devices and privacy"]
OVERVIEW_GROUP = {  # the hand-written overview pages and where they sit
 "getting-started": "Start here", "your-library": "Start here", "playing-a-score": "Start here",
 "tuner-wait-for-me": "Practise", "record-review": "Practise", "scales-arpeggios": "Practise", "annotating": "Practise",
 "backing-tracks-sound": "Sound and words", "lyrics-karaoke": "Sound and words",
 "writing-editing-music": "Write and keep", "version-history-github": "Write and keep", "share-export-print": "Write and keep",
 "play-together": "Together", "keyboard-shortcuts": "Settings and help", "settings-accessibility": "Settings and help", "troubleshooting": "Settings and help"}
esc = lambda s: html.escape(s, quote=False)
CURP = ' aria-current="page"'
unnum = lambda l: re.sub(r"^\d+\. ", "", l)   # outside the f-strings so this also runs on Python before 3.12
def die(m): print("ERROR:", m); sys.exit(1)

# ---------- parse the source ----------
pages = {}   # slug -> dict(title, parent, group, summary, keywords, see, body, overview)
order = []
src = open("guide-src/guides.txt").read()
cur = None
for line in src.split("\n"):
    m = re.match(r"^## ([a-z0-9-]+) \| (.+?) \| (.+)$", line)
    if m:
        slug, parent, title = m.groups()
        if slug in pages: die("duplicate slug " + slug)
        group = parent[6:] if parent.startswith("group:") else None
        cur = pages[slug] = dict(slug=slug, title=title.strip(), parent=None if group else parent, group=group, summary="", keywords=[], see=[], body=[], overview=False)
        order.append(slug); continue
    m = re.match(r"^@meta ([a-z0-9-]+) \| (.+)$", line)   # keywords for a hand-written overview page
    if m: pages.setdefault("__meta", {})[m.group(1)] = [k.strip() for k in m.group(2).split(",")]; continue
    if cur is None: continue
    m = re.match(r"^(summary|keywords|see): ?(.*)$", line)
    if m and not cur["body"]:
        k, v = m.groups()
        if k == "summary": cur["summary"] = v.strip()
        elif k == "keywords": cur["keywords"] = [x.strip() for x in v.split(",") if x.strip()]
        else: cur["see"] = [x.strip() for x in v.split(",") if x.strip()]
        continue
    cur["body"].append(line)
meta = pages.pop("__meta", {})
for p in pages.values():
    p["body"] = "\n".join(p["body"]).strip()
    for bad in ("—", "–"):
        if bad in p["body"] + p["summary"] + p["title"]: die(f"{p['slug']}: contains an em or en dash")
    if not p["summary"]: die(p["slug"] + ": no summary")
    if not p["body"]: die(p["slug"] + ": no body")

# ---------- the hand-written overview pages ----------
def read_overview(slug):
    s = open(f"guide/{slug}/index.html").read()
    title = html.unescape(re.search(r"<h1[^>]*>(.*?)</h1>", s, re.S).group(1))
    lede = html.unescape(re.sub(r"<[^>]+>", "", re.search(r'<p class="guide__lede">(.*?)</p>', s, re.S).group(1)))
    art = re.search(r'<article class="guide__body">(.*?)</article>', s, re.S).group(1)
    return s, title, lede, art
overview = {}
for slug, grp in OVERVIEW_GROUP.items():
    s, title, lede, art = read_overview(slug)
    overview[slug] = dict(slug=slug, title=title, parent=None, group=grp, summary=lede, keywords=meta.get(slug, []), see=[], body="", overview=True, art=art)
for slug in pages:
    if slug in overview: die("slug clashes with an overview page: " + slug)
allp = {**overview, **pages}
for p in pages.values():
    if p["parent"] and p["parent"] not in allp: die(f"{p['slug']}: unknown parent {p['parent']}")
    if p["group"] and p["group"] not in GROUPS: die(f"{p['slug']}: unknown group {p['group']}")
    for s in p["see"]:
        if s not in allp: die(f"{p['slug']}: unknown 'see' slug {s}")
def group_of(p): 
    while p["parent"]: p = allp[p["parent"]]
    return p["group"]
def topic_of(p):
    while p["parent"]: p = allp[p["parent"]]
    return p
def children(slug): return [allp[s] for s in order if allp[s]["parent"] == slug]
topics_in = {g: [p for p in list(overview.values()) + [pages[s] for s in order if pages[s]["group"]] if p["group"] == g] for g in GROUPS}
# keep the overview pages first and in their original order, then new topics
url = lambda slug: f"{SITE}/guide/{slug}/"
path = lambda slug: f"/guide/{slug}/"

# ---------- markdown-lite -> html / md ----------
def inline_html(t):
    t = esc(t)
    t = re.sub(r"\*\*(.+?)\*\*", r"<strong>\1</strong>", t)
    def link(m):
        txt, tgt = m.group(1), html.unescape(m.group(2))
        if re.match(r"^[a-z0-9-]+$", tgt):
            if tgt not in allp: die("bad internal link: " + tgt)
            tgt = path(tgt)
        return f'<a href="{tgt}">{txt}</a>'
    return re.sub(r"\[([^\]]+)\]\(([^)]+)\)", link, t)
def body_html(b):
    out = []
    for block in re.split(r"\n\s*\n", b):
        lines = [l for l in block.split("\n") if l.strip()]
        if not lines: continue
        if lines[0].startswith("### "):
            out.append(f"<h2>{inline_html(lines[0][4:])}</h2>"); lines = lines[1:]
            if not lines: continue
        if all(re.match(r"^- ", l) for l in lines): out.append("<ul>" + "".join(f"<li>{inline_html(l[2:])}</li>" for l in lines) + "</ul>")
        elif all(re.match(r"^\d+\. ", l) for l in lines): out.append("<ol>" + "".join(f"<li>{inline_html(unnum(l))}</li>" for l in lines) + "</ol>")
        else: out.append("<p>" + "<br>".join(inline_html(l) for l in lines) + "</p>")
    return "\n".join(out)
def body_md(b):
    def link(m):
        txt, tgt = m.group(1), m.group(2)
        return f"[{txt}]({url(tgt) if re.match(r'^[a-z0-9-]+$', tgt) else (SITE + tgt if tgt.startswith('/') else tgt)})"
    return re.sub(r"\[([^\]]+)\]\(([^)]+)\)", link, b.replace("### ", "## "))
def art_to_md(art):
    a = re.sub(r'<div class="pager">.*?</div>', "", art, flags=re.S); a = re.sub(r'<a class="back".*?</a>', "", a)
    a = re.sub(r'<ul class="toc".*?</ul>', "", a, flags=re.S); a = re.sub(r"<!--children-->.*?<!--/children-->", "", a, flags=re.S)
    a = re.sub(r"<h1[^>]*>.*?</h1>", "", a, flags=re.S); a = re.sub(r'<p class="guide__lede">.*?</p>', "", a, flags=re.S)
    a = re.sub(r"<h2[^>]*>(.*?)</h2>", r"\n## \1\n", a, flags=re.S)
    def lnk(m):
        h = m.group(1); h = SITE + h if h.startswith("/") else h
        return f"[{m.group(2)}]({h})"
    a = re.sub(r'<a [^>]*href="([^"]+)"[^>]*>(.*?)</a>', lnk, a, flags=re.S)
    a = re.sub(r"<(strong|b)>(.*?)</\1>", r"**\2**", a, flags=re.S); a = re.sub(r"<(em|i)>(.*?)</\1>", r"*\2*", a, flags=re.S)
    a = re.sub(r"<li[^>]*>", "\n- ", a); a = re.sub(r"</(p|ul|ol|div|figure|section)>", "\n", a); a = re.sub(r"<br\s*/?>", "\n", a)
    a = re.sub(r"<[^>]+>", "", a); a = html.unescape(a)
    return re.sub(r"\n{3,}", "\n\n", re.sub(r"[ \t]+\n", "\n", a)).strip()

# ---------- page chrome, taken from a hand-written page ----------
TPL = open("guide/getting-started/index.html").read()
HEAD_T = TPL[:TPL.index("</head>") + 7]
BODY_TOP = TPL[TPL.index('<a class="skip"'):TPL.index('<main id="main"')]
FOOT = TPL[TPL.index("</main>"):]
def head(title, desc, slug):
    h = HEAD_T
    t = f"{esc(title)} - Maestro Pro guide"; d = html.escape(desc, quote=True); u = url(slug) if slug else f"{SITE}/guide/"
    h = re.sub(r"<title>.*?</title>", f"<title>{t}</title>", h)
    h = re.sub(r'(<meta name="description" content=")[^"]*"', lambda m: m.group(1) + d + '"', h)
    h = re.sub(r'(<link rel="canonical" href=")[^"]*"', lambda m: m.group(1) + u + '"', h)
    h = re.sub(r'(<meta property="og:url" content=")[^"]*"', lambda m: m.group(1) + u + '"', h)
    h = re.sub(r'(<meta property="og:title" content=")[^"]*"', lambda m: m.group(1) + t + '"', h)
    h = re.sub(r'(<meta name="twitter:title" content=")[^"]*"', lambda m: m.group(1) + t + '"', h)
    h = re.sub(r'(<meta property="og:description" content=")[^"]*"', lambda m: m.group(1) + d + '"', h)
    h = re.sub(r'(<meta name="twitter:description" content=")[^"]*"', lambda m: m.group(1) + d + '"', h)
    return h
def nav(current):
    cur = allp.get(current); top = topic_of(cur) if cur else None
    CUR0 = CURP if current is None else ''
    out = ['<details class="guide__nav" open><summary>Guide topics</summary><nav aria-label="Guide">',
           f'<a href="/guide/"{CUR0}>Guide home</a>', '<a href="/guide/all/">Every guide, A to Z</a>' if current != "__all" else '<a href="/guide/all/" aria-current="page">Every guide, A to Z</a>']
    for g in GROUPS:
        out.append(f"<h2>{esc(g)}</h2>")
        for t in topics_in[g]:
            ac = ' aria-current="page"' if current == t["slug"] else ""
            out.append(f'<a href="{path(t["slug"])}"{ac}>{esc(t["title"])}</a>')
            if top and top["slug"] == t["slug"]:
                kids = children(t["slug"])
                if kids:
                    out.append('<div class="sub">' + "".join(f'<a href="{path(k["slug"])}"{CURP if current == k["slug"] else ""}>{esc(k["title"])}</a>' for k in kids) + "</div>")
    out.append("</nav></details>")
    return "\n".join(out)
def breadcrumb(p):
    if p["parent"]: par = allp[p["parent"]]; return f'<a class="back" href="{path(par["slug"])}">← {esc(par["title"])}</a>'
    return '<a class="back" href="/guide/">← Guide</a>'
def kids_html(slug):
    ks = children(slug)
    if not ks: return ""
    return "<!--children-->\n<h2>More on this topic</h2>\n<ul class=\"topics\">" + "".join(f'<li><a href="{path(k["slug"])}"><b>{esc(k["title"])}</b><span>{esc(k["summary"])}</span></a></li>' for k in ks) + "</ul>\n<!--/children-->"
def related_html(p):
    rel = []
    for s in p["see"]: rel.append(allp[s])
    if p["parent"]:
        par = allp[p["parent"]]
        if par not in rel: rel.append(par)
    if not rel: return ""
    return "<h2>Related</h2>\n<ul>" + "".join(f'<li><a href="{path(r["slug"])}">{esc(r["title"])}</a></li>' for r in rel) + "</ul>"
def pager(p):
    sibs = [s for s in order if allp[s]["parent"] == p["parent"]] if p["parent"] else None
    if not sibs or p["slug"] not in sibs: return ""
    i = sibs.index(p["slug"]); a = allp[sibs[i-1]] if i > 0 else None; b = allp[sibs[i+1]] if i < len(sibs)-1 else None
    return '<div class="pager">' + (f'<a href="{path(a["slug"])}">← {esc(a["title"])}</a>' if a else "<span></span>") + (f'<a href="{path(b["slug"])}">{esc(b["title"])} →</a>' if b else "") + "</div>"

# ---------- plain text of every guide, for the support assistant's search ----------
search = {}
def plain_text(md): return re.sub(r"\s+", " ", re.sub(r"\*\*|[#>`]", "", re.sub(r"\[([^\]]+)\]\([^)]*\)", r"\1", md))).strip()

# ---------- write the new pages ----------
for slug in order:
    p = pages[slug]; top = topic_of(p)
    lede = f"<p class=\"guide__lede\">{esc(p['summary'])}</p>\n" if not p["parent"] else ""   # short task pages start straight in
    art = (breadcrumb(p) + f"\n<h1>{esc(p['title'])}</h1>\n" + lede + body_html(p["body"]) + "\n" +
           (kids_html(slug) + "\n" if not p["parent"] else "") + related_html(p) + "\n" + pager(p))
    page = head(p["title"], p["summary"], slug) + "\n<body class=\"read\">\n" + BODY_TOP + '<main id="main" class="guide">\n' + nav(slug) + '\n<article class="guide__body">\n' + art + "\n</article>\n" + FOOT
    os.makedirs(f"guide/{slug}", exist_ok=True); open(f"guide/{slug}/index.html", "w").write(page)
    crumb = " > ".join(["Guide", group_of(p)] + ([allp[p["parent"]]["title"]] if p["parent"] and allp[p["parent"]]["parent"] else []) + ([top["title"]] if p["parent"] else []) )
    path_parts = ["Guide", group_of(p)] + ([top["title"]] if p["parent"] else []) + [p["title"]]
    md = f"# {p['title']}\n\nPath: {' > '.join(path_parts)}\nURL: {url(slug)}\nSummary: {p['summary']}\n\n{body_md(p['body'])}\n"
    if not p["parent"] and children(slug): md += "\n## More on this topic\n" + "\n".join(f"- [{k['title']}]({url(k['slug'])}): {k['summary']}" for k in children(slug)) + "\n"
    rel = [allp[s] for s in p["see"]] + ([allp[p["parent"]]] if p["parent"] else [])
    if rel: md += "\n## Related\n" + "\n".join(f"- [{r['title']}]({url(r['slug'])})" for r in rel) + "\n"
    open(f"guide/{slug}.md", "w").write(md)
    search[slug] = plain_text(p["title"] + ". " + p["summary"] + " " + p["body"])[:2200]

# ---------- refresh the hand-written overview pages ----------
for slug, p in overview.items():
    f = f"guide/{slug}/index.html"; s = open(f).read()
    s = re.sub(r'<details class="guide__nav".*?</details>', lambda m: nav(slug), s, flags=re.S)
    s = re.sub(r"\n?<!--children-->.*?<!--/children-->", "", s, flags=re.S)
    k = kids_html(slug)
    if k: s = s.replace('<div class="pager">', k + '\n<div class="pager">', 1) if '<div class="pager">' in s else s.replace("</article>", k + "\n</article>", 1)
    open(f, "w").write(s)
    art = p["art"]; md_body = art_to_md(art)
    md = f"# {p['title']}\n\nPath: Guide > {p['group']} > {p['title']}\nURL: {url(slug)}\nSummary: {p['summary']}\n\n{md_body}\n"
    if children(slug): md += "\n## More on this topic\n" + "\n".join(f"- [{c['title']}]({url(c['slug'])}): {c['summary']}" for c in children(slug)) + "\n"
    open(f"guide/{slug}.md", "w").write(md)
    search[slug] = plain_text(p["title"] + ". " + p["summary"] + " " + md_body)[:2200]

# ---------- guide home and the all-guides page ----------
def topic_li(t): return f'<li><a href="{path(t["slug"])}"><b>{esc(t["title"])}</b><span>{esc(t["summary"])}</span></a></li>'
home_art = ('<a class="back" href="/">← Back to Maestro Pro</a>\n<h1>The guide.</h1>\n<p class="guide__lede">Every part of Maestro Pro, one topic to a page. New here? Start with <a href="/guide/getting-started/">Getting Started</a>. '
            'Looking for something specific? <a href="/guide/all/">Every guide, A to Z</a> lists them all. The same text is in the app, under Help.</p>\n' +
            "".join(f'<h2 class="group">{esc(g)}</h2><ul class="topics">' + "".join(topic_li(t) for t in topics_in[g]) + "</ul>\n" for g in GROUPS))
home = head("The guide", "Every part of Maestro Pro, one topic to a page.", None) + '\n<body class="read">\n' + BODY_TOP + '<main id="main" class="guide">\n' + nav(None) + '\n<article class="guide__body">\n' + home_art + "</article>\n" + FOOT
# the original home page title/description are kept
old_home = open("guide/index.html").read()
m = re.search(r"<title>.*?</title>", old_home, re.S); home = re.sub(r"<title>.*?</title>", m.group(0), home, count=1)
m = re.search(r'<meta name="description" content="[^"]*">', old_home); home = re.sub(r'<meta name="description" content="[^"]*">', m.group(0), home, count=1)
open("guide/index.html", "w").write(home)
all_art = '<a class="back" href="/guide/">← Guide</a>\n<h1>Every guide.</h1>\n<p class="guide__lede">All of the guides, by topic. Each one is a short page about a single thing you can do or a single question.</p>\n'
for g in GROUPS:
    all_art += f'<h2 class="group">{esc(g)}</h2>\n'
    for t in topics_in[g]:
        all_art += f'<h3 class="alltopic"><a href="{path(t["slug"])}">{esc(t["title"])}</a></h3>\n'
        ks = children(t["slug"])
        if ks: all_art += '<ul class="allkids">' + "".join(f'<li><a href="{path(k["slug"])}">{esc(k["title"])}</a></li>' for k in ks) + "</ul>\n"
os.makedirs("guide/all", exist_ok=True)
open("guide/all/index.html", "w").write(head("Every guide", "All of the Maestro Pro guides, by topic.", "all") + '\n<body class="read">\n' + BODY_TOP + '<main id="main" class="guide">\n' + nav("__all") + '\n<article class="guide__body">\n' + all_art + "</article>\n" + FOOT)

# ---------- the tree ----------
def node(p): return dict(slug=p["slug"], title=p["title"], summary=p["summary"], url=url(p["slug"]), md=f"{SITE}/guide/{p['slug']}.md", keywords=p["keywords"], see=p["see"], children=[node(k) for k in children(p["slug"])])
tree = dict(site=SITE, about="Every Maestro Pro guide, grouped. Each page has an HTML url and a Markdown url.", generated=datetime.date.today().isoformat(), groups=[dict(title=g, topics=[node(t) for t in topics_in[g]]) for g in GROUPS])
open("guide/tree.json", "w").write(json.dumps(tree, indent=1, ensure_ascii=False) + "\n")
tm = ["# Maestro Pro guide: full tree", "", f"Every guide, grouped. HTML pages are at {SITE}/guide/<slug>/ and Markdown versions at {SITE}/guide/<slug>.md. The machine-readable version is {SITE}/guide/tree.json.", ""]
for g in tree["groups"]:
    tm.append(f"## {g['title']}")
    for t in g["topics"]:
        tm.append(f"- [{t['title']}]({t['url']}): {t['summary']}")
        for c in t["children"]: tm.append(f"  - [{c['title']}]({c['url']}): {c['summary']}")
    tm.append("")
open("guide/tree.md", "w").write("\n".join(tm))

# ---------- remove pages that are no longer in the source ----------
import shutil
valid = set(OVERVIEW_GROUP) | set(order)
for d in os.listdir("guide"):
    full = os.path.join("guide", d)
    if os.path.isdir(full) and d not in valid and d != "all": shutil.rmtree(full); print("removed stale page:", d)
    if d.endswith(".md") and d[:-3] not in valid and d != "tree.md": os.remove(full); print("removed stale markdown:", d)

open("guide/search.json", "w").write(json.dumps(search, ensure_ascii=False, separators=(",", ":")) + "\n")

# ---------- sitemap ----------
today = datetime.date.today().isoformat()
urls = [(SITE + "/", "0.8"), (SITE + "/guide/", "0.5"), (SITE + "/guide/all/", "0.4"), (SITE + "/support/", "0.5"), (SITE + "/feedback/", "0.4"), (SITE + "/privacy/", "0.3"), (SITE + "/education/", "0.5")]
urls += [(url(s), "0.4") for s in list(OVERVIEW_GROUP) + order]
open("sitemap.xml", "w").write('<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' + "".join(f"  <url>\n    <loc>{u}</loc>\n    <lastmod>{today}</lastmod>\n    <priority>{pr}</priority>\n  </url>\n" for u, pr in urls) + "</urlset>\n")
print(f"built {len(order)} new guides + {len(overview)} overview pages; {sum(1 for _ in glob.glob('guide/*.md'))} markdown files")
