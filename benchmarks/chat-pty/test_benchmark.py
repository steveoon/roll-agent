"""Unit tests for fail-closed PTY benchmark correctness contracts."""

from __future__ import annotations

import importlib.util
import json
from pathlib import Path
import re
import sys
import tempfile
import unittest
from types import SimpleNamespace
from unittest import mock


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


def bootstrap_result(
    scenario: str,
    values: list[float],
    topology_hash: str = "topology",
    catalog_hash: str = "catalog",
) -> dict[str, object]:
    metric = benchmark.BOOTSTRAP_COMPARISON_METRICS[scenario]
    return {
        "schemaVersion": benchmark.RESULT_SCHEMA_VERSION,
        "suite": benchmark.SUITE_NAME,
        "scenarios": {
            scenario: {
                "samples": [{metric: value} for value in values],
                "metrics": {metric: benchmark.stats(values)},
                "topologyHash": topology_hash,
                "catalogHash": catalog_hash,
            }
        },
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


class BootstrapComparisonTests(unittest.TestCase):
    SCENARIO = "cli-server-5-agent-bootstrap"

    def test_reports_paired_median_and_p95_deltas(self) -> None:
        baseline = bootstrap_result(self.SCENARIO, [1000, 1100, 1200])
        current = bootstrap_result(self.SCENARIO, [700, 900, 1300])

        comparisons, failures = benchmark.compare_bootstrap_results(current, baseline)

        self.assertEqual(failures, [])
        comparison = comparisons[self.SCENARIO]
        self.assertEqual(comparison["pairCount"], 3)
        self.assertEqual(comparison["fasterPairCount"], 2)
        self.assertEqual(comparison["median"]["absoluteDeltaMs"], -200)
        self.assertEqual(comparison["median"]["percentDelta"], -18.182)
        self.assertEqual(comparison["p95"]["absoluteDeltaMs"], 70)

    def test_topology_or_catalog_mismatch_fails_closed(self) -> None:
        baseline = bootstrap_result(self.SCENARIO, [1000])
        for field, value in (("topology_hash", "other"), ("catalog_hash", "other")):
            with self.subTest(field=field):
                current = bootstrap_result(self.SCENARIO, [700], **{field: value})
                comparisons, failures = benchmark.compare_bootstrap_results(
                    current, baseline
                )
                self.assertEqual(comparisons, {})
                self.assertTrue(any(field.removesuffix("_hash") in item for item in failures))

    def test_sample_count_or_metric_shape_mismatch_fails_closed(self) -> None:
        baseline = bootstrap_result(self.SCENARIO, [1000, 1100])
        current = bootstrap_result(self.SCENARIO, [700])
        comparisons, failures = benchmark.compare_bootstrap_results(current, baseline)
        self.assertEqual(comparisons, {})
        self.assertTrue(any("sample count mismatch" in item for item in failures))

        current = bootstrap_result(self.SCENARIO, [700, 800])
        del current["scenarios"][self.SCENARIO]["metrics"][
            "sessionCreateReadyMs"
        ]["p95"]
        comparisons, failures = benchmark.compare_bootstrap_results(current, baseline)
        self.assertEqual(comparisons, {})
        self.assertTrue(any("metric is missing" in item for item in failures))


class GoNoGoTests(unittest.TestCase):
    @staticmethod
    def inputs() -> tuple[dict[str, object], dict[str, object]]:
        def comparison(
            absolute: float,
            percent: float,
            p95_absolute: float = 0,
            p95_percent: float = 0,
            faster: int = 24,
        ) -> dict[str, object]:
            return {
                "pairCount": 30,
                "fasterPairCount": faster,
                "median": {
                    "baselineMs": 1000,
                    "candidateMs": 1000 + absolute,
                    "absoluteDeltaMs": absolute,
                    "percentDelta": percent,
                },
                "p95": {
                    "baselineMs": 1200,
                    "candidateMs": 1200 + p95_absolute,
                    "absoluteDeltaMs": p95_absolute,
                    "percentDelta": p95_percent,
                },
            }

        comparisons = {
            "cli-bootstrap": comparison(20, 2),
            "cli-ink-cold-start": comparison(20, 2),
            "cli-server-1-agent-bootstrap": comparison(
                20, 2, p95_absolute=120, p95_percent=10
            ),
            "cli-server-5-agent-bootstrap": comparison(-200, -20),
            "cli-ink-5-agent-cold-start": comparison(-150, -15),
        }
        candidate = {
            "scenarios": {
                scenario: {
                    "metrics": {
                        "peakActive": {
                            "samples": 30,
                            "min": 3,
                            "max": 3,
                        }
                    }
                }
                for scenario in (
                    "cli-server-5-agent-bootstrap",
                    "cli-ink-5-agent-cold-start",
                )
            }
        }
        return comparisons, candidate

    def test_exact_thresholds_pass(self) -> None:
        comparisons, candidate = self.inputs()

        result = benchmark.evaluate_go_no_go(comparisons, candidate, 3)

        self.assertTrue(result["passed"])
        self.assertTrue(all(check["passed"] for check in result["checks"]))

    def test_peak_pair_and_zero_agent_regressions_fail_closed(self) -> None:
        comparisons, candidate = self.inputs()
        comparisons["cli-server-5-agent-bootstrap"]["fasterPairCount"] = 23
        comparisons["cli-bootstrap"]["median"]["absoluteDeltaMs"] = 51
        candidate["scenarios"]["cli-ink-5-agent-cold-start"]["metrics"][
            "peakActive"
        ]["min"] = 1

        result = benchmark.evaluate_go_no_go(comparisons, candidate, 3)
        failed = {
            check["name"] for check in result["checks"] if not check["passed"]
        }

        self.assertFalse(result["passed"])
        self.assertIn(
            "cli-server-5-agent-bootstrap.paired-stability", failed
        )
        self.assertIn("cli-bootstrap.median-regression", failed)
        self.assertIn("cli-ink-5-agent-cold-start.peak-active", failed)


class PairedRunnerTests(unittest.TestCase):
    def test_runner_uses_warmups_then_bccb_and_pairs_by_sample_index(self) -> None:
        scenario = "cli-server-1-agent-bootstrap"
        metric = benchmark.BOOTSTRAP_COMPARISON_METRICS[scenario]
        values = iter([999, 999, 1000, 800, 700, 1100])

        def member(
            _root: Path, _scenario: str, _output: Path
        ) -> tuple[dict[str, object], dict[str, object]]:
            return (
                {
                    metric: next(values),
                    "topologyHash": "topology",
                    "catalogHash": "catalog",
                    "peakActive": 1,
                },
                {"commit": "fixture"},
            )

        with tempfile.TemporaryDirectory() as temporary_directory:
            output = Path(temporary_directory) / "paired.json"
            args = SimpleNamespace(
                paired_baseline_root=benchmark.HARNESS_ROOT,
                paired_candidate_root=benchmark.HARNESS_ROOT,
                paired_warmups=1,
                paired_rounds=1,
                candidate_concurrency=2,
                scenarios=[scenario],
                output=output,
            )
            with (
                mock.patch.object(
                    benchmark, "run_paired_member_sample", side_effect=member
                ) as run_member,
                mock.patch.object(benchmark.sys, "stdout"),
            ):
                self.assertEqual(benchmark.run_paired_benchmark(args), 1)

            labels = [
                call.args[2].parent.name[5 : -(len(scenario) + 1)]
                for call in run_member.call_args_list
            ]
            self.assertEqual(
                labels,
                [
                    "baseline-warmup",
                    "candidate-warmup",
                    "baseline",
                    "candidate",
                    "candidate",
                    "baseline",
                ],
            )
            result = json.loads(output.read_text(encoding="utf-8"))
            comparison = result["comparisons"][scenario]
            self.assertEqual(comparison["pairCount"], 2)
            self.assertEqual(comparison["fasterPairCount"], 2)
            self.assertEqual(result["schedule"]["order"], [
                "baseline",
                "candidate",
                "candidate",
                "baseline",
            ])


class BootstrapFixtureContractTests(unittest.TestCase):
    def test_fixed_topologies_preserve_registration_order_and_delays(self) -> None:
        one = benchmark.bootstrap_topology("cli-server-1-agent-bootstrap")
        five = benchmark.bootstrap_topology("cli-server-5-agent-bootstrap")

        self.assertEqual([item["delayMs"] for item in one], [400])
        self.assertEqual(
            [item["delayMs"] for item in five], [400, 300, 250, 150, 100]
        )
        self.assertEqual(
            [item["name"] for item in five],
            [f"benchmark-agent-{index}" for index in range(1, 6)],
        )
        self.assertEqual(
            benchmark.bootstrap_topology("cli-ink-5-agent-cold-start"), five
        )

    def test_capabilities_require_complete_ordered_agent_tool_catalog(self) -> None:
        topology = benchmark.bootstrap_topology("cli-server-1-agent-bootstrap")
        catalog = benchmark.expected_agent_catalog(topology)
        agent_capabilities = [
            {
                **entry,
                "role": "agent",
                "approval": "runtime-policy",
                "description": "Deterministic bootstrap probe",
                "inputSchema": {
                    "type": "object",
                    "properties": {},
                    "additionalProperties": False,
                },
            }
            for entry in catalog
        ]
        response = {
            "result": {
                "manifest": {
                    "agentCount": 1,
                    "tools": [
                        *agent_capabilities,
                        {
                            "id": "roll__skill",
                            "agentName": "roll",
                            "source": "built-in",
                        },
                    ],
                }
            }
        }
        self.assertEqual(
            benchmark.validate_capabilities(response, topology),
            benchmark.canonical_hash(
                {"agentCount": 1, "tools": agent_capabilities}
            ),
        )

        response["result"]["manifest"]["tools"] = []
        with self.assertRaisesRegex(AssertionError, "catalog differs"):
            benchmark.validate_capabilities(response, topology)

        response["result"]["manifest"]["tools"] = [
            *agent_capabilities,
            {
                "id": "ghost__tool",
                "agentName": "ghost",
                "toolName": "tool",
                "source": "local-path",
                "transport": "stdio",
                "runtimeOwnership": "on-demand",
            },
        ]
        with self.assertRaisesRegex(AssertionError, "catalog differs"):
            benchmark.validate_capabilities(response, topology)

        response["result"]["manifest"]["tools"] = list(agent_capabilities)
        original_hash = benchmark.validate_capabilities(response, topology)
        response["result"]["manifest"]["tools"][0]["inputSchema"] = {
            "type": "string"
        }
        self.assertNotEqual(
            benchmark.validate_capabilities(response, topology), original_hash
        )

        response["result"]["manifest"]["tools"] = list(agent_capabilities)
        response["result"]["turnContext"] = "invalid"
        with self.assertRaisesRegex(AssertionError, "turnContext must be an object"):
            benchmark.validate_capabilities(response, topology)

        with self.assertRaisesRegex(AssertionError, "missing manifest"):
            benchmark.validate_capabilities({"result": {}}, topology)

    def test_catalog_and_topology_hashes_must_be_stable_across_samples(self) -> None:
        self.assertEqual(
            benchmark.stable_sample_string(
                [{"topologyHash": "same"}, {"topologyHash": "same"}],
                "topologyHash",
            ),
            "same",
        )
        with self.assertRaisesRegex(AssertionError, "unstable"):
            benchmark.stable_sample_string(
                [{"catalogHash": "left"}, {"catalogHash": "right"}], "catalogHash"
            )

    def test_lifecycle_validates_list_boundaries_and_peak_activity(self) -> None:
        fixture = object.__new__(benchmark.PtyFixture)
        fixture.topology = (
            {"name": "benchmark-agent-1", "delayMs": 400},
            {"name": "benchmark-agent-2", "delayMs": 300},
        )
        fixture.expected_agent_count = 2
        records = (
            {
                "name": "benchmark-agent-1",
                "pid": 101,
                "delayMs": 400,
                "toolCount": 1,
                "events": [
                    {"event": "started", "monotonicNs": "1"},
                    {"event": "list-start", "monotonicNs": "10"},
                    {"event": "list-end", "monotonicNs": "30"},
                ],
            },
            {
                "name": "benchmark-agent-2",
                "pid": 102,
                "delayMs": 300,
                "toolCount": 1,
                "events": [
                    {"event": "started", "monotonicNs": "2"},
                    {"event": "list-start", "monotonicNs": "20"},
                    {"event": "list-end", "monotonicNs": "40"},
                ],
            },
        )
        with (
            mock.patch.object(fixture, "agent_lifecycle", return_value=records),
            mock.patch.object(fixture, "_pid_is_alive", return_value=True),
        ):
            self.assertEqual(fixture.validate_agent_lifecycle(require_exited=False), 2)

        invalid = (*records[:1], {**records[1], "events": records[1]["events"][:2]})
        with mock.patch.object(fixture, "agent_lifecycle", return_value=invalid):
            with self.assertRaisesRegex(AssertionError, "sequence differs"):
                fixture.validate_agent_lifecycle(require_exited=False)


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

    def test_unique_sentinel_oracle_requires_each_marker_exactly_once(self) -> None:
        sentinels = ("USER_SENTINEL", "ASSISTANT_SENTINEL", "DRAFT_SENTINEL")
        self.assertTrue(
            benchmark.has_unique_sentinels("\n".join(sentinels), sentinels)
        )
        benchmark.assert_unique_sentinels("checkpoint", "\n".join(sentinels), sentinels)

        with self.assertRaisesRegex(AssertionError, "sentinel counts are not unique"):
            benchmark.assert_unique_sentinels(
                "checkpoint",
                "USER_SENTINEL\nUSER_SENTINEL\nDRAFT_SENTINEL",
                sentinels,
            )


class EditorCursorTests(unittest.TestCase):
    def test_visible_cursor_at_cjk_insertion_point_passes(self) -> None:
        screen = benchmark.VirtualScreen(30, 6)
        screen.x = 3
        screen.y = 2
        screen.feed("› 输入".encode())

        benchmark.assert_editor_cursor(screen, "输入")

    def test_hidden_or_misaligned_cursor_fails_closed(self) -> None:
        screen = benchmark.VirtualScreen(30, 6)
        screen.feed("› 输入".encode())
        screen.cursor_visible = False
        with self.assertRaisesRegex(AssertionError, "IME preedit has no anchor"):
            benchmark.assert_editor_cursor(screen, "输入")

        screen.cursor_visible = True
        screen.x -= 1
        with self.assertRaisesRegex(AssertionError, "not at the insertion point"):
            benchmark.assert_editor_cursor(screen, "输入")


class VirtualScreenTests(unittest.TestCase):
    def test_resize_reflows_full_width_lines_and_unwraps_them_on_expand(self) -> None:
        screen = benchmark.VirtualScreen(10, 5)
        screen.feed(b"ABCDEFGHIJ\r\nTAIL")

        screen.resize(6, 5)
        self.assertEqual(screen.render().splitlines()[:3], ["ABCDEF", "GHIJ", "TAIL"])

        screen.resize(10, 5)
        self.assertEqual(screen.render().splitlines()[:2], ["ABCDEFGHIJ", "TAIL"])

    def test_alternate_screen_modes_restore_primary_buffer(self) -> None:
        screen = benchmark.VirtualScreen(40, 8)
        screen.feed(benchmark.PRIMARY_SCREEN_SENTINEL.encode())
        screen.feed(b"\x1b[?1049h\x1b[?25l\x1b[?2004h\x1b[?1000;1006h\x1b[>1u")
        screen.feed(b"ALTERNATE_UI")

        self.assertEqual(screen.active_buffer, "alternate")
        self.assertIn("ALTERNATE_UI", screen.render())
        self.assertNotIn(benchmark.PRIMARY_SCREEN_SENTINEL, screen.render())

        screen.feed(b"\x1b[?1000;1006l\x1b[?2004l\x1b[?25h\x1b[<u\x1b[?1049l")
        state = screen.terminal_state()
        self.assertEqual(state["activeBuffer"], "primary")
        self.assertEqual(state["alternateEnterCount"], 1)
        self.assertEqual(state["alternateLeaveCount"], 1)
        self.assertTrue(state["cursorVisible"])
        self.assertFalse(state["bracketedPaste"])
        self.assertFalse(state["kittyKeyboard"])
        self.assertEqual(state["mouseModes"], [])
        self.assertIn(benchmark.PRIMARY_SCREEN_SENTINEL, screen.render())

    def test_terminal_cleanup_oracle_rejects_open_modes_and_scrollback_clear(self) -> None:
        fixture = object.__new__(benchmark.PtyFixture)
        fixture.screen = benchmark.VirtualScreen(40, 8)
        fixture.screen.feed(benchmark.PRIMARY_SCREEN_SENTINEL.encode())
        fixture.screen.feed(b"\x1b[?1049h\x1b[?25l\x1b[?2004h")
        fixture.raw_events = [(1.0, b"\x1b[3J")]

        with self.assertRaisesRegex(AssertionError, "terminal cleanup failed"):
            fixture.assert_terminal_restored()


class PtyEnvironmentTests(unittest.TestCase):
    def test_child_process_explicitly_disables_ci_classification(self) -> None:
        process = SimpleNamespace(pid=1234)
        with (
            mock.patch.object(benchmark.os, "openpty", return_value=(10, 11)),
            mock.patch.object(benchmark.PtyFixture, "_set_winsize"),
            mock.patch.object(benchmark.subprocess, "Popen", return_value=process) as popen,
            mock.patch.object(benchmark.os, "close"),
            mock.patch.object(benchmark.os, "set_blocking"),
            mock.patch.dict(
                benchmark.os.environ,
                {
                    "CI": "true",
                    "CONTINUOUS_INTEGRATION": "true",
                    "REAL_API_TOKEN": "must-not-leak",
                    "SERVICE_PASSWORD": "must-not-leak",
                },
                clear=False,
            ),
        ):
            benchmark.PtyFixture("idle")

        env = popen.call_args.kwargs["env"]
        self.assertEqual(env["CI"], "false")
        self.assertEqual(env["CONTINUOUS_INTEGRATION"], "false")
        self.assertNotIn("REAL_API_TOKEN", env)
        self.assertNotIn("SERVICE_PASSWORD", env)


class ArgumentContractTests(unittest.TestCase):
    def parse(self, *arguments: str) -> object:
        with (
            mock.patch.object(
                benchmark.sys, "argv", ["benchmark.py", *arguments]
            ),
            mock.patch.object(benchmark.sys, "stderr"),
        ):
            return benchmark.parse_args()

    def test_paired_mode_requires_an_explicit_supported_candidate_limit(self) -> None:
        roots = (
            "--paired-baseline-root",
            str(benchmark.HARNESS_ROOT),
            "--paired-candidate-root",
            str(benchmark.HARNESS_ROOT),
        )
        for invalid in ((), ("--candidate-concurrency", "1"), ("--candidate-concurrency", "5")):
            with self.subTest(arguments=invalid):
                with self.assertRaises(SystemExit):
                    self.parse(*roots, *invalid)

        parsed = self.parse(*roots, "--candidate-concurrency", "3")
        self.assertEqual(parsed.candidate_concurrency, 3)

    def test_candidate_limit_is_rejected_outside_paired_mode(self) -> None:
        with self.assertRaises(SystemExit):
            self.parse("--candidate-concurrency", "3")


class TerminalQueryTests(unittest.TestCase):
    def test_pump_exposes_synchronized_update_only_after_commit(self) -> None:
        fixture = object.__new__(benchmark.PtyFixture)
        fixture.master = 42
        fixture.screen = benchmark.VirtualScreen(100, 36)
        fixture._terminal_query_tail = b""
        fixture.raw_events = []
        fixture.frames = []
        fixture.last_screen = ""
        fixture.closed = False
        fixture.started_ns = benchmark.time.monotonic_ns()

        reads = [
            b"\x1b[?2026hpartial ",
            BlockingIOError(),
            b"frame\x1b[?2026l",
            BlockingIOError(),
        ]
        with (
            mock.patch.object(benchmark.select, "select", return_value=([42], [], [])),
            mock.patch.object(benchmark.os, "read", side_effect=reads),
        ):
            fixture.pump(0)
            self.assertEqual(fixture.frames, [])
            self.assertEqual(fixture.observable_screen(), "")
            fixture.pump(0)

        self.assertEqual(len(fixture.frames), 1)
        self.assertEqual(fixture.observable_screen(), fixture.frames[0].screen)
        self.assertIn("partial frame", fixture.frames[0].screen)

    def test_every_terminal_query_split_is_answered_exactly_once(self) -> None:
        expected_responses = {
            b"\x1b[?u": b"\x1b[?0u",
            b"\x1b[6n": b"\x1b[1;1R",
            b"\x1b[c": b"\x1b[?1;2c",
        }
        for query, response in expected_responses.items():
            for split in range(len(query) + 1):
                with self.subTest(query=query, split=split):
                    fixture = object.__new__(benchmark.PtyFixture)
                    fixture.master = 42
                    fixture.screen = benchmark.VirtualScreen(100, 36)
                    fixture._terminal_query_tail = b""

                    with mock.patch.object(benchmark.os, "write") as write:
                        fixture._respond_to_terminal_queries(query[:split])
                        fixture._respond_to_terminal_queries(query[split:])
                        fixture._respond_to_terminal_queries(b" suffix")

                    write.assert_called_once_with(42, response)
                    self.assertEqual(fixture._terminal_query_tail, b"")

    def test_cursor_report_uses_screen_state_from_the_same_read_chunk(self) -> None:
        fixture = object.__new__(benchmark.PtyFixture)
        fixture.master = 42
        fixture.screen = benchmark.VirtualScreen(100, 36)
        fixture._terminal_query_tail = b""
        fixture.raw_events = []
        fixture.frames = []
        fixture.last_screen = ""
        fixture.closed = False
        fixture.started_ns = benchmark.time.monotonic_ns()

        with (
            mock.patch.object(benchmark.select, "select", return_value=([42], [], [])),
            mock.patch.object(
                benchmark.os,
                "read",
                side_effect=[b"abc\x1b[6ndef", BlockingIOError()],
            ),
            mock.patch.object(benchmark.os, "write") as write,
        ):
            fixture.pump(0)

        write.assert_called_once_with(42, b"\x1b[1;4R")
        self.assertIn("abcdef", fixture.screen.render())

    def test_terminal_response_failure_does_not_truncate_virtual_screen(self) -> None:
        fixture = object.__new__(benchmark.PtyFixture)
        fixture.master = 42
        fixture.screen = benchmark.VirtualScreen(100, 36)
        fixture._terminal_query_tail = b""

        with mock.patch.object(benchmark.os, "write", side_effect=OSError("closed")):
            fixture._respond_to_terminal_queries(b"abc\x1b[6ndef")

        self.assertIn("abcdef", fixture.screen.render())
        self.assertEqual(fixture._terminal_query_tail, b"")


class RpcLineParserTests(unittest.TestCase):
    @staticmethod
    def fixture() -> object:
        fixture = object.__new__(benchmark.PtyFixture)
        fixture._rpc_line_buffer = b""
        fixture._rpc_responses = {}
        fixture._rpc_protocol_error = None
        return fixture

    def test_incremental_crlf_parser_waits_for_complete_line(self) -> None:
        fixture = self.fixture()
        fixture._feed_rpc_output(b'log line\r\n{"jsonrpc":"2.0","id":7,"res')
        self.assertEqual(fixture._rpc_responses, {})

        fixture._feed_rpc_output(b'ult":{"ok":true}}\r\n')

        self.assertEqual(fixture._rpc_responses[7][0]["result"], {"ok": True})
        self.assertIsNone(fixture._rpc_protocol_error)

    def test_duplicate_or_malformed_response_fails_closed(self) -> None:
        fixture = self.fixture()
        response = b'{"jsonrpc":"2.0","id":1,"result":{}}\n'
        fixture._feed_rpc_output(response + response)
        self.assertIn("duplicate", fixture._rpc_protocol_error)

        fixture = self.fixture()
        fixture._feed_rpc_output(b'{"jsonrpc":"2.0","id":1,"result":\n')
        self.assertIn("malformed", fixture._rpc_protocol_error)


class ProcessCleanupTests(unittest.TestCase):
    @staticmethod
    def server_fixture() -> object:
        fixture = object.__new__(benchmark.PtyFixture)
        fixture.scenario = "cli-server-1-agent-bootstrap"
        fixture.process = mock.Mock()
        fixture.process.poll.return_value = None
        fixture.process.returncode = 0
        fixture._server_stdin = mock.Mock()
        fixture.forced_cleanup = False
        fixture.expected_agent_count = 0
        fixture.closed = False
        fixture.master = 42
        fixture._temporary_directory = None
        return fixture

    def test_server_cleanup_closes_stdin_and_requires_exit_zero(self) -> None:
        fixture = self.server_fixture()
        server_input = fixture._server_stdin
        with (
            mock.patch.object(fixture, "_wait_for_process_exit", return_value=True),
            mock.patch.object(fixture, "drain_for"),
            mock.patch.object(benchmark.os, "close"),
        ):
            fixture.exit_cleanly()

        server_input.close.assert_called_once_with()
        self.assertIsNone(fixture._server_stdin)
        self.assertFalse(fixture.forced_cleanup)

    def test_forced_cleanup_is_a_correctness_failure(self) -> None:
        fixture = self.server_fixture()

        def force() -> None:
            fixture.forced_cleanup = True

        with (
            mock.patch.object(fixture, "_wait_for_process_exit", return_value=False),
            mock.patch.object(fixture, "_force_process_cleanup", side_effect=force),
            mock.patch.object(fixture, "drain_for"),
            mock.patch.object(benchmark.os, "close"),
        ):
            with self.assertRaisesRegex(AssertionError, "TERM/KILL fallback"):
                fixture.exit_cleanly()


class RealInkSignalShutdownTests(unittest.TestCase):
    @staticmethod
    def _cleanup_fixture(fixture: benchmark.PtyFixture) -> None:
        process = fixture.process
        lifecycle = ()
        try:
            lifecycle = fixture.agent_lifecycle()
        except Exception:
            pass
        agent_pids = [
            int(record["pid"])
            for record in lifecycle
            if isinstance(record.get("pid"), int)
            and not isinstance(record.get("pid"), bool)
        ]
        process_alive = process.poll() is None
        agents_alive = any(fixture._pid_is_alive(pid) for pid in agent_pids)
        if process_alive or agents_alive:
            try:
                benchmark.os.killpg(process.pid, benchmark.signal.SIGKILL)
            except ProcessLookupError:
                pass
        if process_alive:
            try:
                process.wait(timeout=2)
            except benchmark.subprocess.TimeoutExpired:
                pass

        deadline = benchmark.time.monotonic() + 2
        while (
            any(fixture._pid_is_alive(pid) for pid in agent_pids)
            and benchmark.time.monotonic() < deadline
        ):
            benchmark.time.sleep(0.02)

        if not fixture.closed:
            try:
                benchmark.os.close(fixture.master)
            except OSError:
                pass
            fixture.closed = True
        temporary_directory = fixture._temporary_directory
        fixture._temporary_directory = None
        if temporary_directory is not None:
            temporary_directory.cleanup()

    @unittest.skipUnless(
        benchmark.os.name == "posix" and hasattr(benchmark.os, "openpty"),
        "real Ink signal regression requires a POSIX PTY",
    )
    def test_production_ink_sigterm_exits_143_and_cleans_agent_processes(self) -> None:
        fixture = benchmark.PtyFixture("cli-ink-5-agent-cold-start")
        try:
            fixture.wait_for(
                lambda screen: benchmark.PROMPT in screen and "5 agents" in screen,
                20,
                "production CLI Ink prompt with five-Agent banner",
            )
            self.assertEqual(fixture.expected_agent_count, 5)
            fixture.validate_agent_lifecycle(require_exited=False)

            benchmark.os.kill(fixture.process.pid, benchmark.signal.SIGTERM)

            self.assertTrue(
                fixture._wait_for_process_exit(10),
                "roll chat did not finish graceful SIGTERM shutdown\n"
                f"screen:\n{fixture.observable_screen()}",
            )
            fixture.drain_for(0.1)

            with self.subTest("process exits through the signal handler"):
                self.assertEqual(
                    fixture.process.returncode,
                    128 + int(benchmark.signal.SIGTERM),
                    "expected graceful exit code 143 instead of raw signal status -15",
                )
                self.assertFalse(fixture.forced_cleanup)
            with self.subTest("Ink restores terminal state"):
                fixture.assert_terminal_restored()
            with self.subTest("stdio Agent fixtures all exit"):
                fixture.assert_agent_processes_stopped(timeout=5)
        finally:
            self._cleanup_fixture(fixture)


class FailureArtifactTests(unittest.TestCase):
    def test_main_persists_artifacts_and_returns_nonzero_on_scenario_failure(self) -> None:
        fixture = object.__new__(benchmark.PtyFixture)
        fixture.raw_events = [(1.25, b"\x1b[31mRoll UI\x1b[0m")]
        fixture.screen = benchmark.VirtualScreen(100, 36)
        fixture.screen.feed(b"Roll UI")

        failure = benchmark.ScenarioFailure(
            "cli-ink-cold-start",
            fixture,
            "Roll UI",
            "AssertionError: timed out waiting for prompt",
        )

        with tempfile.TemporaryDirectory() as temporary_directory:
            output = Path(temporary_directory) / "results.json"
            args = SimpleNamespace(
                samples=1,
                output=output,
                baseline=None,
                max_regression_percent=25.0,
                check=True,
                scenarios=["cli-ink-cold-start"],
            )
            with (
                mock.patch.object(benchmark, "parse_args", return_value=args),
                mock.patch.object(benchmark, "run_scenario", side_effect=failure),
                mock.patch.object(benchmark.sys, "stderr"),
            ):
                self.assertEqual(benchmark.main(), 1)

            stem = output.parent / "raw" / "cli-ink-cold-start-1"
            self.assertEqual(stem.with_suffix(".ansi").read_bytes(), b"\x1b[31mRoll UI\x1b[0m")
            self.assertIn("dataBase64", stem.with_suffix(".frames.jsonl").read_text())
            self.assertEqual(stem.with_suffix(".screen.txt").read_text(), "Roll UI")
            terminal_state = json.loads(stem.with_suffix(".terminal.json").read_text())
            self.assertEqual(terminal_state["activeBuffer"], "primary")
            self.assertIn(
                "timed out waiting for prompt",
                stem.with_suffix(".failure.txt").read_text(),
            )


if __name__ == "__main__":
    unittest.main()
