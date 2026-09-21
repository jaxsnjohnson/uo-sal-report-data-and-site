#!/usr/bin/env python3
"""Read-only comparison of captured pay flags with archived employee histories.

Writes analysis artifacts only; does not change salary values or identity links.
"""

import argparse
import hashlib
import json
import re
from collections import Counter, defaultdict
from datetime import datetime
from decimal import Decimal, ROUND_HALF_UP
from pathlib import Path

from scripts.import_archived_reports import identity_lookups, normalized_date, normalized_name


ROOT = Path(__file__).resolve().parents[1]
HOURS = Decimal(2080)


def number(value):
    if value is None or value == "":
        return None
    return Decimal(str(value).replace(",", ""))


def date(value):
    if not value:
        return None
    return normalized_date(value)


def source_class(snapshot):
    return "unclassified" if "unclassified" in snapshot["Source"].lower() else "classified"


def select_prior_job(snapshot, title):
    """Prefer one exact case-insensitive title match; otherwise only a sole job.

    Never choose a job by which salary happens to match the new rate.
    """
    jobs = snapshot.get("Jobs", [])
    exact = [job for job in jobs if job.get("Job Title", "").casefold() == title.casefold()]
    if len(exact) == 1:
        return exact[0], "same_title"
    if len(jobs) == 1:
        return jobs[0], "sole_job_changed_title"
    return None, "ambiguous_job"


def archived_evidence(root, profile, snapshot, cache):
    filename = snapshot["Source"]
    if not filename.endswith(".txt"):
        return {"source": filename}
    path = root / "temp_txt" / filename
    if not path.exists():
        return {"pdf": "reports/" + filename[:-4] + ".pdf", "excerpt_available": False}
    if filename not in cache:
        cache[filename] = path.read_text()
    text = cache[filename]
    match = re.search(r"Name:\s*" + re.escape(profile) + r"\s+First Hired:", text)
    if not match:
        raise ValueError(f"Could not corroborate parsed name in source text: {profile}, {filename}")
    end = re.search(r"-{10,}", text[match.start():])
    excerpt = text[match.start():match.start() + end.start()] if end else text[match.start():]
    return {"pdf": "reports/" + filename[:-4] + ".pdf",
            "page": text[:match.start()].count("\f") + 1,
            "excerpt": excerpt.strip()}


def compare_job(current_rate, prior_job):
    explicit_hourly = number(prior_job.get("Hourly Rate"))
    monthly = number(prior_job.get("Full-Time Monthly Salary"))
    annual = number(prior_job.get("Annual Salary Rate"))
    if explicit_hourly is not None:
        hourly, basis = explicit_hourly, "explicit_hourly"
    elif monthly is not None:
        hourly, basis = monthly * 12 / HOURS, "monthly_x12_div2080"
    elif annual is not None and annual > 12:
        hourly, basis = annual / HOURS, "annual_div2080"
    else:
        return {"comparison": "missing_prior_rate"}
    if hourly <= 0:
        return {"comparison": "nonpositive_prior_rate"}
    rounded = hourly.quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)
    change = (current_rate / hourly - 1) * 100
    comparison = ("same_cent" if current_rate == rounded else
                  "increase_up_to_10pct" if 0 < change <= 10 else "outside_10pct")
    return {"comparison": comparison, "prior_hourly_equivalent": float(hourly),
            "prior_hourly_rounded": float(rounded), "comparison_basis": basis,
            "equivalent_rate_change_pct": float(change),
            "current_x2080_scenario": float(current_rate * HOURS)}


