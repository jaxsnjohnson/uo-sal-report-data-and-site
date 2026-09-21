#!/usr/bin/env python3
import argparse
import json
import os
import re
import string
from bisect import bisect_left, bisect_right
from collections import defaultdict
from datetime import datetime

COLA_EVENTS = []  # UO events require UO-specific source verification.
COLA_TOLERANCE_PCT = 0.4

_NON_NUMERIC_RE = re.compile(r"[^0-9.-]+")
_ASCII_NON_NUMERIC_DELETE_MAP = {
    i: None for i in range(128) if chr(i) not in "0123456789.-"
}
_ASCII_LOWERCASE = string.ascii_lowercase

ROOT = os.path.dirname(os.path.abspath(__file__))
RAW_PATH = os.path.join(ROOT, "data.json")
OUT_DIR = os.path.join(ROOT, "data")
PEOPLE_DIR = os.path.join(OUT_DIR, "people")
INDEX_PATH = os.path.join(OUT_DIR, "index.json")
AGG_PATH = os.path.join(OUT_DIR, "aggregates.json")
SEARCH_INDEX_PATH = os.path.join(OUT_DIR, "search-index.json")
PEER_MEDIAN_PATH = os.path.join(OUT_DIR, "peer-medians.json")
IMPORT_AUDIT_PATH = os.path.join(OUT_DIR, "import-audit.json")

PAIRED_SNAPSHOT_WINDOW_DAYS = 120

ROLE_GROUP_INCLUDE_TERMS = [
    "associate director",
    "assistant director",
    "senior director",
    "director",
    "manager",
    "head",
    "chair",
]
ROLE_GROUP_EXCLUDE_TERMS = [
    "vice president",
    "provost",
    "chancellor",
    "president",
    "chief",
    "dean",
]
ROLE_GROUP_INCLUDE_RE = re.compile("|".join(re.escape(term) for term in ROLE_GROUP_INCLUDE_TERMS), re.I)
ROLE_GROUP_EXCLUDE_RE = re.compile("|".join(re.escape(term) for term in ROLE_GROUP_EXCLUDE_TERMS), re.I)


def parse_float(val):
    if val is None:
        return None
    if isinstance(val, (int, float)):
        return float(val)
    s = str(val)
    # Fast path for common ASCII input values; keeps regex fallback for exact behavior on non-ASCII.
    if s.isascii():
        cleaned = s.translate(_ASCII_NON_NUMERIC_DELETE_MAP)
    else:
        cleaned = _NON_NUMERIC_RE.sub("", s)
    if not cleaned:
        return None
    try:
        return float(cleaned)
    except (TypeError, ValueError, OverflowError):
        return None


def calc_job_rate_and_missing(job):
    raw_rate = job.get("Annual Salary Rate")
    rate_num = parse_float(raw_rate)
    term = (job.get("Salary Term") or "").strip()
    missing = False
    if job.get("Pay Review Reason"):
        missing = True
        rate = 0.0
    elif term == "mo" and rate_num is not None and rate_num > 0 and rate_num <= 12:
        missing = True
        rate = 0.0
    else:
        rate = rate_num or 0.0
    pct = parse_float(job.get("Appt Percent")) or 0.0
    return rate, pct, missing


def calculate_snapshot_pay(snapshot):
    if not snapshot or not snapshot.get("Jobs"):
        return 0.0
    if any(job.get("Pay Review Reason") for job in snapshot["Jobs"]):
        return 0.0
    if snapshot.get("PayMeasure") == "fiscal_year_pay":
        return sum(parse_float(job.get("Reported Pay")) or 0.0 for job in snapshot["Jobs"])
    total = 0.0
    for job in snapshot.get("Jobs", []):
        rate, pct, _missing = calc_job_rate_and_missing(job)
        if rate > 0:
            total += rate * (pct / 100.0)
    return total


