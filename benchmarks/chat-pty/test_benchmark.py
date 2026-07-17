"""Unit tests for fail-closed PTY benchmark correctness contracts."""

from __future__ import annotations

import importlib.util
import json
from pathlib import Path
import re
import sys
import tempfile
import unittest


MODULE_PATH = Path(__file__).with_name("benchmark.py")
SPEC = importlib.util.spec_from_file_location("roll_chat_pty_benchmark", MODULE_PATH)
if SPEC is None or SPEC.loader is None:
    raise RuntimeError(f"could not load benchmark module: {MODULE_PATH}")
benchmark = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = benchmark
SPEC.loader.exec_module(benchmark)


def scenario_result(scenario: str) -> dict[str, object]:
    metrics = {
        metric: {"samples": 1, "median": 10.0}
        for metric in benchmark.REQUIRED_BASELINE_METRICS[scenario]
    }
    return {"samples": [], "metrics": metrics}


def result_for(*scenarios: str) -> dict[str, object]:
    return {
        "schemaVersion": benchmark.RESULT_SCHEMA_VERSION,
        "suite": benchmark.SUITE_NAME,
        "scenarios": {scenario: scenario_result(scenario) for scenario in scenarios},
    }


class BaselineComparisonTests(unittest.TestCase):
    def compare(
        self, current: dict[str, object], baseline: dict[str, object]
    ) -> list[str]:
        with tempfile.TemporaryDirectory() as temporary_directory:
            baseline_path = Path(temporary_directory) / "baseline.json"
            baseline_path.write_text(json.dumps(baseline), encoding="utf-8")
            return benchmark.compare_baseline(current, baseline_path, 25.0)

    def test_complete_baseline_passes(self) -> None:
        current = result_for("keypress", "idle")
        self.assertEqual(self.compare(current, result_for("keypress", "idle")), [])

    def test_missing_baseline_scenario_fails(self) -> None:
        failures = self.compare(result_for("keypress", "idle"), result_for("keypress"))
        self.assertIn("baseline missing scenario: idle", failures)

    def test_missing_or_non_numeric_required_metric_fails(self) -> None:
        current = result_for("keypress")
        missing = result_for("keypress")
        del missing["scenarios"]["keypress"]["metrics"]["keypressToRenderMs"]
        self.assertIn(
            "baseline metric missing or non-numeric: keypress.keypressToRenderMs.median",
            self.compare(current, missing),
        )

        non_numeric = result_for("keypress")
        non_numeric["scenarios"]["keypress"]["metrics"]["keypressToRenderMs"][
            "median"
        ] = "fast"
        self.assertIn(
            "baseline metric missing or non-numeric: keypress.keypressToRenderMs.median",
            self.compare(current, non_numeric),
        )

    def test_schema_or_suite_mismatch_fails(self) -> None:
        current = result_for("keypress")
        baseline = result_for("keypress")
        baseline["schemaVersion"] = benchmark.RESULT_SCHEMA_VERSION - 1
        baseline["suite"] = "other-suite"
        failures = self.compare(current, baseline)
        self.assertTrue(any("schemaVersion" in failure for failure in failures))
        self.assertTrue(any("suite" in failure for failure in failures))


class MarkerOracleTests(unittest.TestCase):
    PATTERN = re.compile(r"word(\d{3})")

    @staticmethod
    def frames(*screens: str) -> list[object]:
        return [benchmark.Frame(float(index), screen) for index, screen in enumerate(screens)]

    def test_persistent_markers_are_observed_once_in_first_seen_order(self) -> None:
        observation = benchmark.observed_numeric_markers(
            self.frames("word000", "word000 word001", "word001 word002"), self.PATTERN
        )
        benchmark.assert_complete_sequence("word", observation, 3)
        self.assertEqual(observation.first_seen, (0, 1, 2))

    def test_duplicate_marker_fails(self) -> None:
        observation = benchmark.observed_numeric_markers(
            self.frames("word000 word000"), self.PATTERN
        )
        with self.assertRaisesRegex(AssertionError, "duplicate markers"):
            benchmark.assert_complete_sequence("word", observation, 1)

    def test_missing_or_out_of_order_marker_fails(self) -> None:
        for screens in (("word000 word002",), ("word001 word000",)):
            with self.subTest(screens=screens):
                observation = benchmark.observed_numeric_markers(
                    self.frames(*screens), self.PATTERN
                )
                with self.assertRaisesRegex(AssertionError, "sequence mismatch"):
                    benchmark.assert_complete_sequence("word", observation, 3)


if __name__ == "__main__":
    unittest.main()
