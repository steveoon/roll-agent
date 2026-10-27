"""Resource counters and isolation contracts for the reusable PTY driver."""

import copy
import json
import os
from pathlib import Path
import sys
import tempfile
import time
import unittest
from unittest import mock

import benchmark


class BenchmarkResourceTests(unittest.TestCase):
    def test_source_and_dist_results_cannot_be_compared(self):
        result = {
            "schemaVersion": benchmark.RESULT_SCHEMA_VERSION,
            "suite": benchmark.SUITE_NAME,
            "scenarios": {"keypress": {"metrics": {"keypressToRenderMs": {"median": 1.0}}}},
        }
        for current_entry, baseline_entry in (("src", "dist"), ("dist", "src"), ("dist", None)):
            with self.subTest(current=current_entry, baseline=baseline_entry):
                current = copy.deepcopy(result)
                current["environment"] = {"entry": current_entry}
                baseline = copy.deepcopy(result)
                if baseline_entry is not None:
                    baseline["environment"] = {"entry": baseline_entry}
                with tempfile.TemporaryDirectory() as root:
                    path = Path(root) / "baseline.json"
                    path.write_text(json.dumps(baseline))
                    failures = benchmark.compare_baseline(current, path, 25.0)
                self.assertTrue(any("entry" in failure for failure in failures))

    def test_historical_source_results_remain_comparable(self):
        baseline = {
            "schemaVersion": benchmark.RESULT_SCHEMA_VERSION,
            "suite": benchmark.SUITE_NAME,
            "scenarios": {"keypress": {"metrics": {"keypressToRenderMs": {"median": 1.0}}}},
        }
        current = {**baseline, "environment": {"entry": "src"}}
        with tempfile.TemporaryDirectory() as root:
            path = Path(root) / "baseline.json"
            path.write_text(json.dumps(baseline))
            self.assertEqual(benchmark.compare_baseline(current, path, 25.0), [])

    @unittest.skipUnless(sys.platform == "darwin", "macOS live-process counter")
    def test_macos_cpu_counter_matches_process_cpu_time(self):
        cpu_before = time.process_time()
        before = benchmark.process_resources(os.getpid())["cpuMs"]
        while time.process_time() - cpu_before < 0.03:
            pass
        after = benchmark.process_resources(os.getpid())["cpuMs"]
        elapsed = (time.process_time() - cpu_before) * 1_000
        self.assertGreater(after - before, elapsed * 0.8)
        self.assertLess(after - before, elapsed * 1.2)

    def test_historical_cpu_units_require_new_baseline(self):
        result = {
            "schemaVersion": benchmark.RESULT_SCHEMA_VERSION,
            "suite": benchmark.SUITE_NAME,
            "environment": {"cpuCounterVersion": 2},
            "scenarios": {"idle": {"metrics": {
                name: {"median": 1.0}
                for name in ("invalidFrames", "outputBytes", "cpuMs")
            }}},
        }
        old = copy.deepcopy(result)
        old["environment"].clear()
        with tempfile.TemporaryDirectory() as root:
            path = Path(root) / "old.json"
            path.write_text(json.dumps(old))
            failures = benchmark.compare_baseline(result, path, 25.0)
        self.assertTrue(any("CPU counter version differs" in failure for failure in failures))

    def test_catalog_fixture_preserves_dataset_and_shared_timestamp(self):
        stamp = benchmark.validate_catalog_fetched_at()
        original = json.loads(
            (benchmark.HARNESS_ROOT / "benchmarks/chat-pty/model-catalog-fixture.json").read_text()
        )
        with tempfile.TemporaryDirectory() as home, mock.patch.dict(
            os.environ, {"ROLL_CHAT_BENCH_CATALOG_FETCHED_AT": stamp}
        ):
            seeded = benchmark.seed_model_catalog(Path(home))
            self.assertEqual(seeded["providers"], original["providers"])
            self.assertEqual(seeded["fetchedAt"], stamp)
            self.assertEqual(
                json.loads((Path(home) / ".roll-agent/cache/model-catalog.json").read_text()),
                seeded,
            )

    def test_catalog_fixture_rejects_expired_or_future_timestamps(self):
        for stamp in ("2020-01-01T00:00:00Z", "9999-01-01T00:00:00Z"):
            with self.assertRaisesRegex(ValueError, "future-dated or expired"):
                benchmark.validate_catalog_fetched_at(stamp)


if __name__ == "__main__":
    unittest.main()