def _median_sorted(vals):
    n = len(vals)
    if n == 0:
        return 0.0
    mid = n >> 1
    if n & 1:
        return vals[mid]
    return (vals[mid - 1] + vals[mid]) * 0.5


def median(values, presorted=False):
    n = len(values)
    if n == 0:
        return 0.0
    if n == 1:
        return values[0]
    if n == 2:
        return (values[0] + values[1]) / 2.0

    vals = values if presorted else sorted(values)
    return _median_sorted(vals)


def build_cola_pairs(dates, events):
    if not dates:
        return []
    pairs = []
    for event in events:
        before = None
        after = None
        for d in dates:
            if d <= event["effective"]:
                before = d
            if after is None and d >= event["effective"]:
                after = d
        pairs.append({
            "label": event["label"],
            "effective": event["effective"],
            "pct": event["pct"],
            "beforeDate": before,
            "afterDate": after,
        })
    return pairs


def bucket_for_name(name):
    if not name:
        return "_"
    ch = name.strip()[0].lower()
    if ch in _ASCII_LOWERCASE:
        return ch
    return "_"


def class_state_from_source(source):
    src = (source or "").lower()
    if "unclass" in src:
        return "unclassified"
    if "class" in src:
        return "classified"
    return ""


def safe_pct(part, total):
    return (part / total) * 100.0 if total else None


def quantile_sorted(values, p):
    if not values:
        return None
    if len(values) == 1:
        return values[0]
    idx = (len(values) - 1) * p
    lower = int(idx)
    upper = lower if idx == lower else lower + 1
    if lower == upper:
        return values[lower]
    weight = idx - lower
    return values[lower] * (1 - weight) + values[upper] * weight


def quantile(values, p):
    if not values:
        return None
    return quantile_sorted(sorted(values), p)


def safe_ratio(num, den):
    if num is None or den is None or den <= 0:
        return None
    return num / den


def parse_date(value):
    if not value:
        return None
    text = str(value).strip()
    for fmt in ("%Y-%m-%d", "%d-%b-%Y", "%d-%B-%Y", "%m/%d/%Y"):
        try:
            return datetime.strptime(text, fmt).date()
        except ValueError:
            continue
    return None


def days_between(later, earlier):
    later_date = parse_date(later)
    earlier_date = parse_date(earlier)
    if not later_date or not earlier_date:
        return None
    return (later_date - earlier_date).days


def tenure_band_for_dates(hired, snapshot_date):
    hired_date = parse_date(hired)
    snap_date = parse_date(snapshot_date)
    if not hired_date or not snap_date:
        return None
    years = (snap_date - hired_date).days / 365.25
    if years < 0:
        return None
    if years >= 15:
        return "fifteenPlus"
    if years >= 7:
        return "sevenTo15"
    if years >= 3:
        return "threeTo7"
    return "lt3"


def get_person_hire_date(person):
    candidates = []
    meta = person.get("Meta") or {}
    if meta.get("First Hired"):
        candidates.append(meta.get("First Hired"))
    for snap in person.get("Timeline") or []:
        details = snap.get("SnapshotDetails") or {}
        if details.get("First Hired"):
            candidates.append(details.get("First Hired"))
    dated = [(parse_date(value), value) for value in candidates]
    dated = [(date_value, raw) for date_value, raw in dated if date_value]
    if not dated:
        return ""
    dated.sort(key=lambda item: item[0])
    return dated[0][1]


def empty_tenure_group():
    return {
        "counts": {"lt3": 0, "threeTo7": 0, "sevenTo15": 0, "fifteenPlus": 0},
        "total": 0,
    }


def empty_tenure_row():
    return {
        "classified": empty_tenure_group(),
        "unclassified": empty_tenure_group(),
        "overall": empty_tenure_group(),
    }


def add_tenure_count(row, class_state, band):
    class_key = "unclassified" if class_state == "unclassified" else "classified"
    row[class_key]["counts"][band] += 1
    row[class_key]["total"] += 1
    row["overall"]["counts"][band] += 1
    row["overall"]["total"] += 1


