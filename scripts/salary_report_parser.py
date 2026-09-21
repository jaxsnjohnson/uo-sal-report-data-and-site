#!/usr/bin/env python3
import glob
import html
import json
import os
import re
from html.parser import HTMLParser


DATE_PATTERN = re.compile(r"(\d{4}-\d{2}-\d{2})")
NUMBER_CLEAN_RE = re.compile(r"[\d,]+\.?\d*")
ANNUAL_SALARY_INLINE_RE = re.compile(r"Annual Salary Rate:.*?([\d,]+\.?\d*)")
ANNUAL_SALARY_RATE_RE = re.compile(r"([\d,]+\.?\d*)\s*(.*)")
BLOCK_SPLIT_RE = re.compile(r"-{10,}")

TEXT_KEYS = [
    "Name", "Home Orgn", "Job Orgn", "Job Title", "Rank",
    "Appt Begin Date", "Appt End Date", "First Hired",
    "Adj Service Date", "Job Type", "Posn-Suff",
    "Rank Effective Date", "Appt Percent", "Annual Salary Rate",
    "Full-Time Monthly Salary", "Appt", "Hourly Rate",
]
TEXT_KEYS.sort(key=len, reverse=True)

JOB_KEYS = [
    "Job Orgn", "Job Title", "Appt Begin Date", "Appt End Date",
    "Job Type", "Posn-Suff", "Rank", "Rank Effective Date",
    "Appt Percent", "Annual Salary Rate",
    "Full-Time Monthly Salary", "Appt", "Hourly Rate",
]

HTML_HEADER_MAP = {
    "First Hired": "First Hired",
    "Home Organization": "Home Orgn",
    "Adjusted Service Date": "Adj Service Date",
    "Job Organization": "Job Orgn",
    "Job Type": "Job Type",
    "Job Title": "Job Title",
    "Position Suffix": "Posn-Suff",
    "Appointment %": "Appt Percent",
    "Appointment": "Appt",
    "Monthly Salary (USD)": "Full-Time Monthly Salary",
    "Hourly Rate (USD)": "Hourly Rate",
}


def report_date_from_path(filepath):
    filename = os.path.basename(filepath)
    date_match = DATE_PATTERN.search(filename)
    return date_match.group(1) if date_match else "Unknown Date"


def clean_text(value):
    value = html.unescape(value or "").replace("\xa0", " ")
    return " ".join(value.split()).strip()


def clean_number(value):
    match = NUMBER_CLEAN_RE.search(value or "")
    return match.group(0).replace(",", "") if match else ""


def add_annual_salary(job):
    if "Annual Salary Rate" in job:
        return
    if "Hourly Rate" in job:
        try:
            job["Annual Salary Rate"] = "{:.2f}".format(float(job["Hourly Rate"]) * 2080)
        except ValueError:
            pass
    elif "Full-Time Monthly Salary" in job:
        try:
            job["Annual Salary Rate"] = "{:.2f}".format(float(job["Full-Time Monthly Salary"]) * 12)
        except ValueError:
            pass


def add_snapshot(database, person_name, report_date, source, jobs, static_info):
    if not person_name:
        return
    for job in jobs:
        add_annual_salary(job)
    if person_name not in database:
        database[person_name] = {"Meta": static_info, "Timeline": []}
    database[person_name]["Timeline"].append({
        "Date": report_date,
        "Source": source,
        "Jobs": jobs,
        "SnapshotDetails": static_info,
    })


def parse_text_file(filepath, database):
    filename = os.path.basename(filepath)
    report_date = report_date_from_path(filepath)

    with open(filepath, "r", encoding="utf-8") as f:
        content = f.read()

    raw_blocks = BLOCK_SPLIT_RE.split(content)
    key_pattern = re.compile(
        r"(" + "|".join(TEXT_KEYS) + r")\s*:\s*(.*?)"
        r"(?=\s*(?:" + "|".join(TEXT_KEYS) + r")\s*:|\s*$)"
    )

    for block in raw_blocks:
        if not block.strip():
            continue

        person_name = None
        static_info = {}
        jobs = []
        current_job = {}

        for line in block.split("\n"):
            for key, value in key_pattern.findall(line):
                value = value.strip()

                if "Annual Salary Rate:" in value:
                    sal_match = ANNUAL_SALARY_INLINE_RE.search(value)
                    if sal_match:
                        current_job["Annual Salary Rate"] = sal_match.group(1)
                        value = value.split("Annual Salary Rate:")[0].strip()

                if key == "Name":
                    person_name = value

                if key in current_job:
                    jobs.append(current_job)
                    current_job = {}

                if key == "Annual Salary Rate":
                    match = ANNUAL_SALARY_RATE_RE.search(value)
                    if match:
                        value = match.group(1).replace(",", "")
                        term_part = match.group(2).strip()
                        if term_part:
                            try:
                                term_num = int(float(value))
                            except ValueError:
                                term_num = None
                            if term_part == "mo" and term_num in (9, 10, 11, 12):
                                current_job["Salary Term"] = f"{term_num} mo"
                                value = ""
                            else:
                                current_job["Salary Term"] = term_part
                elif key in ("Full-Time Monthly Salary", "Hourly Rate"):
                    value = clean_number(value)

                if key in JOB_KEYS:
                    current_job[key] = value
                elif key != "Name":
                    static_info[key] = value

        if current_job:
            jobs.append(current_job)

        add_snapshot(database, person_name, report_date, filename, jobs, static_info)


