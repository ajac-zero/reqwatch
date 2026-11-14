#!/usr/bin/env python3
"""Sanity check labels_00.jsonl: all ids present, schema valid, quotes appear verbatim in cached text."""
import json, os, sys, re
HERE = os.path.dirname(os.path.abspath(__file__))
CACHE = sys.argv[1] if len(sys.argv) > 1 else "/tmp/gold"
RF = {"software_engineering","machine_learning_ai","data","security","infrastructure_devops_sre","hardware_embedded","product_management","design","sales","customer_success_support","marketing","recruiting_hr","finance_accounting","legal","operations","research","other"}
SEN = {"intern","new_grad","entry","mid","senior","staff_plus","manager_director_exec","unknown"}
REM = {"remote","hybrid","onsite","unspecified"}; SP = {"offers","does_not_offer","not_stated"}
ET = {"full_time","intern","contract","part_time","other"}; CF = {"high","medium","low"}
ids = [int(l.split()[0]) for l in open(os.path.join(HERE, "jobs_00.txt")) if l.strip()]
rows = [json.loads(l) for l in open(os.path.join(HERE, "..", "labels_00.jsonl"))]
errs = []
if [r["id"] for r in rows] != ids: errs.append("ids missing/extra/out of order")
norm = lambda s: re.sub(r"\s+", " ", s.replace("\u2019", "'").replace("\u2018","'").replace("\u201c",'"').replace("\u201d",'"')).strip()
mon = re.compile(r"^\d{4}-(0[1-9]|1[0-2])$")
for r in rows:
    i = r["id"]
    if r["fetch_failed"]:
        if len(r) != 2: errs.append(f"{i}: failed row has labels")
        continue
    chk = [(r["role_family"] in RF, "role_family"), (r["seniority"] in SEN, "seniority"), (isinstance(r["early_career"], bool), "early_career"),
           (r["countries"] and all(re.fullmatch(r"[A-Z]{2}", c) for c in r["countries"]), "countries"), (isinstance(r["us_eligible"], bool) and r["us_eligible"] == ("US" in r["countries"]), "us_eligible"),
           (isinstance(r["nyc"], bool), "nyc"), (r["remote"] in REM, "remote"), (r["sponsorship"] in SP, "sponsorship"),
           (r["employment_type"] in ET, "employment_type"), (r["confidence"] in CF, "confidence"),
           (set(r["grad_window"]) == {"required","quote","start","end"}, "grad_window keys"),
           (all(v is None or mon.match(v) for v in (r["grad_window"]["start"], r["grad_window"]["end"])), "grad dates"),
           ((r["sponsorship"] == "not_stated") == (r["sponsorship_quote"] == ""), "sponsorship quote consistency")]
    errs += [f"{i}: bad {n}" for ok, n in chk if not ok]
    if r["nyc"] and "US" not in r["countries"]: errs.append(f"{i}: nyc without US")
    text = norm(open(os.path.join(CACHE, f"{i}.txt")).read())
    for q in (r["sponsorship_quote"], r["grad_window"]["quote"]):
        if q and norm(q) not in text: errs.append(f"{i}: quote not verbatim: {q[:60]}")
print(len(rows), "rows;", sum(r["fetch_failed"] for r in rows), "fetch_failed;", len(errs), "errors")
print("\n".join(errs)); sys.exit(1 if errs else 0)
