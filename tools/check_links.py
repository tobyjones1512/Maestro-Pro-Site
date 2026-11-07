#!/usr/bin/env python3
"""Checks every internal link and asset in the site's HTML points at a file that exists. Run from anywhere: python3 tools/check_links.py"""
import re, os, glob, sys, posixpath
ROOT=os.path.dirname(os.path.dirname(os.path.abspath(__file__))); os.chdir(ROOT)
bad=[]; n=0
for f in glob.glob('**/*.html',recursive=True):
    s=open(f).read(); here='/'+posixpath.dirname(f)+'/'; here=here.replace('//','/')
    for m in re.finditer(r'''(?:href|src)=["']([^"']+)["']''',s):
        u=m.group(1)
        if re.match(r'^(https?:|mailto:|tel:|data:|#|javascript:)',u): continue
        path=re.split(r'[?#]',u)[0]
        if not path: continue
        absu=path if path.startswith('/') else posixpath.normpath(posixpath.join(here,path))
        disk=absu.lstrip('/'); n+=1
        ok = (os.path.isfile(os.path.join(disk,'index.html')) if (absu.endswith('/') or os.path.isdir(disk)) else os.path.isfile(disk))
        if absu.endswith('/') and not ok: pass
        if not ok: bad.append((f,u))
print(f"checked {n} internal links in {len(glob.glob('**/*.html',recursive=True))} pages")
for f,u in bad[:60]: print("BROKEN",f,"->",u)
print("broken:",len(bad)); sys.exit(1 if bad else 0)