def compute_tenure_shares(group):
    counts = group["counts"]
    total = group["total"]
    return {
        "lt3": safe_pct(counts["lt3"], total),
        "threeTo7": safe_pct(counts["threeTo7"], total),
        "sevenTo15": safe_pct(counts["sevenTo15"], total),
        "fifteenPlus": safe_pct(counts["fifteenPlus"], total),
    }


def is_role_group_snapshot(jobs):
    titles = " | ".join((job.get("Job Title") or "") for job in (jobs or []))
    if not titles:
        return False
    return bool(ROLE_GROUP_INCLUDE_RE.search(titles)) and not bool(ROLE_GROUP_EXCLUDE_RE.search(titles))


def build_paired_history_stats(history_stats, window_days=PAIRED_SNAPSHOT_WINDOW_DAYS):
    rows = sorted(history_stats or [], key=lambda row: row.get("date") or "")
    paired = []
    seen = set()
    latest_classified = None
    latest_unclassified = None

    for row in rows:
        date = row.get("date") or ""
        if row.get("classified", 0) > 0:
            latest_classified = row
        if row.get("unclassified", 0) > 0:
            latest_unclassified = row
        if not latest_classified or not latest_unclassified:
            continue

        class_days = days_between(date, latest_classified.get("date"))
        unclass_days = days_between(date, latest_unclassified.get("date"))
        if class_days is None or unclass_days is None:
            continue
        if class_days < 0 or unclass_days < 0:
            continue
        if class_days > window_days or unclass_days > window_days:
            continue

        pair_key = (latest_classified.get("date"), latest_unclassified.get("date"))
        if pair_key in seen:
            continue
        seen.add(pair_key)

        payroll_classified = latest_classified.get("payrollClassified", 0.0) or 0.0
        payroll_unclassified = latest_unclassified.get("payrollUnclassified", 0.0) or 0.0
        paired.append({
            "date": date,
            "classifiedDate": latest_classified.get("date", ""),
            "unclassifiedDate": latest_unclassified.get("date", ""),
            "classified": latest_classified.get("classified", 0) or 0,
            "unclassified": latest_unclassified.get("unclassified", 0) or 0,
            "payroll": payroll_classified + payroll_unclassified,
            "payrollClassified": payroll_classified,
            "payrollUnclassified": payroll_unclassified,
            "windowDays": max(class_days, unclass_days),
        })
    return paired


def top_share(values, pct):
    if not values:
        return None
    sorted_values = sorted(values, reverse=True)
    total = sum(sorted_values)
    if total <= 0:
        return None
    count = max(1, int(len(sorted_values) * pct + 0.999999))
    return (sum(sorted_values[:count]) / total) * 100.0


def build_pay_concentration_points(dates, pay_values_by_date):
    points = []
    for date in dates:
        values = [value for value in pay_values_by_date.get(date, []) if value > 0]
        sorted_values = sorted(values)
        p10 = quantile_sorted(sorted_values, 0.10)
        p50 = quantile_sorted(sorted_values, 0.50)
        p90 = quantile_sorted(sorted_values, 0.90)
        points.append({
            "date": date,
            "headcount": len(sorted_values),
            "payroll": sum(sorted_values),
            "top1SharePct": top_share(sorted_values, 0.01),
            "top5SharePct": top_share(sorted_values, 0.05),
            "top10SharePct": top_share(sorted_values, 0.10),
            "p90P50Ratio": safe_ratio(p90, p50),
            "p50P10Ratio": safe_ratio(p50, p10),
        })
    return {"points": points}


