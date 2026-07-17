#!/usr/bin/env python3
"""Deterministic real-PTY performance harness for the roll chat Ink UI."""

from __future__ import annotations

import argparse
import base64
import codecs
from collections import Counter
import ctypes
import fcntl
import hashlib
import json
import math
import os
from pathlib import Path
import platform
import re
import select
import signal
import struct
import subprocess
import sys
import termios
import tempfile
import time
import unicodedata
from dataclasses import dataclass
from typing import Callable, Iterable, Mapping


REPO_ROOT = Path(__file__).resolve().parents[2]
FIXTURE = REPO_ROOT / "benchmarks" / "chat-pty" / "fixture.ts"
CLI_ENTRY = REPO_ROOT / "packages" / "core" / "src" / "cli" / "index.ts"
DEFAULT_OUTPUT = REPO_ROOT / "outputs" / "chat-pty" / "results.json"
RESULT_SCHEMA_VERSION = 2
SUITE_NAME = "roll-chat-real-pty"
SCENARIOS = (
    "cli-bootstrap",
    "cli-ink-cold-start",
    "fixture-ink-cold-start",
    "keypress",
    "text-stream",
    "tool-stream",
    "resize-storm",
    "idle",
)
PROMPT = "›"

REQUIRED_BASELINE_METRICS: Mapping[str, tuple[str, ...]] = {
    "cli-bootstrap": ("cliBootstrapReadyMs",),
    "cli-ink-cold-start": ("cliInkFirstInteractiveMs",),
    "fixture-ink-cold-start": ("fixtureInkFirstInteractiveMs",),
    "keypress": ("keypressToRenderMs",),
    "text-stream": (
        "firstTokenMs",
        "totalMs",
        "frameIntervalMedianMs",
        "frameIntervalP95Ms",
        "frameIntervalP99Ms",
    ),
    "tool-stream": (
        "firstDeltaMs",
        "totalMs",
        "frameIntervalMedianMs",
        "frameIntervalP95Ms",
        "frameIntervalP99Ms",
    ),
    "resize-storm": ("stableAfterLastResizeMs",),
    "idle": ("invalidFrames", "outputBytes"),
}
OPTIONAL_BASELINE_METRICS = {"idle": ("cpuMs",)}


def percentile(values: list[float], quantile: float) -> float:
    if not values:
        raise ValueError("percentile requires at least one value")
    ordered = sorted(values)
    if len(ordered) == 1:
        return ordered[0]
    position = (len(ordered) - 1) * quantile
    lower = math.floor(position)
    upper = math.ceil(position)
    if lower == upper:
        return ordered[lower]
    weight = position - lower
    return ordered[lower] * (1 - weight) + ordered[upper] * weight


def stats(values: Iterable[float]) -> dict[str, float | int]:
    samples = [round(float(value), 3) for value in values]
    if not samples:
        return {"samples": 0}
    return {
        "samples": len(samples),
        "min": round(min(samples), 3),
        "median": round(percentile(samples, 0.5), 3),
        "p95": round(percentile(samples, 0.95), 3),
        "p99": round(percentile(samples, 0.99), 3),
        "max": round(max(samples), 3),
    }


def char_width(char: str) -> int:
    if not char or unicodedata.combining(char) or char in ("\ufe0e", "\ufe0f", "\u200d"):
        return 0
    return 2 if unicodedata.east_asian_width(char) in ("W", "F") else 1


