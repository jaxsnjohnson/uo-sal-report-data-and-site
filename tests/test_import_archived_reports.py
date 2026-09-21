import hashlib
import json
import tempfile
import unittest
from pathlib import Path

from scripts.import_archived_reports import import_captures
from split_data import build_artifacts


def source_row(name="Jane Doe", hired="01/01/2020", rate="60,000.00", pct="50"):
    return {"source_page": "pages/page-001.html", "fields": {
        "Name": name, "Date of First Hire": hired, "Home Org": "New Home Organization",
        "Adjusted Service Date": hired, "Job Title": "Analyst", "Job Type": "P",
        "Annual Salary Rate": rate, "Appointment Percentage": pct, "Appointment Basis": "12 months",
    }}


def historical_person():
    return {"Meta": {"First Hired": "01-JAN-2020", "Home Orgn": "Old Home"},
            "Timeline": [{"Date": "2026-02-03", "Source": "2026-02-03-classified.txt",
                          "Jobs": [{"Job Title": "Analyst", "Job Orgn": "Old Job Org",
                                    "Annual Salary Rate": "50000", "Appt Percent": "100"}]}]}


class CaptureImportTests(unittest.TestCase):
    def run_import(self, database, rows):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            folder = root / "reports/2026-09-18-classified"
            folder.mkdir(parents=True)
            raw = json.dumps({"classification": "classified", "capture_date": "2026-09-18",
                              "records": rows}).encode()
            (folder / "data.json").write_bytes(raw)
            (folder / "manifest.json").write_text(json.dumps({"row_count": len(rows), "derived_files": [
                {"file": "data.json", "sha256": hashlib.sha256(raw).hexdigest()}]}))
            config = root / "report_imports.json"
            config.write_text(json.dumps({"captures": ["reports/2026-09-18-classified"]}))
            return import_captures(database, config)

    def test_matches_unique_name_and_hire_date_preserving_history(self):
        old = historical_person()
        original = json.loads(json.dumps(old["Timeline"]))
        database = {"Doe, Jane R": old}
        audit = self.run_import(database, [source_row()])
        self.assertEqual(list(database), ["Doe, Jane R"])
        self.assertEqual(old["Timeline"][:-1], original)
        self.assertEqual(audit[0]["identityMatch"], "matched_name_and_hire_date")
        artifacts = build_artifacts(database)
        latest = artifacts["index"]["Doe, Jane R"]
        self.assertEqual(latest["_totalPay"], 30000)
        self.assertEqual(latest["Meta"]["Home Orgn"], "New Home Organization")
        self.assertNotIn("Job Orgn", latest["_lastJob"])
        self.assertEqual(artifacts["aggregates"]["latestClassDate"], "2026-09-18")
        self.assertEqual([r["date"] for r in artifacts["aggregates"]["historyStats"]], ["2026-02-03"])
        self.assertIsNone(latest["_peerPercentile"])

    def test_ambiguous_historical_names_and_different_hire_dates_stay_separate(self):
        database = {"Doe, Jane R": historical_person(), "Doe, Jane S": historical_person()}
        audit = self.run_import(database, [source_row(), source_row(hired="02/01/2020")])
        self.assertEqual([r["identityMatch"] for r in audit], ["ambiguous", "unmatched"])
        self.assertEqual(len(database), 4)
        self.assertEqual(len(database["Doe, Jane R"]["Timeline"]), 1)
        self.assertEqual(len(database["Doe, Jane S"]["Timeline"]), 1)
        self.assertNotEqual(audit[0]["profile"], audit[1]["profile"])

    def test_exact_full_name_disambiguates_middle_names(self):
        database = {"Doe, Jane R": historical_person(), "Doe, Jane S": historical_person()}
        audit = self.run_import(database, [source_row(name="Jane R Doe")])
        self.assertEqual(audit[0]["profile"], "Doe, Jane R")
        self.assertEqual(len(database), 2)

    def test_exact_short_name_cannot_override_a_second_candidate(self):
        database = {"Doe, Jane": historical_person(), "Doe, Jane S": historical_person()}
        audit = self.run_import(database, [source_row()])
        self.assertEqual(audit[0]["identityMatch"], "ambiguous")
        self.assertEqual(len(database["Doe, Jane"]["Timeline"]), 1)

    def test_uncertain_units_and_zero_are_not_annualized_or_counted_as_pay(self):
        database = {}
        self.run_import(database, [source_row(rate="22.83"), source_row(name="Zero Salary", rate="0.00")])
        artifacts = build_artifacts(database)
        for entry in artifacts["index"].values():
            self.assertTrue(entry["_payMissing"])
            self.assertEqual(entry["_totalPay"], 0)
            self.assertEqual(entry["_lastJob"]["Annual Salary Rate"], "")
        self.assertEqual(artifacts["index"]["Jane Doe"]["_lastJob"]["Reported Salary Rate"], "22.83")
        self.assertEqual(artifacts["aggregates"]["captureImport"]["payReviewRows"], 2)

    def test_many_source_names_cannot_claim_one_history(self):
        database = {"Doe, Jane R": historical_person()}
        audit = self.run_import(database, [source_row(), source_row(name="Jane R Doe")])
        self.assertTrue(all(r["identityMatch"] == "ambiguous" for r in audit))
        self.assertEqual(len(database["Doe, Jane R"]["Timeline"]), 1)


if __name__ == "__main__":
    unittest.main()