def build_pay_distribution_points(dates, pay_values_by_date_class):
    points = []
    for date in dates:
        entry = pay_values_by_date_class.get(date, {})
        class_values = sorted(value for value in entry.get("classified", []) if value > 0)
        unclass_values = sorted(value for value in entry.get("unclassified", []) if value > 0)
        overall_values = sorted(value for value in entry.get("overall", []) if value > 0)
        points.append({
            "date": date,
            "pct10Class": quantile_sorted(class_values, 0.10),
            "pct50Class": quantile_sorted(class_values, 0.50),
            "pct90Class": quantile_sorted(class_values, 0.90),
            "pct10Unclass": quantile_sorted(unclass_values, 0.10),
            "pct50Unclass": quantile_sorted(unclass_values, 0.50),
            "pct90Unclass": quantile_sorted(unclass_values, 0.90),
            "pct10Overall": quantile_sorted(overall_values, 0.10),
            "pct50Overall": quantile_sorted(overall_values, 0.50),
            "pct90Overall": quantile_sorted(overall_values, 0.90),
        })
    return {"points": points}


def build_tenure_mix_points(dates, tenure_by_date):
    points = []
    for date in dates:
        row = tenure_by_date.get(date) or empty_tenure_row()
        points.append({
            "date": date,
            "classified": {
                "counts": row["classified"]["counts"],
                "shares": compute_tenure_shares(row["classified"]),
                "total": row["classified"]["total"],
            },
            "unclassified": {
                "counts": row["unclassified"]["counts"],
                "shares": compute_tenure_shares(row["unclassified"]),
                "total": row["unclassified"]["total"],
            },
            "overall": {
                "counts": row["overall"]["counts"],
                "shares": compute_tenure_shares(row["overall"]),
                "total": row["overall"]["total"],
            },
        })
    return {"points": points}


def build_role_group_concentration_points(dates, role_group_by_date):
    points = []
    for date in dates:
        row = role_group_by_date.get(date) or {
            "date": date,
            "roleGroup": 0,
            "total": 0,
            "payrollRoleGroup": 0.0,
            "payrollTotal": 0.0,
        }
        points.append({
            "date": date,
            "roleGroup": row["roleGroup"],
            "total": row["total"],
            "payrollRoleGroup": row["payrollRoleGroup"],
            "payrollTotal": row["payrollTotal"],
            "headcountSharePct": safe_pct(row["roleGroup"], row["total"]),
            "payrollSharePct": safe_pct(row["payrollRoleGroup"], row["payrollTotal"]),
        })
    return {
        "methodology": {
            "includeTerms": ROLE_GROUP_INCLUDE_TERMS,
            "excludeTerms": ROLE_GROUP_EXCLUDE_TERMS,
        },
        "points": points,
    }


