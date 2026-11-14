#!/usr/bin/env python3
"""Fetch full posting text for each job in jobs.txt into OUT/<id>.txt (fetching only; labeling is manual)."""
import sys, re, json, html, urllib.request, urllib.parse, os
OUT = sys.argv[1] if len(sys.argv) > 1 else "/tmp/c01"
os.makedirs(OUT, exist_ok=True)
GH = {"roblox":"roblox","lyft":"lyft","brex.com":"brex","squarespace":"squarespace","fastly":"fastly","samsara":"samsara",
      "stitchfix":"stitchfix","cockroachlabs":"cockroachlabs","withwaymo":"waymo"}
def get(u):
    r = urllib.request.Request(u, headers={"User-Agent": "Mozilla/5.0"})
    return json.load(urllib.request.urlopen(r, timeout=40))
def text(h):
    h = html.unescape(h or "")
    h = re.sub(r"<(br|/p|/li|/h\d|/div)\s*/?>", "\n", h); h = re.sub(r"<li>", "- ", h)
    return re.sub(r"\n\s*\n+", "\n", re.sub(r"<[^>]+>", "", html.unescape(h)))
cache = {}
for line in open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "jobs.txt")):
    i, url = line.split(); p = urllib.parse.urlparse(url); q = urllib.parse.parse_qs(p.query); parts = p.path.strip("/").split("/")
    try:
        if "ashbyhq.com" in p.netloc:
            slug, uid = parts[0], parts[1]
            if slug not in cache: cache[slug] = get(f"https://api.ashbyhq.com/posting-api/job-board/{slug}?includeCompensation=true")["jobs"]
            j = next(x for x in cache[slug] if x["id"] == uid)
            body = f"TITLE: {j['title']}\nLOC: {j.get('location')} | secondary: {[s.get('location') for s in j.get('secondaryLocations',[])]} | remote={j.get('isRemote')} workplace={j.get('workplaceType')} type={j.get('employmentType')}\nADDR: {j.get('address')}\nCOMP: {(j.get('compensation') or {}).get('compensationTierSummary')}\n\n{j.get('descriptionPlain') or text(j.get('descriptionHtml'))}"
        elif "lever.co" in p.netloc:
            j = get(f"https://api.lever.co/v0/postings/{parts[0]}/{parts[1]}")
            c = j.get("categories", {})
            lists = "\n".join(f"{l['text']}\n{text(l['content'])}" for l in j.get("lists", []))
            body = f"TITLE: {j['text']}\nCATS: {c}\nWORKPLACE: {j.get('workplaceType')}\n\n{j.get('descriptionPlain','')}\n{lists}\n{j.get('additionalPlain','')}"
        else:
            if "greenhouse.io" in p.netloc: tok, jid = parts[0], parts[2]
            else:
                tok = next(v for k, v in GH.items() if k in p.netloc or k in p.path); jid = q["gh_jid"][0]
            j = get(f"https://boards-api.greenhouse.io/v1/boards/{tok}/jobs/{jid}?content=true")
            body = f"TITLE: {j['title']}\nLOC: {(j.get('location') or {}).get('name')}\n\n{text(j['content'])}"
        open(f"{OUT}/{i}.txt", "w").write(body)
    except Exception as e:
        print("FAIL", i, url, repr(e)); open(f"{OUT}/{i}.FAILED", "w").write(repr(e))
