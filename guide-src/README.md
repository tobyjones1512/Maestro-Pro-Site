# Guide source

`guides.txt` is the source for every guide except the sixteen hand-written overview pages in `guide/<topic>/index.html`.
Edit it, then run:

    python3 tools/build_guides.py
    python3 tools/check_links.py

The builder writes each page (`guide/<slug>/index.html`), a Markdown copy of every guide (`guide/<slug>.md`), the full tree
(`guide/tree.json`, `guide/tree.md`), `guide/all/`, the guide home and `sitemap.xml`. Commit the results.

The support assistant reads `guide/tree.json` and the `.md` files, so only write what the app really does. No em or en dashes.
