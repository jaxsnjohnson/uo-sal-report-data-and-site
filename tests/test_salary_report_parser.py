#!/usr/bin/env python3
import os
import unittest

from scripts.salary_report_parser import parse_html_file


ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
FIXTURE = os.path.join(ROOT, "tests", "fixtures", "classified_salary_sample.html")


class ClassifiedHtmlParserTests(unittest.TestCase):
    def test_parses_classified_html_into_existing_model(self):
        database = {}
        stats = parse_html_file(FIXTURE, database)

        self.assertEqual(stats["rows"], 4)
        self.assertEqual(stats["employees"], 3)
        self.assertEqual(len(database), 3)

        monthly = database["Monthly, Mary"]["Timeline"][0]
        self.assertEqual(monthly["Date"], "Unknown Date")
        self.assertEqual(monthly["SnapshotDetails"]["Home Orgn"], "ABC - Example & Testing")
        self.assertEqual(monthly["Jobs"][0]["Full-Time Monthly Salary"], "7280.00")
        self.assertEqual(monthly["Jobs"][0]["Annual Salary Rate"], "87360.00")

        hourly = database["Hourly, Hank"]["Timeline"][0]["Jobs"][0]
        self.assertNotIn("Full-Time Monthly Salary", hourly)
        self.assertEqual(hourly["Hourly Rate"], "22.84")
        self.assertEqual(hourly["Annual Salary Rate"], "47507.20")
        self.assertEqual(hourly["Appt"], "Classified-Limited Duration (J")

        multi = database["Multi, Amanda R"]["Timeline"][0]
        self.assertEqual(len(multi["Jobs"]), 2)
        self.assertEqual(multi["Jobs"][0]["Job Orgn"], "ACT - Central Oregon Exp Sta")
        self.assertEqual(multi["Jobs"][1]["Job Orgn"], "TEX - Ext Jefferson Co Office")


if __name__ == "__main__":
    unittest.main()
