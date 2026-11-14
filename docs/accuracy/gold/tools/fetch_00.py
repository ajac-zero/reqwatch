#!/usr/bin/env python3
"""Fetch + cache full posting text for chunk 00. Output: <OUT>/<id>.txt (plain text) or <id>.FAILED."""
import json, os, re, sys, html, urllib.request, urllib.parse
HERE = os.path.dirname(os.path.abspath(__file__))
OUT = sys.argv[1] if len(sys.argv) > 1 else "/tmp/gold"
CACHE = os.path.join(OUT, "_boards"); os.makedirs(CACHE, exist_ok=True)
BOARDS = {"Stripe":"stripe","Cloudflare":"cloudflare","Datadog":"datadog","Figma":"figma","Reddit":"reddit",
 "Databricks":"databricks","Twilio":"twilio","Okta":"okta","MongoDB":"mongodb","Coinbase":"coinbase",
 "Elastic":"elastic","Instacart":"instacart","Pinterest":"pinterest","Duolingo":"duolingo"}
def get(url):
    r = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    return urllib.request.urlopen(r, timeout=60).read().decode("utf-8", "replace")
def cached(key, url):
    p = os.path.join(CACHE, re.sub(r"\W+", "_", key) + ".json")
    if not os.path.exists(p):
        open(p, "w").write(get(url))
    return json.load(open(p))
def text(h):
    h = html.unescape(h or "")
    h = re.sub(r"<(br|/p|/li|/h\d|/div|/ul)[^>]*>", "\n", h); h = re.sub(r"<li[^>]*>", "- ", h)
    h = html.unescape(re.sub(r"<[^>]+>", "", h))
    return re.sub(r"\n\s*\n+", "\n", h).strip()
def lever_text(j):
    parts = [j.get("text",""), json.dumps(j.get("categories",{})), "workplaceType: "+str(j.get("workplaceType")), j.get("descriptionPlain") or text(j.get("description"))]
    for l in j.get("lists", []): parts += [l.get("text",""), text(l.get("content"))]
    parts.append(j.get("additionalPlain") or text(j.get("additional")))
    return "\n".join(parts)
for line in open(os.path.join(HERE, "jobs_00.txt")):
    if not line.strip(): continue
    id_, co, url = line.split()
    try:
        u = urllib.parse.urlparse(url); q = urllib.parse.parse_qs(u.query)
        if "lever.co" in u.netloc:
            _, slug, uuid = u.path.split("/")[:3]
            j = json.loads(get(f"https://api.lever.co/v0/postings/{slug}/{uuid}"))
            body = lever_text(j)
        elif "ashbyhq.com" in u.netloc:
            _, slug, uuid = u.path.split("/")[:3]
            data = cached("ashby_"+slug, f"https://api.ashbyhq.com/posting-api/job-board/{slug}?includeCompensation=true")
            j = next(x for x in data["jobs"] if x["id"] == uuid)
            body = "\n".join([j.get("title",""), "location: "+str(j.get("location")), "secondary: "+json.dumps(j.get("secondaryLocations")), "workplaceType: "+str(j.get("workplaceType")), "isRemote: "+str(j.get("isRemote")), "employmentType: "+str(j.get("employmentType")), "address: "+json.dumps(j.get("address")), "comp: "+json.dumps(j.get("compensation",{}).get("compensationTierSummary") if j.get("compensation") else None), j.get("descriptionPlain") or text(j.get("descriptionHtml"))])
        else:
            tok = BOARDS[co]; jid = q["gh_jid"][0] if "gh_jid" in q else u.path.rstrip("/").split("/")[-1]
            j = json.loads(get(f"https://boards-api.greenhouse.io/v1/boards/{tok}/jobs/{jid}?content=true"))
            body = "\n".join([j.get("title",""), "location: "+json.dumps(j.get("location")), "offices: "+json.dumps([o.get("name") for o in j.get("offices",[])]), text(j.get("content"))])
        open(os.path.join(OUT, id_+".txt"), "w").write(f"ID {id_} {co} {url}\n{body}\n")
    except Exception as e:
        open(os.path.join(OUT, id_+".FAILED"), "w").write(f"{url}\n{e!r}\n"); print("FAIL", id_, co, repr(e)[:100])