class VirtualScreen:
    """Small VT screen covering the cursor/erase sequences emitted by Ink 7."""

    def __init__(self, columns: int, rows: int) -> None:
        self.columns = columns
        self.rows = rows
        self.grid = [[" "] * columns for _ in range(rows)]
        self.x = 0
        self.y = 0
        self.saved = (0, 0)
        self.state = "normal"
        self.sequence = ""
        self.decoder = codecs.getincrementaldecoder("utf-8")("replace")

    def resize(self, columns: int, rows: int) -> None:
        resized = [[" "] * columns for _ in range(rows)]
        for row in range(min(rows, self.rows)):
            for column in range(min(columns, self.columns)):
                resized[row][column] = self.grid[row][column]
        self.columns = columns
        self.rows = rows
        self.grid = resized
        self.x = min(self.x, columns - 1)
        self.y = min(self.y, rows - 1)

    def render(self) -> str:
        lines = ["".join(cell for cell in row if cell != "").rstrip() for row in self.grid]
        while lines and lines[-1] == "":
            lines.pop()
        return "\n".join(lines)

    def feed(self, data: bytes) -> None:
        for char in self.decoder.decode(data):
            self._feed_char(char)

    def _feed_char(self, char: str) -> None:
        if self.state == "normal":
            if char == "\x1b":
                self.state = "escape"
            elif char == "\r":
                self.x = 0
            elif char == "\n":
                self._line_feed()
            elif char == "\b":
                self.x = max(0, self.x - 1)
            elif char == "\t":
                self.x = min(self.columns - 1, ((self.x // 8) + 1) * 8)
            elif ord(char) >= 32 and char != "\x7f":
                self._write(char)
            return

        if self.state == "escape":
            if char == "[":
                self.state = "csi"
                self.sequence = ""
            elif char == "]":
                self.state = "osc"
            elif char in ("P", "^", "_"):
                self.state = "string"
            elif char == "7":
                self.saved = (self.x, self.y)
                self.state = "normal"
            elif char == "8":
                self.x, self.y = self.saved
                self.state = "normal"
            elif char == "c":
                self._clear()
                self.state = "normal"
            else:
                self.state = "normal"
            return

        if self.state == "csi":
            self.sequence += char
            if "@" <= char <= "~":
                self._apply_csi(self.sequence)
                self.sequence = ""
                self.state = "normal"
            return

        if self.state == "osc":
            if char == "\a":
                self.state = "normal"
            elif char == "\x1b":
                self.state = "osc-escape"
            return

        if self.state == "osc-escape":
            self.state = "normal" if char == "\\" else "osc"
            return

        if self.state == "string":
            if char == "\x1b":
                self.state = "string-escape"
            return

        if self.state == "string-escape":
            self.state = "normal" if char == "\\" else "string"

    def _write(self, char: str) -> None:
        width = char_width(char)
        if width == 0:
            target = max(0, self.x - 1)
            self.grid[self.y][target] += char
            return
        if self.x >= self.columns or (width == 2 and self.x == self.columns - 1):
            self.x = 0
            self._line_feed()
        self.grid[self.y][self.x] = char
        if width == 2 and self.x + 1 < self.columns:
            self.grid[self.y][self.x + 1] = ""
        self.x += width

    def _line_feed(self) -> None:
        self.y += 1
        if self.y >= self.rows:
            self.grid.pop(0)
            self.grid.append([" "] * self.columns)
            self.y = self.rows - 1

    def _clear(self) -> None:
        self.grid = [[" "] * self.columns for _ in range(self.rows)]
        self.x = 0
        self.y = 0

    def _erase_line(self, mode: int) -> None:
        if mode == 2:
            self.grid[self.y] = [" "] * self.columns
        elif mode == 1:
            for column in range(0, min(self.x + 1, self.columns)):
                self.grid[self.y][column] = " "
        else:
            for column in range(self.x, self.columns):
                self.grid[self.y][column] = " "

    def _erase_display(self, mode: int) -> None:
        if mode in (2, 3):
            self._clear()
            return
        if mode == 1:
            for row in range(0, self.y):
                self.grid[row] = [" "] * self.columns
            self._erase_line(1)
            return
        self._erase_line(0)
        for row in range(self.y + 1, self.rows):
            self.grid[row] = [" "] * self.columns

    @staticmethod
    def _params(raw: str) -> tuple[list[int], bool]:
        private = raw.startswith(("?", ">", "<", "="))
        body = raw[1:] if private else raw
        parts = body.split(";") if body else []
        parsed = [int(part) if part.isdigit() else 0 for part in parts]
        return parsed, private

    def _apply_csi(self, sequence: str) -> None:
        final = sequence[-1]
        params, private = self._params(sequence[:-1])
        first = params[0] if params and params[0] > 0 else 1
        if final == "m" or private:
            return
        if final == "A":
            self.y = max(0, self.y - first)
        elif final == "B":
            self.y = min(self.rows - 1, self.y + first)
        elif final == "C":
            self.x = min(self.columns - 1, self.x + first)
        elif final == "D":
            self.x = max(0, self.x - first)
        elif final == "E":
            self.y = min(self.rows - 1, self.y + first)
            self.x = 0
        elif final == "F":
            self.y = max(0, self.y - first)
            self.x = 0
        elif final == "G":
            self.x = min(self.columns - 1, first - 1)
        elif final == "d":
            self.y = min(self.rows - 1, first - 1)
        elif final in ("H", "f"):
            row = params[0] if params and params[0] > 0 else 1
            column = params[1] if len(params) > 1 and params[1] > 0 else 1
            self.y = min(self.rows - 1, row - 1)
            self.x = min(self.columns - 1, column - 1)
        elif final == "J":
            self._erase_display(params[0] if params else 0)
        elif final == "K":
            self._erase_line(params[0] if params else 0)
        elif final == "s":
            self.saved = (self.x, self.y)
        elif final == "u":
            self.x, self.y = self.saved
        elif final == "S":
            for _ in range(first):
                self.grid.pop(0)
                self.grid.append([" "] * self.columns)
        elif final == "T":
            for _ in range(first):
                self.grid.pop()
                self.grid.insert(0, [" "] * self.columns)


@dataclass(frozen=True)
class Frame:
    elapsed_ms: float
    screen: str


@dataclass(frozen=True)
class MarkerObservation:
    first_seen: tuple[int, ...]
    duplicates: tuple[int, ...]


class PtyFixture:
    def __init__(self, scenario: str, columns: int = 100, rows: int = 36) -> None:
        master, slave = os.openpty()
        self.master = master
        self.screen = VirtualScreen(columns, rows)
        self.frames: list[Frame] = []
        self.raw_events: list[tuple[float, bytes]] = []
        self.started_ns = time.monotonic_ns()
        self.last_screen = ""
        self.closed = False
        self.scenario = scenario
        self._temporary_directory: tempfile.TemporaryDirectory[str] | None = None
        self._set_winsize(slave, columns, rows)
        env = {
            **os.environ,
            "TERM": "xterm-256color",
            "COLORTERM": "truecolor",
            "FORCE_COLOR": "1",
            "ROLL_PTY_BENCHMARK": "1",
        }
        command = [
            os.environ.get("NODE", "node"),
            "--disable-warning=ExperimentalWarning",
            "--experimental-strip-types",
            str(FIXTURE),
            scenario,
        ]
        cwd = REPO_ROOT
        if scenario in ("cli-bootstrap", "cli-ink-cold-start"):
            self._temporary_directory = tempfile.TemporaryDirectory(prefix="roll-chat-cli-")
            cwd = Path(self._temporary_directory.name)
            env["HOME"] = str(cwd)
            config = {
                "llm": {
                    "default-provider": "openai",
                    "default-model": "gpt-5.5",
                    "providers": {
                        "openai": {
                            "api-key": "benchmark-no-network-key",
                            "base-url": "http://127.0.0.1:1/v1",
                        }
                    },
                },
                "agents": {"data-dir": str(cwd / "agents")},
                "runtime": {
                    "threads-dir": str(cwd / "threads"),
                    "thinking-level": "off",
                },
            }
            (cwd / "roll.config.yaml").write_text(
                json.dumps(config, ensure_ascii=False), encoding="utf-8"
            )
            command = [
                os.environ.get("NODE", "node"),
                "--disable-warning=ExperimentalWarning",
                "--experimental-strip-types",
                str(CLI_ENTRY),
                "chat",
            ]
            if scenario == "cli-bootstrap":
                command.append("--server")
        self.process = subprocess.Popen(
            command,
            cwd=cwd,
            env=env,
            stdin=slave,
            stdout=slave,
            stderr=slave,
            close_fds=True,
            start_new_session=True,
        )
        os.close(slave)
        os.set_blocking(master, False)

    @staticmethod
    def _set_winsize(fd: int, columns: int, rows: int) -> None:
        fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, columns, 0, 0))

    def elapsed_ms(self) -> float:
        return (time.monotonic_ns() - self.started_ns) / 1_000_000

    def send(self, text: str) -> None:
        os.write(self.master, text.encode("utf-8"))

    def resize(self, columns: int, rows: int) -> None:
        self._set_winsize(self.master, columns, rows)
        self.screen.resize(columns, rows)
        try:
            os.killpg(self.process.pid, signal.SIGWINCH)
        except ProcessLookupError:
            pass

    def _respond_to_terminal_queries(self, chunk: bytes) -> None:
        responses: list[bytes] = []
        if b"\x1b[?u" in chunk:
            responses.append(b"\x1b[?0u")
        if b"\x1b[6n" in chunk:
            responses.append(f"\x1b[{self.screen.y + 1};{self.screen.x + 1}R".encode())
        if b"\x1b[c" in chunk:
            responses.append(b"\x1b[?1;2c")
        for response in responses:
            try:
                os.write(self.master, response)
            except OSError:
                return

    def pump(self, timeout: float) -> bool:
        if self.closed:
            return False
        readable, _, _ = select.select([self.master], [], [], max(0.0, timeout))
        if not readable:
            return False
        changed = False
        while True:
            try:
                chunk = os.read(self.master, 65_536)
            except BlockingIOError:
                break
            except OSError:
                self.closed = True
                break
            if not chunk:
                self.closed = True
                break
            elapsed = self.elapsed_ms()
            self.raw_events.append((elapsed, chunk))
            self._respond_to_terminal_queries(chunk)
            self.screen.feed(chunk)
            rendered = self.screen.render()
            if rendered != self.last_screen:
                self.last_screen = rendered
                self.frames.append(Frame(elapsed, rendered))
                changed = True
        return changed

    def wait_for(self, predicate: Callable[[str], bool], timeout: float, label: str) -> float:
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            if predicate(self.screen.render()):
                return self.elapsed_ms()
            self.pump(min(0.05, max(0.0, deadline - time.monotonic())))
            if self.process.poll() is not None and not predicate(self.screen.render()):
                raise AssertionError(
                    f"fixture exited before {label} (status={self.process.returncode})\n"
                    f"screen:\n{self.screen.render()}"
                )
        raise AssertionError(f"timed out waiting for {label}\nscreen:\n{self.screen.render()}")

    def wait_quiet(self, quiet_ms: float = 220, timeout: float = 4.0) -> None:
        deadline = time.monotonic() + timeout
        quiet_started = time.monotonic()
        frame_count = len(self.frames)
        while time.monotonic() < deadline:
            self.pump(0.03)
            if len(self.frames) != frame_count:
                frame_count = len(self.frames)
                quiet_started = time.monotonic()
            if (time.monotonic() - quiet_started) * 1000 >= quiet_ms:
                return
        raise AssertionError("terminal did not become quiet")

    def drain_for(self, duration: float) -> None:
        deadline = time.monotonic() + duration
        while time.monotonic() < deadline:
            self.pump(min(0.05, deadline - time.monotonic()))

    def cpu_seconds(self) -> float | None:
        proc_stat = Path(f"/proc/{self.process.pid}/stat")
        if proc_stat.exists():
            try:
                raw = proc_stat.read_text(encoding="utf-8")
                fields = raw[raw.rfind(")") + 2 :].split()
                ticks = int(fields[11]) + int(fields[12])
                return ticks / os.sysconf("SC_CLK_TCK")
            except (OSError, ValueError, IndexError):
                return None
        if sys.platform == "darwin":
            try:
                # libproc reports nanosecond counters for a live process. The first
                # two uint64 fields after the 16-byte UUID are user and system time.
                buffer = ctypes.create_string_buffer(256)
                proc_pid_rusage = ctypes.CDLL("/usr/lib/libproc.dylib").proc_pid_rusage
                proc_pid_rusage.argtypes = [ctypes.c_int, ctypes.c_int, ctypes.c_void_p]
                proc_pid_rusage.restype = ctypes.c_int
                if proc_pid_rusage(self.process.pid, 2, buffer) == 0:
                    user_ns = int.from_bytes(buffer.raw[16:24], sys.byteorder)
                    system_ns = int.from_bytes(buffer.raw[24:32], sys.byteorder)
                    return (user_ns + system_ns) / 1_000_000_000
            except (AttributeError, OSError, ValueError):
                return None
        try:
            raw = subprocess.check_output(
                ["ps", "-o", "time=", "-p", str(self.process.pid)], text=True
            ).strip()
        except (OSError, subprocess.SubprocessError):
            return None
        match = re.fullmatch(r"(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+(?:\.\d+)?)", raw)
        if not match:
            return None
        days, hours, minutes, seconds = match.groups(default="0")
        return int(days) * 86_400 + int(hours) * 3_600 + int(minutes) * 60 + float(seconds)

    def exit_cleanly(self) -> None:
        if self.process.poll() is None and self.scenario == "cli-bootstrap":
            try:
                os.killpg(self.process.pid, signal.SIGTERM)
            except ProcessLookupError:
                pass
            try:
                self.process.wait(timeout=2)
            except subprocess.TimeoutExpired:
                try:
                    os.killpg(self.process.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
                self.process.wait(timeout=1)
        elif self.process.poll() is None:
            try:
                # Clear any draft left by the keypress scenario before invoking the
                # real slash command. Ink handles input per render, so type the
                # command incrementally instead of delivering `/exit<Enter>` in one
                # read (which can observe stale `slashActive` React state).
                self.send("\x15")
                self.drain_for(0.04)
                for char in "/exit":
                    self.send(char)
                    self.drain_for(0.015)
                self.send("\r")
                deadline = time.monotonic() + 2
                while self.process.poll() is None and time.monotonic() < deadline:
                    self.pump(0.03)
                if self.process.poll() is None:
                    raise subprocess.TimeoutExpired(self.process.args, 2)
            except (OSError, subprocess.TimeoutExpired):
                try:
                    os.killpg(self.process.pid, signal.SIGTERM)
                except ProcessLookupError:
                    pass
                try:
                    self.process.wait(timeout=1)
                except subprocess.TimeoutExpired:
                    try:
                        os.killpg(self.process.pid, signal.SIGKILL)
                    except ProcessLookupError:
                        pass
                    self.process.wait(timeout=1)
        try:
            self.drain_for(0.05)
            if not self.closed:
                os.close(self.master)
                self.closed = True
            if self.process.returncode not in (0, -signal.SIGTERM, -signal.SIGKILL):
                raise AssertionError(f"fixture exited with status {self.process.returncode}")
        finally:
            if self._temporary_directory is not None:
                temporary_directory = self._temporary_directory
                self._temporary_directory = None
                temporary_directory.cleanup()

    def force_close(self) -> None:
        try:
            self.exit_cleanly()
        except Exception:
            if self.process.poll() is None:
                try:
                    os.killpg(self.process.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
                self.process.wait(timeout=1)
            if not self.closed:
                os.close(self.master)
                self.closed = True


def frame_intervals(frames: list[Frame], started_ms: float, ended_ms: float) -> list[float]:
    timestamps = [frame.elapsed_ms for frame in frames if started_ms <= frame.elapsed_ms <= ended_ms]
    return [later - earlier for earlier, later in zip(timestamps, timestamps[1:])]


def observed_numeric_markers(
    frames: list[Frame], pattern: re.Pattern[str]
) -> MarkerObservation:
    first_seen: list[int] = []
    seen: set[int] = set()
    duplicates: set[int] = set()
    for frame in frames:
        visible = [int(match) for match in pattern.findall(frame.screen)]
        duplicates.update(value for value, count in Counter(visible).items() if count > 1)
        for value in visible:
            if value not in seen:
                seen.add(value)
                first_seen.append(value)
    return MarkerObservation(tuple(first_seen), tuple(sorted(duplicates)))


def assert_complete_sequence(label: str, observation: MarkerObservation, count: int) -> None:
    if observation.duplicates:
        raise AssertionError(
            f"{label} sequence contains duplicate markers: {list(observation.duplicates)}"
        )
    observed = list(observation.first_seen)
    expected = list(range(count))
    if observed == expected:
        return
    observed_set = set(observed)
    expected_set = set(expected)
    missing = sorted(expected_set - observed_set)
    unexpected = sorted(observed_set - expected_set)
    raise AssertionError(
        f"{label} sequence mismatch: missing={missing}, unexpected={unexpected}, "
        f"observed={observed}"
    )


def assert_prompt(screen: str) -> None:
    if PROMPT not in screen:
        raise AssertionError(f"final screen does not contain prompt\n{screen}")


def run_scenario(scenario: str) -> tuple[dict[str, float | int | bool], PtyFixture]:
    fixture = PtyFixture(scenario)
    try:
        if scenario == "cli-bootstrap":
            ready_ms = fixture.wait_for(
                lambda screen: "roll runtime-server 已启动" in screen,
                8,
                "production CLI runtime-server bootstrap",
            )
            return {
                "cliBootstrapReadyMs": ready_ms,
                "configLoaded": True,
                "runtimeServerStarted": True,
            }, fixture

        if scenario == "cli-ink-cold-start":
            ready_ms = fixture.wait_for(
                lambda screen: PROMPT in screen,
                8,
                "production CLI Ink interactive prompt",
            )
            final_screen = fixture.screen.render()
            assert_prompt(final_screen)
            if "roll runtime-server 已启动" in final_screen:
                raise AssertionError("production CLI Ink scenario entered server mode")
            return {
                "cliInkFirstInteractiveMs": ready_ms,
                "productionCliStarted": True,
                "interactivePromptReady": True,
            }, fixture

        ready_ms = fixture.wait_for(lambda screen: PROMPT in screen, 6, "first interactive prompt")
        if scenario == "fixture-ink-cold-start":
            assert_prompt(fixture.screen.render())
            return {"fixtureInkFirstInteractiveMs": ready_ms}, fixture

        fixture.wait_quiet()
        if scenario == "keypress":
            started = fixture.elapsed_ms()
            fixture.send("k")
            rendered = fixture.wait_for(
                lambda screen: re.search(r"›\s+k", screen) is not None,
                2,
                "keypress echo",
            )
            assert_prompt(fixture.screen.render())
            return {"keypressToRenderMs": rendered - started}, fixture

        if scenario == "text-stream":
            started = fixture.elapsed_ms()
            first_frame_index = len(fixture.frames)
            fixture.send("stream\r")
            first_token = fixture.wait_for(lambda screen: "word000" in screen, 3, "first stream token")
            completed = fixture.wait_for(
                lambda screen: "STREAM_COMPLETE_400" in screen, 8, "400-word completion"
            )
            final_screen = fixture.screen.render()
            if "STREAM_COMPLETE_400" not in final_screen:
                raise AssertionError(f"400-word final screen is incomplete\n{final_screen}")
            relevant = fixture.frames[first_frame_index:]
            observed = observed_numeric_markers(relevant, re.compile(r"word(\d{3})"))
            assert_complete_sequence("text word", observed, 399)
            intervals = frame_intervals(relevant, first_token, completed)
            return {
                "firstTokenMs": first_token - started,
                "totalMs": completed - started,
                "observableFrames": len(relevant),
                "frameIntervalMedianMs": percentile(intervals, 0.5) if intervals else 0,
                "frameIntervalP95Ms": percentile(intervals, 0.95) if intervals else 0,
                "frameIntervalP99Ms": percentile(intervals, 0.99) if intervals else 0,
                "emittedWords": 400,
                "observedWords": len(observed.first_seen) + 1,
                "wordOracleComplete": True,
            }, fixture

        if scenario == "tool-stream":
            started = fixture.elapsed_ms()
            first_frame_index = len(fixture.frames)
            fixture.send("tool\r")
            first_delta = fixture.wait_for(lambda screen: "tool-chunk-00" in screen, 3, "first tool delta")
            fixture.wait_for(lambda screen: "tool-chunk-79" in screen, 5, "final tool delta")
            completed = fixture.wait_for(
                lambda screen: "TOOL_STREAM_COMPLETE" in screen, 5, "tool stream completion"
            )
            relevant = fixture.frames[first_frame_index:]
            observed = observed_numeric_markers(relevant, re.compile(r"tool-chunk-(\d+)"))
            assert_complete_sequence("tool chunk", observed, 80)
            final_screen = fixture.screen.render()
            if "fixture.stream_tool" not in final_screen or "TOOL_STREAM_COMPLETE" not in final_screen:
                raise AssertionError(f"tool final screen is incomplete\n{final_screen}")
            intervals = frame_intervals(relevant, first_delta, completed)
            return {
                "firstDeltaMs": first_delta - started,
                "totalMs": completed - started,
                "observableFrames": len(relevant),
                "observedChunks": len(observed.first_seen),
                "chunkOracleComplete": True,
                "frameIntervalMedianMs": percentile(intervals, 0.5) if intervals else 0,
                "frameIntervalP95Ms": percentile(intervals, 0.95) if intervals else 0,
                "frameIntervalP99Ms": percentile(intervals, 0.99) if intervals else 0,
                "emittedChunks": 80,
            }, fixture

        if scenario == "resize-storm":
            sizes = [(62, 20), (140, 42), (78, 24), (120, 36)] * 6
            first_frame_index = len(fixture.frames)
            for columns, rows in sizes:
                fixture.resize(columns, rows)
                fixture.drain_for(0.018)
            last_resize = fixture.elapsed_ms()
            frames_before_final_resize = len(fixture.frames)
            fixture.resize(100, 36)
            stable = fixture.wait_for(
                lambda screen: len(fixture.frames) > frames_before_final_resize
                and PROMPT in screen
                and "pty-fixture/resize-storm" in screen,
                3,
                "stable screen after resize storm",
            )
            fixture.wait_quiet(quiet_ms=150)
            assert_prompt(fixture.screen.render())
            return {
                "resizeCount": len(sizes) + 1,
                "stableAfterLastResizeMs": stable - last_resize,
                "redrawFrames": len(fixture.frames) - first_frame_index,
            }, fixture

        if scenario == "idle":
            frame_count = len(fixture.frames)
            byte_count = sum(len(chunk) for _, chunk in fixture.raw_events)
            cpu_before = fixture.cpu_seconds()
            fixture.drain_for(1.0)
            cpu_after = fixture.cpu_seconds()
            assert_prompt(fixture.screen.render())
            idle_result: dict[str, float | int | bool] = {
                "windowMs": 1_000,
                "invalidFrames": len(fixture.frames) - frame_count,
                "outputBytes": sum(len(chunk) for _, chunk in fixture.raw_events) - byte_count,
                "cpuAvailable": cpu_before is not None and cpu_after is not None,
            }
            if cpu_before is not None and cpu_after is not None:
                idle_result["cpuMs"] = max(0.0, (cpu_after - cpu_before) * 1_000)
            return idle_result, fixture

        raise AssertionError(f"unknown scenario: {scenario}")
    except Exception:
        fixture.force_close()
        raise


def save_artifacts(
    artifact_dir: Path,
    scenario: str,
    sample: int,
    fixture: PtyFixture,
    final_screen: str,
) -> dict[str, str]:
    def display_path(path: Path) -> str:
        try:
            return str(path.relative_to(REPO_ROOT))
        except ValueError:
            return str(path)

    artifact_dir.mkdir(parents=True, exist_ok=True)
    stem = f"{scenario}-{sample + 1}"
    ansi_path = artifact_dir / f"{stem}.ansi"
    frames_path = artifact_dir / f"{stem}.frames.jsonl"
    screen_path = artifact_dir / f"{stem}.screen.txt"
    ansi_path.write_bytes(b"".join(chunk for _, chunk in fixture.raw_events))
    with frames_path.open("w", encoding="utf-8") as handle:
        for elapsed_ms, chunk in fixture.raw_events:
            handle.write(
                json.dumps(
                    {
                        "elapsedMs": round(elapsed_ms, 3),
                        "dataBase64": base64.b64encode(chunk).decode("ascii"),
                    },
                    ensure_ascii=False,
                )
                + "\n"
            )
    # Keep the correctness artifact identical to the snapshot whose hash is in
    # results.json. Raw ANSI/frames intentionally include teardown for debugging.
    screen_path.write_text(final_screen, encoding="utf-8")
    return {
        "ansi": display_path(ansi_path),
        "frames": display_path(frames_path),
        "screen": display_path(screen_path),
    }


def aggregate(samples: list[dict[str, object]]) -> dict[str, object]:
    metrics: dict[str, object] = {}
    keys = sorted({key for sample in samples for key in sample if key != "artifacts"})
    for key in keys:
        values = [sample[key] for sample in samples if key in sample]
        if values and all(isinstance(value, bool) for value in values):
            metrics[key] = {"samples": len(values), "all": all(values)}
        elif values and all(
            isinstance(value, (int, float)) and not isinstance(value, bool)
            for value in values
        ):
            metrics[key] = stats(float(value) for value in values)
    return metrics


def object_mapping(value: object) -> Mapping[str, object] | None:
    return value if isinstance(value, dict) else None


def metric_median(metrics: Mapping[str, object], metric: str) -> float | None:
    metric_stats = object_mapping(metrics.get(metric))
    if metric_stats is None:
        return None
    median = metric_stats.get("median")
    if isinstance(median, bool) or not isinstance(median, (int, float)):
        return None
    return float(median)


def compare_baseline(
    current: dict[str, object], baseline_path: Path, max_regression_percent: float
) -> list[str]:
    try:
        baseline_value: object = json.loads(baseline_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        return [f"baseline could not be read: {error}"]
    baseline = object_mapping(baseline_value)
    if baseline is None:
        return ["baseline root must be an object"]

    failures: list[str] = []
    if baseline.get("schemaVersion") != current.get("schemaVersion"):
        failures.append(
            "baseline schemaVersion does not match current result "
            f"({baseline.get('schemaVersion')!r} != {current.get('schemaVersion')!r})"
        )
    if baseline.get("suite") != current.get("suite"):
        failures.append(
            "baseline suite does not match current result "
            f"({baseline.get('suite')!r} != {current.get('suite')!r})"
        )

    current_scenarios = object_mapping(current.get("scenarios"))
    baseline_scenarios = object_mapping(baseline.get("scenarios"))
    if current_scenarios is None:
        return [*failures, "current result scenarios must be an object"]
    if baseline_scenarios is None:
        return [*failures, "baseline scenarios must be an object"]

    for scenario, scenario_value in current_scenarios.items():
        required_metrics = REQUIRED_BASELINE_METRICS.get(scenario)
        if required_metrics is None:
            failures.append(f"no baseline metric contract for scenario: {scenario}")
            continue
        current_scenario = object_mapping(scenario_value)
        if current_scenario is None:
            failures.append(f"current scenario is not an object: {scenario}")
            continue
        baseline_scenario = object_mapping(baseline_scenarios.get(scenario))
        if baseline_scenario is None:
            failures.append(f"baseline missing scenario: {scenario}")
            continue
        current_metrics = object_mapping(current_scenario.get("metrics"))
        baseline_metrics = object_mapping(baseline_scenario.get("metrics"))
        if current_metrics is None:
            failures.append(f"current scenario missing metrics: {scenario}")
            continue
        if baseline_metrics is None:
            failures.append(f"baseline scenario missing metrics: {scenario}")
            continue

        optional_metrics = tuple(
            metric
            for metric in OPTIONAL_BASELINE_METRICS.get(scenario, ())
            if metric_median(current_metrics, metric) is not None
            and metric_median(baseline_metrics, metric) is not None
        )
        for metric in (*required_metrics, *optional_metrics):
            current_median = metric_median(current_metrics, metric)
            baseline_median = metric_median(baseline_metrics, metric)
            if current_median is None:
                failures.append(f"current metric missing or non-numeric: {scenario}.{metric}.median")
                continue
            if baseline_median is None:
                failures.append(f"baseline metric missing or non-numeric: {scenario}.{metric}.median")
                continue
            allowed = (
                baseline_median * (1 + max_regression_percent / 100)
                if baseline_median > 0
                else baseline_median + 1
            )
            if current_median > allowed:
                failures.append(
                    f"{scenario}.{metric}: median {current_median:.3f} > allowed {allowed:.3f} "
                    f"(baseline {baseline_median:.3f})"
                )
    return failures


def environment() -> dict[str, object]:
    node_version = subprocess.check_output(
        [os.environ.get("NODE", "node"), "--version"], text=True
    ).strip()
    try:
        commit = subprocess.check_output(
            ["git", "rev-parse", "HEAD"], cwd=REPO_ROOT, text=True, stderr=subprocess.DEVNULL
        ).strip()
    except subprocess.SubprocessError:
        commit = "unknown"
    return {
        "platform": platform.platform(),
        "machine": platform.machine(),
        "python": platform.python_version(),
        "node": node_version,
        "cpuCount": os.cpu_count(),
        "commit": commit,
        "terminal": {"columns": 100, "rows": 36, "term": "xterm-256color"},
    }


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--samples", type=int, default=3)
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    parser.add_argument("--baseline", type=Path)
    parser.add_argument("--max-regression-percent", type=float, default=25.0)
    parser.add_argument("--check", action="store_true", help="correctness smoke; no timing budget")
    parser.add_argument("--scenario", action="append", choices=SCENARIOS, dest="scenarios")
    args = parser.parse_args()
    if args.samples < 1:
        parser.error("--samples must be >= 1")
    return args


def main() -> int:
    if os.name != "posix":
        print("chat PTY benchmark currently requires macOS or Linux", file=sys.stderr)
        return 2
    args = parse_args()
    selected = tuple(args.scenarios or SCENARIOS)
    output_path = args.output.resolve()
    artifact_dir = output_path.parent / "raw"
    scenario_results: dict[str, object] = {}
    started = time.time()

    for scenario in selected:
        samples: list[dict[str, object]] = []
        for sample_index in range(args.samples):
            metrics, fixture = run_scenario(scenario)
            final_screen = fixture.screen.render()
            fixture.exit_cleanly()
            sample_result: dict[str, object] = {
                **metrics,
                "finalScreenSha256": hashlib.sha256(final_screen.encode()).hexdigest(),
                "artifacts": save_artifacts(
                    artifact_dir, scenario, sample_index, fixture, final_screen
                ),
            }
            samples.append(sample_result)
        scenario_results[scenario] = {"samples": samples, "metrics": aggregate(samples)}

    result: dict[str, object] = {
        "schemaVersion": RESULT_SCHEMA_VERSION,
        "suite": SUITE_NAME,
        "mode": "check" if args.check else "baseline",
        "createdAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "durationMs": round((time.time() - started) * 1_000, 3),
        "environment": environment(),
        "scenarios": scenario_results,
        "budget": {
            "enabled": args.baseline is not None and not args.check,
            "baseline": str(args.baseline) if args.baseline else None,
            "maxRegressionPercent": args.max_regression_percent,
        },
    }

    failures = (
        compare_baseline(result, args.baseline, args.max_regression_percent)
        if args.baseline is not None and not args.check
        else []
    )
    result["budget"]["failures"] = failures
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(result, ensure_ascii=False, indent=2))
    if failures:
        for failure in failures:
            print(f"PERF REGRESSION: {failure}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
