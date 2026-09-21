#!/usr/bin/env python3
"""Preserve complete OSU paginated reports without interpreting salary or identity.

Raw responses, a JSON transcription, a standalone HTML table, and checksums are
saved together. Archiving alone does not enable an explorer import; captures
must be explicitly selected in report_imports.json.
"""

import argparse
import hashlib
import html
import json
import re
import shutil
import tempfile
from datetime import datetime, timezone
from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import parse_qs, urlencode, urljoin, urlsplit
from urllib.request import Request, urlopen


ROOT = Path(__file__).resolve().parents[1]
BASE = "https://hr.oregonstate.edu/"
LANDING = BASE + "employees/administrators-supervisors/classification-compensation/salary-reports"
PAGE_SIZE = 200


class SalaryTableParser(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.depth = 0
        self.cell = None
        self.row = []
        self.headers = []
        self.rows = []
        self.next_href = None
        self.last_href = None
        self.tables = 0

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if tag == "a":
            if "next" in attrs.get("rel", "").split():
                self.next_href = attrs.get("href")
            if attrs.get("title") == "Go to last page":
                self.last_href = attrs.get("href")
        if tag == "table":
            if self.depth:
                self.depth += 1
            elif "views-view-bootstrap-table" in attrs.get("class", "").split():
                self.depth = 1
                self.tables += 1
        elif self.depth and tag == "tr":
            self.row = []
        elif self.depth and tag in ("th", "td"):
            self.cell = []
        elif self.cell is not None and tag == "br":
            self.cell.append(" ")

    def handle_data(self, data):
        if self.cell is not None:
            self.cell.append(data)

    def handle_endtag(self, tag):
        if not self.depth:
            return
        if tag in ("th", "td") and self.cell is not None:
            self.row.append(" ".join("".join(self.cell).split()))
            self.cell = None
        elif tag == "tr" and self.row:
            if not self.headers:
                self.headers = self.row
            else:
                self.rows.append(self.row)
            self.row = []
        elif tag == "table":
            self.depth -= 1

    def validate(self):
        required = {"Name", "Home Org", "Date of First Hire", "Annual Salary Rate", "Appointment Percentage"}
        if self.tables != 1 or not required.issubset(self.headers):
            raise ValueError("Expected exactly one salary table with the known source columns")
        if len(set(self.headers)) != len(self.headers) or not self.rows:
            raise ValueError("Missing rows or duplicate column names")
        if any(len(row) != len(self.headers) for row in self.rows):
            raise ValueError("A salary row does not match the header width")
        if any(not row[self.headers.index("Name")] for row in self.rows):
            raise ValueError("A salary row has no name")


def download(url, destination):
    request = Request(url, headers={"User-Agent": "osu-salary-report-archive/1.0"})
    with urlopen(request, timeout=60) as response:
        raw = response.read()
        charset = response.headers.get_content_charset() or "utf-8"
        metadata = {
            "url": url,
            "final_url": response.url,
            "retrieved_at_utc": datetime.now(timezone.utc).isoformat(),
            "content_type": response.headers.get("Content-Type"),
            "bytes": len(raw),
            "sha256": hashlib.sha256(raw).hexdigest(),
        }
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_bytes(raw)
    return raw.decode(charset), metadata


def write_json(path, value):
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def render_snapshot(payload, pages):
    esc = html.escape
    title = f"OSU {payload['classification'].title()} Salary Report — captured {payload['capture_date']}"
    headers = "".join(f"<th scope=\"col\">{esc(h)}</th>" for h in payload["columns"])
    rows = []
    for record in payload["records"]:
        cells = "".join(f"<td>{esc(record['fields'][h])}</td>" for h in payload["columns"])
        rows.append(f"<tr>{cells}</tr>")
    links = " ".join(f'<a href="{esc(p["file"])}" download>Page {i + 1}</a>' for i, p in enumerate(pages))
    import_note = ("The explorer includes these records, with uncertain rates and historical identity matches flagged."
                   if payload.get("explorer_imported") else
                   "These records have not been merged into the historical salary explorer.")
    return f'''<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>{esc(title)}</title><style>
body{{font:16px system-ui,sans-serif;margin:2rem;color:#202020}}a{{color:#963800}}
.table-wrap{{overflow:auto;max-height:75vh;border:1px solid #ccc}}
table{{border-collapse:collapse;font-size:14px;width:100%}}th,td{{padding:.6rem;border:1px solid #ddd;text-align:left;min-width:8rem}}
th{{position:sticky;top:0;background:#f4eee8}}tbody tr:nth-child(even){{background:#fafafa}}
details{{margin:1rem 0}}details a{{display:inline-block;margin:.3rem}}
</style></head><body><a href="../../records.html">Back to records</a><h1>{esc(title)}</h1>
<p>{len(payload['records']):,} source rows across {len(pages)} pages. This is a saved transcription of the
<a href="{esc(payload['source_url'])}">OSU table</a>; original HTML responses are preserved below.</p>
<p>The date is the capture date, not a confirmed payroll effective date. Values and names are preserved as published.
Some values labeled “Annual Salary Rate” appear to use other units. No rates in this saved table have been converted.
{import_note}</p>
<p><a href="data.json" download>Download JSON</a> · <a href="manifest.json">Capture details and SHA-256 checksums</a></p>
<details><summary>Original source pages</summary>{links}</details>
<div class="table-wrap"><table><thead><tr>{headers}</tr></thead><tbody>{''.join(rows)}</tbody></table></div>
</body></html>'''


def archive_report(kind, capture_date, out_dir):
    target = out_dir / f"{capture_date}-{kind}"
    if target.exists():
        raise FileExistsError(f"Refusing to overwrite existing capture: {target}")
    base_url = BASE + f"{kind}-salary-report-view"
    with tempfile.TemporaryDirectory(prefix=".salary-capture-", dir=out_dir) as temp:
        staging = Path(temp)
        pages = []
        records = []
        columns = None
        last_page = None
        for page_number in range(1000):
            url = base_url + "?" + urlencode({"items_per_page": PAGE_SIZE, "page": page_number})
            relative_path = f"pages/page-{page_number + 1:03d}.html"
            content, metadata = download(url, staging / relative_path)
            parser = SalaryTableParser()
            parser.feed(content)
            parser.validate()
            if columns is None:
                columns = parser.headers
                last_page = int(parse_qs(urlsplit(parser.last_href or "").query).get("page", [0])[0])
            if parser.headers != columns:
                raise ValueError("Column names changed during capture")
            if any(p["sha256"] == metadata["sha256"] for p in pages):
                raise ValueError("Server returned a duplicate page")
            if len(parser.rows) > PAGE_SIZE or (parser.next_href and len(parser.rows) != PAGE_SIZE):
                raise ValueError("Unexpected page size; capture may be incomplete")
            metadata.update(file=relative_path, row_count=len(parser.rows))
            pages.append(metadata)
            records.extend({"fields": dict(zip(columns, row)), "source_page": relative_path} for row in parser.rows)
            print(f"{kind}: page {page_number + 1}, {len(parser.rows)} rows", flush=True)
            if not parser.next_href:
                if page_number != last_page:
                    raise ValueError("Final page differs from the first page's advertised last page")
                break
            next_url = urlsplit(urljoin(url, parser.next_href))
            query = parse_qs(next_url.query)
            if (next_url.netloc != urlsplit(BASE).netloc or next_url.path != urlsplit(base_url).path
                    or query.get("page") != [str(page_number + 1)]
                    or query.get("items_per_page") != [str(PAGE_SIZE)]):
                raise ValueError("Unexpected pagination link")
        else:
            raise ValueError("Pagination safety limit exceeded")

        context = []
        for filename, url in (("salary-reports.html", LANDING),
                              ("report-description.html", BASE + f"policies-procedures/documents/{kind}-salary-report")):
            _, metadata = download(url, staging / filename)
            context.append(dict(metadata, file=filename))
        payload = {"classification": kind, "capture_date": capture_date, "date_basis": "capture_date",
                   "source_url": base_url, "columns": columns, "records": records}
        write_json(staging / "data.json", payload)
        (staging / "index.html").write_text(render_snapshot(payload, pages), encoding="utf-8")
        low_rates = sum(bool(re.fullmatch(r"[\d,.]+", r["fields"]["Annual Salary Rate"]))
                        and 0 < float(r["fields"]["Annual Salary Rate"].replace(",", "")) < 1000
                        for r in records)
        manifest = {
            "schema_version": 1, "classification": kind, "capture_date": capture_date,
            "date_basis": "capture_date; source table does not state a payroll extraction date",
            "source_url": base_url, "page_size": PAGE_SIZE, "page_count": len(pages),
            "row_count": len(records), "distinct_source_names": len({r["fields"]["Name"] for r in records}),
            "duplicate_row_count": len(records) - len({tuple(r["fields"].values()) for r in records}),
            "annual_salary_values_between_zero_and_1000": low_rates,
            "explorer_imported": False,
            "notes": ["Source rows are retained without deduplication or identity matching.",
                      "Annual Salary Rate values are preserved without inferring units.",
                      "Pagination was followed from first through advertised final page; the source offers no atomic snapshot guarantee."],
            "pages": pages, "context_pages": context,
            "derived_files": [{"file": name, "sha256": hashlib.sha256((staging / name).read_bytes()).hexdigest()}
                              for name in ("data.json", "index.html")],
        }
        write_json(staging / "manifest.json", manifest)
        shutil.move(str(staging), str(target))
    print(f"Saved {target}: {len(records)} rows, {len(pages)} pages")
    return manifest


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--classification", choices=("classified", "unclassified", "both"), default="both")
    parser.add_argument("--out-dir", type=Path, default=ROOT / "reports")
    args = parser.parse_args()
    args.out_dir.mkdir(parents=True, exist_ok=True)
    capture_date = datetime.now(timezone.utc).date().isoformat()
    kinds = ("classified", "unclassified") if args.classification == "both" else (args.classification,)
    for kind in kinds:
        archive_report(kind, capture_date, args.out_dir)


if __name__ == "__main__":
    main()
