#!/usr/bin/env python3
import unittest

import split_data


class SplitDataAggregateTests(unittest.TestCase):
    def test_pairs_nearest_prior_classification_reports(self):
        history = [
            {
                "date": "2026-02-03",
                "classified": 10,
                "unclassified": 20,
                "payrollClassified": 1000.0,
                "payrollUnclassified": 3000.0,
                "payroll": 4000.0,
            },
            {
                "date": "2026-04-21",
                "classified": 0,
                "unclassified": 22,
                "payrollClassified": 0.0,
                "payrollUnclassified": 3400.0,
                "payroll": 3400.0,
            },
        ]

        paired = split_data.build_paired_history_stats(history)

        self.assertEqual(len(paired), 2)
        latest = paired[-1]
        self.assertEqual(latest["date"], "2026-04-21")
        self.assertEqual(latest["classifiedDate"], "2026-02-03")
        self.assertEqual(latest["unclassifiedDate"], "2026-04-21")
        self.assertEqual(latest["classified"], 10)
        self.assertEqual(latest["unclassified"], 22)
        self.assertEqual(latest["payroll"], 4400.0)

    def test_pay_concentration_uses_top_payroll_shares_and_ratios(self):
        result = split_data.build_pay_concentration_points(
            ["2020-01-01"],
            {"2020-01-01": [100.0, 100.0, 100.0, 700.0]},
        )

        point = result["points"][0]
        self.assertEqual(point["headcount"], 4)
        self.assertAlmostEqual(point["top10SharePct"], 70.0)
        self.assertGreater(point["p90P50Ratio"], 1.0)
        self.assertGreater(point["p50P10Ratio"], 0.0)

    def test_quantile_sorted_interpolates(self):
        self.assertEqual(split_data.quantile_sorted([10.0, 20.0, 30.0], 0.5), 20.0)
        self.assertEqual(split_data.quantile_sorted([10.0, 20.0], 0.5), 15.0)

    def test_tenure_band_boundaries(self):
        self.assertEqual(split_data.tenure_band_for_dates("2020-01-01", "2022-12-31"), "lt3")
        self.assertEqual(split_data.tenure_band_for_dates("2020-01-01", "2023-01-02"), "threeTo7")
        self.assertEqual(split_data.tenure_band_for_dates("2020-01-01", "2027-01-02"), "sevenTo15")
        self.assertEqual(split_data.tenure_band_for_dates("2020-01-01", "2035-01-02"), "fifteenPlus")

    def test_role_group_title_heuristic(self):
        self.assertTrue(split_data.is_role_group_snapshot([
            {"Job Title": "Assistant Director"},
        ]))
        self.assertFalse(split_data.is_role_group_snapshot([
            {"Job Title": "Dean of Example College"},
        ]))


if __name__ == "__main__":
    unittest.main()
