#!/usr/bin/env python3
"""Expand compact hand-written labels (labels_compact.py) into labels_01.jsonl and validate."""
import json, sys, os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
FAM={"software_engineering","machine_learning_ai","data","security","infrastructure_devops_sre","hardware_embedded","product_management","design","sales","customer_success_support","marketing","recruiting_hr","finance_accounting","legal","operations","research","other"}
SEN={"intern","new_grad","entry","mid","senior","staff_plus","manager_director_exec","unknown"}
def L(id, fam, sen, ec, cc, rem, emp="full_time", conf="high", notes="", sp="not_stated", q="", gw=None, nyc=False):
    gw = gw or {"required": False, "quote": "", "start": None, "end": None}
    if isinstance(gw, tuple): gw = {"required": True, "quote": gw[0], "start": gw[1], "end": gw[2]}
    return {"id": id, "fetch_failed": False, "role_family": fam, "seniority": sen, "early_career": ec, "countries": cc,
            "us_eligible": "US" in cc, "nyc": nyc, "remote": rem, "sponsorship": sp, "sponsorship_quote": q,
            "grad_window": gw, "employment_type": emp, "confidence": conf, "notes": notes}
if __name__ == "__main__":
    from labels_compact import ROWS
    ids=[int(l.split()[0]) for l in open(os.path.join(os.path.dirname(os.path.abspath(__file__)),"jobs.txt"))]
    rows={r["id"]:r for r in ROWS}
    out=open(os.path.join(os.path.dirname(os.path.abspath(__file__)),"../../labels_01.jsonl"),"w")
    miss=[i for i in ids if i not in rows]; print("missing",miss, "extra",[i for i in rows if i not in ids], "dups", len(ROWS)-len(rows))
    for i in ids:
        r=rows.get(i)
        if not r: continue
        assert r["role_family"] in FAM and r["seniority"] in SEN, i
        assert r["remote"] in ("remote","hybrid","onsite","unspecified"), i
        assert r["sponsorship"] in ("offers","does_not_offer","not_stated"), i
        assert r["employment_type"] in ("full_time","intern","contract","part_time","other"), i
        assert r["sponsorship"]=="not_stated" or r["sponsorship_quote"], i
        out.write(json.dumps(r,ensure_ascii=False)+"\n")