def build_artifacts(data):
    index = {}
    buckets = defaultdict(dict)
    snap_pay_map = {}

    all_roles = set()
    snapshot_dates = set()
    stats_map = defaultdict(lambda: {
        "date": "",
        "classified": 0,
        "unclassified": 0,
        "payroll": 0.0,
        "payrollClassified": 0.0,
        "payrollUnclassified": 0.0,
    })
    peer_buckets = defaultdict(lambda: defaultdict(list))
    class_transitions = {}
    search_index = []
    import_audit = []
    pay_values_by_date = defaultdict(list)
    pay_values_by_date_class = defaultdict(lambda: {
        "classified": [],
        "unclassified": [],
        "overall": [],
    })
    tenure_by_date = defaultdict(empty_tenure_row)
    role_group_by_date = defaultdict(lambda: {
        "roleGroup": 0,
        "total": 0,
        "payrollRoleGroup": 0.0,
        "payrollTotal": 0.0,
    })

    latest_class_date = ""
    latest_unclass_date = ""

    # First pass: compute aggregates + index
    for name, person in data.items():
        timeline = person.get("Timeline", [])
        timeline.sort(key=lambda s: s.get("Date") or "")

        role_set = set()
        role_title_set = set()
        snap_by_date_pay = {}

        last_snap = timeline[-1] if timeline else None
        last_job = (last_snap.get("Jobs") or [{}])[0] if last_snap else {}

        pay_missing = False
        is_full_time = False
        total_pay = 0.0
        is_unclass = False
        last_date = last_snap.get("Date") if last_snap else None

        prev_is_unclass = None
        was_excluded = False
        first_exclusion_date = None
        started_classified = None  # track initial classification
        hire_date = get_person_hire_date(person)
        for idx, snap in enumerate(timeline):
            date = snap.get("Date")
            is_capture = snap.get("DateBasis") == "capture"
            if is_capture:
                import_audit.append({
                    "profile": name, "sourceName": snap.get("SourceName"), "captureDate": date,
                    "sourceUrl": snap.get("SourceUrl"), "identityMatch": snap.get("IdentityMatch"),
                    "sourceRows": len(snap.get("Jobs", [])),
                    "payReviewRows": sum(bool(j.get("Pay Review Reason")) for j in snap.get("Jobs", [])),
                })
            if date:
                snapshot_dates.add(date)

            src = (snap.get("Source") or "").lower()
            is_unclass = "unclass" in src
            class_state = class_state_from_source(src)
            if started_classified is None:
                started_classified = not is_unclass  # True if first snapshot is classified

            if prev_is_unclass is not None and (not prev_is_unclass) and is_unclass:
                if started_classified:
                    was_excluded = True
                    if not first_exclusion_date:
                        first_exclusion_date = date
            if prev_is_unclass is not None and is_unclass != prev_is_unclass and date and not is_capture:
                year = date[:4]
                if year:
                    entry = class_transitions.setdefault(year, {
                        "year": year,
                        "toUnclassified": 0,
                        "toClassified": 0
                    })
                    if is_unclass:
                        entry["toUnclassified"] += 1
                    else:
                        entry["toClassified"] += 1

            jobs = snap.get("Jobs") or []
            for job in jobs:
                title = job.get("Job Title")
                if title:
                    all_roles.add(title)
                    role_set.add(title.lower())
                    role_title_set.add(title)

            snap_pay = calculate_snapshot_pay(snap)
            if date:
                snap_by_date_pay[date] = snap_pay

            # stats + peer buckets
            if date and not is_capture:
                entry = stats_map[date]
                if not entry["date"]:
                    entry["date"] = date
                entry["payroll"] += snap_pay
                if is_unclass:
                    entry["unclassified"] += 1
                    entry["payrollUnclassified"] += snap_pay
                else:
                    entry["classified"] += 1
                    entry["payrollClassified"] += snap_pay

                if snap_pay > 0:
                    pay_values_by_date[date].append(snap_pay)
                    pay_values_by_date_class[date]["overall"].append(snap_pay)
                    if class_state in ("classified", "unclassified"):
                        pay_values_by_date_class[date][class_state].append(snap_pay)

                tenure_band = tenure_band_for_dates(hire_date, date)
                if tenure_band:
                    add_tenure_count(tenure_by_date[date], class_state, tenure_band)

                if jobs:
                    role_entry = role_group_by_date[date]
                    role_entry["total"] += 1
                    role_entry["payrollTotal"] += snap_pay
                    if is_role_group_snapshot(jobs):
                        role_entry["roleGroup"] += 1
                        role_entry["payrollRoleGroup"] += snap_pay

            # Do not create peer groups from capture Home Org: it is not Job Org.
            primary_job = jobs[0] if jobs else None
            if date and primary_job and not is_capture and snap_pay > 0:
                org = primary_job.get("Job Orgn") or "Unknown"
                role = primary_job.get("Job Title") or "Unknown"
                key = f"{org}||{role}"
                peer_buckets[date][key].append(snap_pay)

            if idx == len(timeline) - 1:
                total_pay = snap_pay
                # missing rate detection for last snapshot
                pay_missing = any(calc_job_rate_and_missing(job)[2] for job in jobs)
                # full-time detection for last snapshot
                for job in jobs:
                    _rate, pct, _missing = calc_job_rate_and_missing(job)
                    if pct >= 100:
                        is_full_time = True
                        break

            prev_is_unclass = is_unclass

        if last_snap:
            last_src = (last_snap.get("Source") or "").lower()
            is_unclass = "unclass" in last_src
            if last_date:
                if is_unclass:
                    if last_date > latest_unclass_date:
                        latest_unclass_date = last_date
                else:
                    if last_date > latest_class_date:
                        latest_class_date = last_date

        snap_pay_map[name] = snap_by_date_pay

        meta = (last_snap.get("SnapshotDetails", {}) if last_snap and last_snap.get("DateBasis") == "capture"
                else person.get("Meta", {}))
        search_role = last_job.get("Job Title") or ""
        search_org = last_job.get("Job Orgn") or ""
        home_org = meta.get("Home Orgn", "")
        first_hired = meta.get("First Hired", "")
        source_name = last_snap.get("SourceName", "") if last_snap else ""
        source_prefix = f"{source_name} " if source_name else ""
        search_str = f"{name} {source_prefix}{home_org} {first_hired} {search_role} {search_org}".lower()
        is_active = False
        target_date = latest_unclass_date if is_unclass else latest_class_date
        if last_date and (not target_date or last_date == target_date):
            is_active = True
        first_hired_year = None
        if first_hired:
            m = re.search(r"(\d{4})$", first_hired)
            if m:
                first_hired_year = int(m.group(1))
        top_roles = sorted(role_title_set)[:3]

        index[name] = {
            "Meta": {
                "First Hired": meta.get("First Hired", ""),
                "Home Orgn": meta.get("Home Orgn", ""),
                "Adj Service Date": meta.get("Adj Service Date", ""),
            },
            "_hasTimeline": bool(timeline),
            "_lastDate": last_date or "",
            "_lastJob": last_job,
            "_totalPay": total_pay,
            "_payMissing": pay_missing,
            "_isUnclass": is_unclass,
            "_isFullTime": is_full_time,
            "_roleStr": "\0".join(sorted(role_set)),
            "_searchStr": search_str,
            "_colaReceived": True,
            "_colaChecked": 0,
            "_colaMissedLabels": [],
            "_colaMissing": False,
            "_wasExcluded": was_excluded and is_unclass,
            "_exclusionDate": first_exclusion_date if (was_excluded and is_unclass) else "",
        }
        if last_snap and last_snap.get("DateBasis") == "capture":
            index[name].update(_captureDate=last_date, _sourceName=source_name,
                               _identityMatch=last_snap.get("IdentityMatch"))
        search_index.append({
            "name": name,
            "homeOrg": home_org,
            "lastOrg": search_org,
            "roles": top_roles,
            "isUnclass": is_unclass,
            "isActive": is_active,
            "isFullTime": is_full_time,
            "totalPay": total_pay,
            "firstHiredYear": first_hired_year,
            "lastDate": last_date or "",
            "hasFlags": bool(pay_missing),
            "wasExcluded": bool(was_excluded and is_unclass),
            "exclusionDate": first_exclusion_date if (was_excluded and is_unclass) else "",
        })
        if source_name:
            search_index[-1]["searchText"] = search_str
            search_index[-1]["payMissing"] = pay_missing

        bucket = bucket_for_name(name)
        buckets[bucket][name] = {
            "Meta": person.get("Meta", {}),
            "Timeline": timeline,
            "_wasExcluded": was_excluded and is_unclass,
            "_exclusionDate": first_exclusion_date if (was_excluded and is_unclass) else "",
        }

    # Finalize active flags once global latest snapshot dates are known.
    for record in search_index:
        if record.get("isUnclass"):
            target_date = latest_unclass_date
        else:
            target_date = latest_class_date
        last_date = record.get("lastDate") or ""
        record["isActive"] = bool(last_date and (not target_date or last_date == target_date))

    # Build peer medians + percentiles
    peer_median_map = {}
    for date, bucket_map in peer_buckets.items():
        for values in bucket_map.values():
            # Sort once so median and percentile both reuse the same ordering.
            values.sort()
        peer_median_map[date] = {
            key: median(values, presorted=True)
            for key, values in bucket_map.items()
        }

    # Compute per-person peer percentile (latest snapshot org+role)
    for name, idx in index.items():
        if not idx.get("_hasTimeline"):
            idx["_peerPercentile"] = None
            continue
        last_job = idx.get("_lastJob") or {}
        if not last_job:
            idx["_peerPercentile"] = None
            continue
        org = last_job.get("Job Orgn") or "Unknown"
        role = last_job.get("Job Title") or "Unknown"
        key = f"{org}||{role}"
        date = idx.get("_lastDate")
        last_pay = idx.get("_totalPay") or 0.0
        date_buckets = peer_buckets.get(date)
        bucket = date_buckets.get(key) if date_buckets else None
        if not bucket or len(bucket) <= 1 or last_pay <= 0:
            idx["_peerPercentile"] = None
            continue
        below = bisect_left(bucket, last_pay)
        equal = bisect_right(bucket, last_pay) - below
        idx["_peerPercentile"] = ((below + 0.5 * equal) / len(bucket)) * 100.0

    # COLA status (after snapshot dates are finalized)
    cola_pairs = build_cola_pairs(sorted(snapshot_dates), COLA_EVENTS)
    cola_eval_pairs = []
    for event in cola_pairs:
        before_date = event.get("beforeDate")
        after_date = event.get("afterDate")
        if not before_date or not after_date:
            continue
        if before_date == after_date:
            continue
        cola_eval_pairs.append((
            before_date,
            after_date,
            event["pct"] - COLA_TOLERANCE_PCT,
            event["label"],
        ))
    for name in data.keys():
        idx = index.get(name)
        if not idx:
            continue
        if idx.get("_isUnclass"):
            idx["_colaReceived"] = True
            idx["_colaChecked"] = 0
            idx["_colaMissedLabels"] = []
            idx["_colaMissing"] = False
            continue

        snap_by_date_pay = snap_pay_map.get(name, {})
        cola_received = False
        cola_checked = 0
        cola_missed = []
        for before_date, after_date, required_pct, label in cola_eval_pairs:
            before_pay = snap_by_date_pay.get(before_date, 0.0)
            if before_pay <= 0:
                continue
            after_pay = snap_by_date_pay.get(after_date, 0.0)
            cola_checked += 1
            pct_change = ((after_pay - before_pay) / before_pay) * 100.0
            if pct_change >= required_pct:
                cola_received = True
            else:
                cola_missed.append(label)

        idx["_colaReceived"] = cola_received
        idx["_colaChecked"] = cola_checked
        idx["_colaMissedLabels"] = cola_missed
        idx["_colaMissing"] = (not cola_received and cola_checked > 0)

    # Include full data-flag status for search filtering.
    idx_by_name = {r.get("name"): r for r in search_index}
    for name, idx in index.items():
        rec = idx_by_name.get(name)
        if not rec:
            continue
        rec["hasFlags"] = bool(idx.get("_payMissing") or idx.get("_colaMissing"))

    history_stats = sorted(stats_map.values(), key=lambda x: x["date"])
    snapshot_dates_sorted = sorted(snapshot_dates)
    historical_dates = sorted(stats_map)
    class_transitions_sorted = sorted(class_transitions.values(), key=lambda x: x["year"])

    aggregates = {
        "latestClassDate": latest_class_date,
        "latestUnclassDate": latest_unclass_date,
        "snapshotDates": snapshot_dates_sorted,
        "historyStats": history_stats,
        "pairedHistoryStats": build_paired_history_stats(history_stats),
        "classTransitions": class_transitions_sorted,
        "peerMedianUrl": "data/peer-medians.json",
        "payConcentration": build_pay_concentration_points(historical_dates, pay_values_by_date),
        "payDistribution": build_pay_distribution_points(historical_dates, pay_values_by_date_class),
        "tenureMix": build_tenure_mix_points(historical_dates, tenure_by_date),
        "roleGroupConcentration": build_role_group_concentration_points(historical_dates, role_group_by_date),
        "allRoles": sorted(all_roles),
    }
    if import_audit:
        aggregates["captureImport"] = {
            "latestDate": max(row["captureDate"] for row in import_audit),
            "profiles": len(import_audit),
            "sourceRows": sum(row["sourceRows"] for row in import_audit),
            "payReviewRows": sum(row["payReviewRows"] for row in import_audit),
            "matchedProfiles": sum(row["identityMatch"] == "matched_name_and_hire_date" for row in import_audit),
            "historicalChartsThrough": max(historical_dates) if historical_dates else None,
        }

    return {
        "index": index,
        "aggregates": aggregates,
        "searchIndex": search_index,
        "buckets": buckets,
        "peerMedianMap": peer_median_map,
        "importAudit": import_audit,
    }