class ClassifiedSalaryTableParser(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=False)
        self.in_target_table = False
        self.table_depth = 0
        self.in_row = False
        self.in_cell = False
        self.current_cell = []
        self.current_row = []
        self.headers = []
        self.rows = []
        self.caption = ""
        self.in_caption = False
        self.current_caption = []

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if tag == "table":
            if attrs.get("id") == "classified-salary-table":
                self.in_target_table = True
                self.table_depth = 1
            elif self.in_target_table:
                self.table_depth += 1
        elif self.in_target_table and tag == "caption":
            self.in_caption = True
            self.current_caption = []
        elif self.in_target_table and tag == "tr":
            self.in_row = True
            self.current_row = []
        elif self.in_target_table and self.in_row and tag in ("td", "th"):
            self.in_cell = True
            self.current_cell = []

    def handle_endtag(self, tag):
        if not self.in_target_table:
            return
        if tag in ("td", "th") and self.in_cell:
            self.current_row.append(clean_text("".join(self.current_cell)))
            self.current_cell = []
            self.in_cell = False
        elif tag == "tr" and self.in_row:
            if self.current_row:
                if not self.headers:
                    self.headers = self.current_row
                else:
                    self.rows.append(self.current_row)
            self.current_row = []
            self.in_row = False
        elif tag == "caption" and self.in_caption:
            self.caption = clean_text("".join(self.current_caption))
            self.current_caption = []
            self.in_caption = False
        elif tag == "table":
            self.table_depth -= 1
            if self.table_depth == 0:
                self.in_target_table = False

    def handle_data(self, data):
        if self.in_cell:
            self.current_cell.append(data)
        if self.in_caption:
            self.current_caption.append(data)

    def handle_entityref(self, name):
        text = html.unescape(f"&{name};")
        if self.in_cell:
            self.current_cell.append(text)
        if self.in_caption:
            self.current_caption.append(text)

    def handle_charref(self, name):
        text = html.unescape(f"&#{name};")
        if self.in_cell:
            self.current_cell.append(text)
        if self.in_caption:
            self.current_caption.append(text)


def parse_html_file(filepath, database):
    filename = os.path.basename(filepath)
    report_date = report_date_from_path(filepath)

    with open(filepath, "r", encoding="utf-8") as f:
        parser = ClassifiedSalaryTableParser()
        parser.feed(f.read())

    if not parser.headers or not parser.rows:
        raise ValueError(f"Could not find classified salary table rows in {filepath}")

    grouped = {}
    order = []
    for row in parser.rows:
        if len(row) != len(parser.headers):
            raise ValueError(f"Expected {len(parser.headers)} cells, found {len(row)} in {filepath}: {row}")

        raw = dict(zip(parser.headers, row))
        person_name = raw.get("Name", "")
        static_info = {
            "First Hired": raw.get("First Hired", ""),
            "Home Orgn": raw.get("Home Organization", ""),
            "Adj Service Date": raw.get("Adjusted Service Date", ""),
        }
        group_key = (
            person_name,
            static_info["First Hired"],
            static_info["Home Orgn"],
            static_info["Adj Service Date"],
        )
        if group_key not in grouped:
            grouped[group_key] = {"person_name": person_name, "static_info": static_info, "jobs": []}
            order.append(group_key)

        job = {}
        for html_key, model_key in HTML_HEADER_MAP.items():
            if model_key in static_info:
                continue
            value = raw.get(html_key, "")
            if model_key in ("Full-Time Monthly Salary", "Hourly Rate"):
                value = clean_number(value)
            job[model_key] = value
        job = {key: value for key, value in job.items() if value != ""}
        add_annual_salary(job)
        grouped[group_key]["jobs"].append(job)

    for group_key in order:
        group = grouped[group_key]
        add_snapshot(database, group["person_name"], report_date, filename, group["jobs"], group["static_info"])

    return {"rows": len(parser.rows), "employees": len(grouped), "caption": parser.caption}


def parse_reports(text_dir="temp_txt", html_dir="html_reports", imports_path=None):
    database = {}
    txt_files = sorted(glob.glob(os.path.join(text_dir, "*.txt")))
    classified_text_dates = {
        report_date_from_path(txt_file)
        for txt_file in txt_files
        if "classified" in os.path.basename(txt_file).lower()
        and "unclassified" not in os.path.basename(txt_file).lower()
    }

    for txt_file in txt_files:
        parse_text_file(txt_file, database)
    for html_file in sorted(glob.glob(os.path.join(html_dir, "*-classified.html"))):
        if report_date_from_path(html_file) in classified_text_dates:
            continue
        parse_html_file(html_file, database)

    if imports_path is not None:
        from scripts.import_archived_reports import import_captures
        import_captures(database, imports_path)

    for person in database:
        database[person]["Timeline"].sort(key=lambda x: x["Date"])
        database[person]["Reports"] = [entry["Source"] for entry in database[person]["Timeline"]]
    return database


def main():
    database = parse_reports()
    print(json.dumps(database, indent=2))


if __name__ == "__main__":
    main()
