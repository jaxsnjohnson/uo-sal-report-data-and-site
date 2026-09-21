"""Adapt explicitly selected HTML captures to the explorer's timeline model.

Keep source files immutable. Match only a unique name variant AND hire date;
retain uncertain identities separately. Quarantine suspicious salary units.
"""

import hashlib
import json
import re
import unicodedata
from collections import Counter, defaultdict
from datetime import datetime
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
FIELD_MAP = {
    "Job Title": "Job Title", "Job Type": "Job Type", "Rank": "Rank",
    "Rank Effective Date": "Rank Effective Date", "Appointment Begin Date": "Appt Begin Date",
    "Appointment End Date": "Appt End Date", "Appointment Percentage": "Appt Percent",
    "Appointment Basis": "Salary Term",
}


def normalized_name(value):
    value = unicodedata.normalize("NFKD", value).encode("ascii", "ignore").decode().lower()
    return " ".join(re.sub(r"[^a-z0-9 ]", "", value).split())


def normalized_date(value):
    for fmt in ("%m/%d/%Y", "%d-%b-%Y", "%Y-%m-%d"):
        try:
            return datetime.strptime(value, fmt).date().isoformat()
        except ValueError:
            pass
    raise ValueError(f"Invalid hire date: {value!r}")


def identity_lookups(database):
    exact, abbreviated = defaultdict(set), defaultdict(set)
    for name, person in database.items():
        hired = person.get("Meta", {}).get("First Hired", "")
        if not hired:
            continue
        hired = normalized_date(hired)
        if "," in name:
            last, given = name.split(",", 1)
            given = given.strip()
            if not given:
                continue
            exact[(normalized_name(given + " " + last), hired)].add(name)
            abbreviated[(normalized_name(given.split()[0] + " " + last), hired)].add(name)
        else:
            exact[(normalized_name(name), hired)].add(name)
    return exact, abbreviated


def import_captures(database, config_path=ROOT / "report_imports.json"):
    config_path = Path(config_path)
    if not config_path.exists():
        return []
    exact, abbreviated = identity_lookups(database)
    prepared = []
    for relative in json.loads(config_path.read_text())["captures"]:
        folder = config_path.parent / relative
        manifest = json.loads((folder / "manifest.json").read_text())
        raw = (folder / "data.json").read_bytes()
        expected = next(f["sha256"] for f in manifest["derived_files"] if f["file"] == "data.json")
        if hashlib.sha256(raw).hexdigest() != expected:
            raise ValueError(f"Capture checksum mismatch: {folder}")
        payload = json.loads(raw)
        if len(payload["records"]) != manifest["row_count"]:
            raise ValueError(f"Capture row count mismatch: {folder}")
        groups = defaultdict(list)
        for row in payload["records"]:
            fields = row["fields"]
            key = (fields["Name"], normalized_date(fields["Date of First Hire"]))
            groups[key].append(row)
        for (source_name, hired), rows in groups.items():
            key = (normalized_name(source_name), hired)
            # A source may drop middle names. Even an exact short-name match
            # must not override a second historical candidate with a middle name.
            candidates = exact.get(key, set()) | abbreviated.get(key, set())
            prepared.append({"source_name": source_name, "hired": hired, "rows": rows,
                             "candidates": sorted(candidates), "relative": relative,
                             "payload": payload})

    # Do not merge two distinct source identities into the same old profile on a date.
    claims = Counter((p["payload"]["capture_date"], p["candidates"][0]) for p in prepared if len(p["candidates"]) == 1)
    names = Counter((p["payload"]["capture_date"], p["source_name"]) for p in prepared)
    audit = []
    for item in prepared:
        payload = item["payload"]
        date = payload["capture_date"]
        candidates = item["candidates"]
        matched = len(candidates) == 1 and claims[(date, candidates[0])] == 1
        status = "matched_name_and_hire_date" if matched else ("ambiguous" if candidates else "unmatched")
        name = candidates[0] if matched else item["source_name"]
        if not matched and (name in database or names[(date, name)] > 1):
            name += f" [hired {item['hired']}; {payload['classification']}]"
        if not matched and name in database:
            raise ValueError(f"Unresolved identity collision: {name}")
        first = item["rows"][0]["fields"]
        meta = {"First Hired": first["Date of First Hire"], "Home Orgn": first["Home Org"],
                "Adj Service Date": first["Adjusted Service Date"]}
        jobs = []
        review_count = 0
        for row in item["rows"]:
            fields = row["fields"]
            job = {model: fields.get(source, "") for source, model in FIELD_MAP.items()}
            job["Reported Salary Rate"] = fields["Annual Salary Rate"]
            job["Source Page"] = f"{item['relative']}/{row['source_page']}"
            rate = float(fields["Annual Salary Rate"].replace(",", ""))
            pct = float(fields["Appointment Percentage"])
            if not 0 <= pct <= 100:
                raise ValueError(f"Unexpected appointment percentage: {pct}")
            reason = ""
            if rate <= 0:
                reason = "Source reports zero or negative pay; a usable annual rate is unavailable."
            elif rate < 1000:
                reason = "Source labels this value as annual salary, but its units are uncertain. No conversion has been assumed."
            job["Annual Salary Rate"] = "" if reason else str(rate)
            if reason:
                job["Pay Review Reason"] = reason
                review_count += 1
            # Home organization is preserved as such; the source has no Job Org.
            job["Home Orgn"] = fields["Home Org"]
            jobs.append(job)
        person = database.setdefault(name, {"Meta": meta, "Timeline": []})
        if any(s["Date"] == date for s in person["Timeline"]):
            raise ValueError(f"Duplicate snapshot date for {name}: {date}")
        person["Timeline"].append({
            "Date": date, "DateBasis": "capture", "Source": f"{Path(item['relative']).name}/index.html",
            "SourceUrl": f"{item['relative']}/index.html", "SourceName": item["source_name"],
            "IdentityMatch": status, "Jobs": jobs, "SnapshotDetails": meta,
        })
        audit.append({"sourceName": item["source_name"], "hireDate": item["hired"], "profile": name,
                      "classification": payload["classification"], "captureDate": date,
                      "identityMatch": status, "candidates": candidates, "sourceRows": len(jobs),
                      "payReviewRows": review_count})
    return audit