def write_artifacts(artifacts):
    os.makedirs(PEOPLE_DIR, exist_ok=True)

    with open(INDEX_PATH, "w", encoding="utf-8") as f:
        json.dump(artifacts["index"], f, ensure_ascii=False)
    with open(AGG_PATH, "w", encoding="utf-8") as f:
        json.dump(artifacts["aggregates"], f, ensure_ascii=False)
    with open(SEARCH_INDEX_PATH, "w", encoding="utf-8") as f:
        json.dump({"records": artifacts["searchIndex"]}, f, ensure_ascii=False)
    with open(PEER_MEDIAN_PATH, "w", encoding="utf-8") as f:
        json.dump(artifacts["peerMedianMap"], f, ensure_ascii=False)
    with open(IMPORT_AUDIT_PATH, "w", encoding="utf-8") as f:
        json.dump(artifacts["importAudit"], f, ensure_ascii=False, indent=2)

    for bucket, bucket_data in artifacts["buckets"].items():
        out_path = os.path.join(PEOPLE_DIR, f"{bucket}.json")
        with open(out_path, "w", encoding="utf-8") as f:
            json.dump(bucket_data, f, ensure_ascii=False)

    print(f"Wrote index: {INDEX_PATH}")
    print(f"Wrote aggregates: {AGG_PATH}")
    print(f"Wrote peer medians: {PEER_MEDIAN_PATH}")
    print(f"Wrote search index: {SEARCH_INDEX_PATH}")
    print(f"Wrote {len(artifacts['buckets'])} bucket files in {PEOPLE_DIR}")


