#!/usr/bin/env python3
"""Fetch full posting text for each job id into OUT dir (default /tmp/chunk02). Fetch only; no labeling."""
import sys, os, re, json, html, urllib.request
OUT = sys.argv[1] if len(sys.argv) > 1 else "/tmp/chunk02"
os.makedirs(OUT, exist_ok=True)
def get(u):
    r = urllib.request.Request(u, headers={"User-Agent": "Mozilla/5.0"})
    return json.load(urllib.request.urlopen(r, timeout=60))
def txt(h):
    h = html.unescape(h or "")
    h = re.sub(r"</(p|li|h\d|div|br|ul)>|<br ?/?>", "\n", h)
    h = re.sub(r"<li>", "- ", h)
    return re.sub(r"\n\s*\n+", "\n", html.unescape(re.sub(r"<[^>]+>", "", h)))
cache = {}
for line in open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "jobs.txt")):
    jid, url = line.split()
    p = url.split("/")
    try:
        if "lever.co" in url:
            d = get(f"https://api.lever.co/v0/postings/{p[3]}/{p[4]}")
            body = f"TITLE: {d['text']}\nLOCATION: {d['categories']}\nWORKPLACE: {d.get('workplaceType')}\n\n{d.get('descriptionPlain','')}\n" + "".join(f"\n## {l['text']}\n{txt(l['content'])}" for l in d.get("lists", [])) + "\n" + d.get("additionalPlain", "")
        elif "greenhouse" in url:
            d = get(f"https://boards-api.greenhouse.io/v1/boards/{p[3]}/jobs/{p[5]}?content=true")
            body = f"TITLE: {d['title']}\nLOCATION: {d['location']['name']}\n\n{txt(d['content'])}"
        else:
            slug = p[3]
            if slug not in cache:
                cache[slug] = get(f"https://api.ashbyhq.com/posting-api/job-board/{slug}?includeCompensation=true")["jobs"]
            d = next(j for j in cache[slug] if j["id"] == p[4])
            body = f"TITLE: {d['title']}\nLOCATION: {d.get('location')} | secondary: {d.get('secondaryLocations')} | address: {d.get('address')}\nREMOTE: {d.get('isRemote')} WORKPLACE: {d.get('workplaceType')} EMPLOYMENT: {d.get('employmentType')}\n\n{d.get('descriptionPlain','')}"
        open(f"{OUT}/{jid}.txt", "w").write(body)
    except Exception as e:
        print("FAIL", jid, url, e)
        open(f"{OUT}/{jid}.FAILED", "w").write(str(e))