def analyze(root=ROOT, capture_date="2026-09-18"):
    database = {}
    input_hashes = []
    for path in sorted((root / "data/people").glob("*.json")):
        raw = path.read_bytes()
        database.update(json.loads(raw))
        input_hashes.append({"file": str(path.relative_to(root)), "sha256": hashlib.sha256(raw).hexdigest()})
    historic = {}
    imported = {}
    for profile, person in database.items():
        history = sorted([s for s in person["Timeline"] if s.get("DateBasis") != "capture" and s["Date"] < capture_date], key=lambda s: s["Date"])
        if history:
            historic[profile] = {"Meta": person["Meta"], "Timeline": history}
        for snap in person["Timeline"]:
            if snap.get("DateBasis") != "capture" or snap["Date"] != capture_date:
                continue
            key = (source_class(snap), snap["SourceName"], date(snap["SnapshotDetails"]["First Hired"]))
            if key in imported:
                raise ValueError(f"Duplicate source identity: {key}")
            imported[key] = (profile, snap)
    exact, abbreviated = identity_lookups(historic)
    cache = {}
    comparisons = []
    control = Counter()
    for kind in ("classified", "unclassified"):
        relative = f"reports/{capture_date}-{kind}/data.json"
        raw = (root / relative).read_bytes()
        input_hashes.append({"file": relative, "sha256": hashlib.sha256(raw).hexdigest()})
        payload = json.loads(raw)
        manifest = json.loads((root / relative).with_name("manifest.json").read_text())
        expected = next(f["sha256"] for f in manifest["derived_files"] if f["file"] == "data.json")
        assert hashlib.sha256(raw).hexdigest() == expected
        for row in payload["records"]:
            fields = row["fields"]
            current_rate = number(fields["Annual Salary Rate"])
            key = (kind, fields["Name"], date(fields["Date of First Hire"]))
            profile, snap = imported[key]
            history = historic.get(profile, {}).get("Timeline", [])
            matched = snap["IdentityMatch"] == "matched_name_and_hire_date"
            prior = history[-1] if matched and history else None
            previous_job, job_match = select_prior_job(prior, fields["Job Title"]) if prior else (None, None)
            if current_rate >= 1000:
                if kind == "classified" and previous_job and source_class(prior) == kind:
                    annual = number(previous_job.get("Annual Salary Rate"))
                    if annual and annual > 12:
                        delta = (current_rate / annual - 1) * 100
                        control["comparable_annual_rows"] += 1
                        control["annual_within_0.05pct"] += abs(delta) <= Decimal("0.05")
                        control["annual_within_10pct"] += abs(delta) <= 10
                continue

            record = {"classification": kind, "source_name": fields["Name"], "profile": profile,
                      "identity_match": snap["IdentityMatch"], "current_fields": fields,
                      "current_source_page": f"reports/{capture_date}-{kind}/{row['source_page']}",
                      "flag": "zero" if current_rate == 0 else "small_positive",
                      "current_value": float(current_rate), "prior": None}
            end = date(fields.get("Appointment End Date"))
            record["current_end_date_status"] = "missing" if not end else ("before_capture" if end < capture_date else "on_or_after_capture")
            if prior:
                record["prior"] = {"date": prior["Date"], "classification": source_class(prior),
                                   "age_days": (datetime.fromisoformat(capture_date) - datetime.fromisoformat(prior["Date"])).days,
                                   "job_match": job_match, "selected_job": previous_job,
                                   "all_jobs": prior["Jobs"],
                                   "evidence": archived_evidence(root, profile, prior, cache)}
                if current_rate > 0 and previous_job:
                    record.update(compare_job(current_rate, previous_job))
                if current_rate == 0:
                    rates = [number(j.get("Annual Salary Rate")) for j in prior["Jobs"]]
                    record["prior_has_positive_annual"] = any(r is not None and r > 12 for r in rates)
                    record["prior_has_explicit_zero"] = any(r == 0 for r in rates if r is not None)
                    record["comparison"] = ("previous_positive_annual" if record["prior_has_positive_annual"] else
                                            "previous_explicit_zero" if record["prior_has_explicit_zero"] else "prior_rate_missing")
                    record["history_ever_explicit_zero"] = any(
                        number(j.get("Annual Salary Rate")) == 0 for s in history for j in s["Jobs"])
                    record["history_has_all_rates_missing_snapshot"] = any(
                        s["Jobs"] and all(not j.get("Annual Salary Rate") for j in s["Jobs"]) for s in history)
            else:
                candidate_key = (normalized_name(fields["Name"]), key[2])
                candidates = sorted(exact.get(candidate_key, set()) | abbreviated.get(candidate_key, set()))
                record["candidate_histories_not_used"] = [
                    {"profile": name, "latest_date": historic[name]["Timeline"][-1]["Date"],
                     "latest_jobs": historic[name]["Timeline"][-1]["Jobs"]} for name in candidates]
            comparisons.append(record)

    groups = []
    for kind, flag in (("classified", "small_positive"), ("classified", "zero"),
                       ("unclassified", "small_positive"), ("unclassified", "zero")):
        rows = [r for r in comparisons if r["classification"] == kind and r["flag"] == flag]
        groups.append({"classification": kind, "flag": flag, "rows": len(rows),
                       "identity_matches": dict(Counter(r["identity_match"] for r in rows)),
                       "comparison_results": dict(Counter(r.get("comparison", "no_comparable_history") for r in rows))})
    zeros = [r for r in comparisons if r["flag"] == "zero"]
    zero_summary = {"rows": len(zeros), "matched_history": sum(r["prior"] is not None for r in zeros),
                    "previous_positive_annual": sum(r.get("prior_has_positive_annual", False) for r in zeros),
                    "previous_explicit_zero": sum(r.get("prior_has_explicit_zero", False) for r in zeros),
                    "histories_with_any_explicit_zero": sum(r.get("history_ever_explicit_zero", False) for r in zeros),
                    "histories_with_missing_rate_snapshot": sum(r.get("history_has_all_rates_missing_snapshot", False) for r in zeros),
                    "current_end_dates": dict(Counter(r["current_end_date_status"] for r in zeros)),
                    "positive_appointment_percentage": sum(number(r["current_fields"]["Appointment Percentage"]) > 0 for r in zeros),
                    "current_job_titles": dict(Counter(r["current_fields"]["Job Title"] for r in zeros))}
    return {"capture_date": capture_date,
            "method": {"hours_per_year_scenario": 2080, "matching": "Use existing unique name-variant-and-hire-date links only; no new identity merges.",
                       "prior_selection": "Most recent pre-capture snapshot of linked profile; exact case-insensitive job title if unique, otherwise sole job, never salary proximity.",
                       "unit_comparison": "Prior monthly * 12 / 2080, explicit hourly, or annual / 2080; compare to new field to nearest cent (half up). This is evidence for a unit hypothesis, not authorization to change pay.",
                       "scope": "Archived sources only; no live refresh. Capture date is not a confirmed payroll effective date."},
            "input_hashes": input_hashes, "group_summary": groups, "zero_summary": zero_summary,
            "classified_annual_control": dict(control), "records": comparisons}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--capture-date", default="2026-09-18")
    parser.add_argument("--output", type=Path, default=ROOT / "analysis/2026-09-18-pay-review/comparisons.json")
    args = parser.parse_args()
    result = analyze(capture_date=args.capture_date)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n")
    print(json.dumps({k: result[k] for k in ("group_summary", "zero_summary", "classified_annual_control")}, indent=2))


if __name__ == "__main__":
    main()