def load_data_from_args(args):
    if args.from_reports:
        from scripts.salary_report_parser import parse_reports
        return parse_reports(text_dir=args.text_dir, html_dir=args.html_dir, imports_path=args.imports)

    if not os.path.exists(args.input):
        raise SystemExit(f"Missing {args.input}. Run convert_data.sh first.")
    with open(args.input, "r", encoding="utf-8") as f:
        return json.load(f)


def parse_args(argv=None):
    parser = argparse.ArgumentParser(description="Build static-site data artifacts.")
    parser.add_argument("--input", default=RAW_PATH, help="Raw data JSON to read when not parsing reports.")
    parser.add_argument("--from-reports", action="store_true", help="Parse temp text and HTML reports directly.")
    parser.add_argument("--text-dir", default="temp_txt", help="Directory containing pdftotext output.")
    parser.add_argument("--html-dir", default="html_reports", help="Directory containing classified HTML snapshots.")
    parser.add_argument("--imports", default=os.path.join(ROOT, "report_imports.json"), help="Explicitly selected HTML captures to import.")
    parser.add_argument("--write-raw-data", metavar="PATH", help="Optionally write parsed raw JSON while building artifacts.")
    return parser.parse_args(argv)


def main(argv=None):
    args = parse_args(argv)
    if args.from_reports:
        from scripts.build_data import build
        build()
        return
    data = load_data_from_args(args)
    if args.write_raw_data:
        with open(args.write_raw_data, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
        print(f"Wrote raw data: {args.write_raw_data}")
    write_artifacts(build_artifacts(data))


if __name__ == "__main__":
    main()
