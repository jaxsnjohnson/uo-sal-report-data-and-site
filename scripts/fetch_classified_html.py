#!/usr/bin/env python3
import argparse
import os
import re
import urllib.request
from datetime import datetime


DEFAULT_URL = "https://hr.oregonstate.edu/classified-salary-report"
CAPTION_DATE_RE = re.compile(r"extracted\s+from\s+[^<]+?\s+on\s+(\d{2}-[A-Za-z]{3}-\d{4})", re.I)


def snapshot_date_from_html(content):
    match = CAPTION_DATE_RE.search(content)
    if not match:
        raise ValueError("Could not find source extraction date in classified salary table caption")
    return datetime.strptime(match.group(1).title(), "%d-%b-%Y").strftime("%Y-%m-%d")


def fetch(url):
    request = urllib.request.Request(url, headers={"User-Agent": "osu-salary-report-import/1.0"})
    with urllib.request.urlopen(request, timeout=30) as response:
        charset = response.headers.get_content_charset() or "utf-8"
        return response.read().decode(charset)


def main():
    parser = argparse.ArgumentParser(description="Fetch OSU classified salary report HTML into a dated snapshot.")
    parser.add_argument("--url", default=DEFAULT_URL)
    parser.add_argument("--out-dir", default="html_reports")
    args = parser.parse_args()

    content = fetch(args.url)
    report_date = snapshot_date_from_html(content)
    os.makedirs(args.out_dir, exist_ok=True)
    out_path = os.path.join(args.out_dir, f"{report_date}-classified.html")
    with open(out_path, "w", encoding="utf-8") as f:
        f.write(content)
    print(out_path)


if __name__ == "__main__":
    main()
