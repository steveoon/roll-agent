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
import traceback
import unicodedata
from dataclasses import dataclass, field
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
    "resize-cycle",
    "resize-storm",
    "stream-resize",
    "idle",
)
PROMPT = "›"
PRIMARY_SCREEN_SENTINEL = "PTY_PRIMARY_SCREEN_RESTORED"
RESIZE_SENTINELS = ("PTY_USER_4F21", "PTY_ASSIST_91C7", "PTY_DRAFT_7A52")
TERMINAL_QUERIES = (b"\x1b[?u", b"\x1b[6n", b"\x1b[c")

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
    "resize-cycle": ("stableAfterResizeMs",),
    "resize-storm": ("stableAfterLastResizeMs",),
    "stream-resize": ("totalMs", "stableAfterLastResizeMs"),
    "idle": ("invalidFrames", "outputBytes"),
}
OPTIONAL_BASELINE_METRICS = {"idle": ("cpuMs",)}


def format_exception(error: BaseException) -> str:
    return "".join(
        traceback.format_exception(type(error), error, error.__traceback__)
    ).rstrip()


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


@dataclass
class ScreenBuffer:
    grid: list[list[str]]
    x: int = 0
    y: int = 0
    saved: tuple[int, int] = (0, 0)
    soft_wrapped: list[bool] = field(default_factory=list)

    def __post_init__(self) -> None:
        if not self.soft_wrapped:
            self.soft_wrapped = [False] * len(self.grid)


class VirtualScreen:
    """Small VT screen covering the cursor/erase sequences emitted by Ink 7."""

    def __init__(self, columns: int, rows: int) -> None:
        self.columns = columns
        self.rows = rows
        self.buffers = {
            "primary": ScreenBuffer([[" "] * columns for _ in range(rows)]),
            "alternate": ScreenBuffer([[" "] * columns for _ in range(rows)]),
        }
        self.active_buffer = "primary"
        self.alternate_enter_count = 0
        self.alternate_leave_count = 0
        self.cursor_visible = True
        self.bracketed_paste = False
        self.kitty_keyboard = False
        self.synchronized_update = False
        self.mouse_modes: set[int] = set()
        self.state = "normal"
        self.sequence = ""
        self.decoder = codecs.getincrementaldecoder("utf-8")("replace")

    @property
    def buffer(self) -> ScreenBuffer:
        return self.buffers[self.active_buffer]

    @property
    def grid(self) -> list[list[str]]:
        return self.buffer.grid

    @grid.setter
    def grid(self, value: list[list[str]]) -> None:
        self.buffer.grid = value

    @property
    def x(self) -> int:
        return self.buffer.x

    @x.setter
    def x(self, value: int) -> None:
        self.buffer.x = value

    @property
    def y(self) -> int:
        return self.buffer.y

    @y.setter
    def y(self, value: int) -> None:
        self.buffer.y = value

    @property
    def saved(self) -> tuple[int, int]:
        return self.buffer.saved

    @saved.setter
    def saved(self, value: tuple[int, int]) -> None:
        self.buffer.saved = value

    def resize(self, columns: int, rows: int) -> None:
        old_columns = self.columns
        for buffer in self.buffers.values():
            logical_lines: list[list[str]] = []
            current_line: list[str] = []
            cursor_position = (0, 0)
            saved_position = (0, 0)
            last_content_row = max(
                (
                    row_index
                    for row_index, cells in enumerate(buffer.grid)
                    if any(cell not in ("", " ") for cell in cells)
                ),
                default=0,
            )
            last_relevant_row = max(last_content_row, buffer.y, buffer.saved[1])
            for row_index in range(min(last_relevant_row + 1, len(buffer.grid))):
                cells = buffer.grid[row_index]
                line_index = len(logical_lines)
                line_offset = len(current_line)
                if row_index == buffer.y:
                    cursor_position = (line_index, line_offset + buffer.x)
                if row_index == buffer.saved[1]:
                    saved_position = (line_index, line_offset + buffer.saved[0])
                if buffer.soft_wrapped[row_index]:
                    used = old_columns
                else:
                    used = max(
                        (
                            column_index + 1
                            for column_index, cell in enumerate(cells)
                            if cell not in ("", " ")
                        ),
                        default=0,
                    )
                current_line.extend(cells[:used])
                if not buffer.soft_wrapped[row_index]:
                    logical_lines.append(current_line)
                    current_line = []
            if current_line or not logical_lines:
                logical_lines.append(current_line)

            resized: list[list[str]] = []
            soft_wrapped: list[bool] = []
            logical_starts: list[int] = []
            for logical_line in logical_lines:
                logical_starts.append(len(resized))
                chunks = [
                    logical_line[offset : offset + columns]
                    for offset in range(0, len(logical_line), columns)
                ] or [[]]
                for chunk_index, chunk in enumerate(chunks):
                    resized.append([*chunk, *([" "] * (columns - len(chunk)))])
                    soft_wrapped.append(chunk_index < len(chunks) - 1)

            cursor_line, cursor_offset = cursor_position
            saved_line, saved_offset = saved_position
            cursor_y = logical_starts[min(cursor_line, len(logical_starts) - 1)] + (
                cursor_offset // columns
            )
            cursor_x = min(cursor_offset % columns, columns - 1)
            saved_y = logical_starts[min(saved_line, len(logical_starts) - 1)] + (
                saved_offset // columns
            )
            saved_x = min(saved_offset % columns, columns - 1)

            dropped_rows = max(0, len(resized) - rows)
            if dropped_rows:
                resized = resized[dropped_rows:]
                soft_wrapped = soft_wrapped[dropped_rows:]
            while len(resized) < rows:
                resized.append([" "] * columns)
                soft_wrapped.append(False)
            buffer.grid = resized
            buffer.soft_wrapped = soft_wrapped
            buffer.x = cursor_x
            buffer.y = min(max(0, cursor_y - dropped_rows), rows - 1)
            buffer.saved = (
                saved_x,
                min(max(0, saved_y - dropped_rows), rows - 1),
            )
        self.columns = columns
        self.rows = rows

    def render(self) -> str:
        return self.render_buffer(self.active_buffer)

    def render_buffer(self, name: str) -> str:
        lines = [
            "".join(cell for cell in row if cell != "").rstrip()
            for row in self.buffers[name].grid
        ]
        while lines and lines[-1] == "":
            lines.pop()
        return "\n".join(lines)

    def terminal_state(self) -> dict[str, object]:
        return {
            "activeBuffer": self.active_buffer,
            "alternateEnterCount": self.alternate_enter_count,
            "alternateLeaveCount": self.alternate_leave_count,
            "cursorVisible": self.cursor_visible,
            "bracketedPaste": self.bracketed_paste,
            "kittyKeyboard": self.kitty_keyboard,
            "synchronizedUpdate": self.synchronized_update,
            "mouseModes": sorted(self.mouse_modes),
            "primaryScreen": self.render_buffer("primary"),
            "alternateScreen": self.render_buffer("alternate"),
        }

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
                self._line_feed(soft_wrap=False)
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
            self._line_feed(soft_wrap=True)
        self.grid[self.y][self.x] = char
        if width == 2 and self.x + 1 < self.columns:
            self.grid[self.y][self.x + 1] = ""
        self.x += width

    def _line_feed(self, *, soft_wrap: bool) -> None:
        self.buffer.soft_wrapped[self.y] = soft_wrap
        self.y += 1
        if self.y >= self.rows:
            self.grid.pop(0)
            self.grid.append([" "] * self.columns)
            self.buffer.soft_wrapped.pop(0)
            self.buffer.soft_wrapped.append(False)
            self.y = self.rows - 1

    def _clear(self) -> None:
        self.grid = [[" "] * self.columns for _ in range(self.rows)]
        self.buffer.soft_wrapped = [False] * self.rows
        self.x = 0
        self.y = 0

    def _erase_line(self, mode: int) -> None:
        if mode == 2:
            self.grid[self.y] = [" "] * self.columns
            self.buffer.soft_wrapped[self.y] = False
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
    def _params(raw: str) -> tuple[list[int], str | None]:
        private = raw[0] if raw.startswith(("?", ">", "<", "=")) else None
        body = raw[1:] if private is not None else raw
        parts = body.split(";") if body else []
        parsed = [int(part) if part.isdigit() else 0 for part in parts]
        return parsed, private

    def _enter_alternate_screen(self) -> None:
        if self.active_buffer == "alternate":
            return
        self.buffers["alternate"] = ScreenBuffer(
            [[" "] * self.columns for _ in range(self.rows)]
        )
        self.active_buffer = "alternate"
        self.alternate_enter_count += 1

    def _leave_alternate_screen(self) -> None:
        if self.active_buffer != "alternate":
            return
        self.active_buffer = "primary"
        self.alternate_leave_count += 1

    def _apply_private_csi(self, final: str, params: list[int], private: str) -> None:
        if private == ">" and final == "u":
            self.kitty_keyboard = True
            return
        if private == "<" and final == "u":
            self.kitty_keyboard = False
            return
        if private != "?" or final not in ("h", "l"):
            return
        enabled = final == "h"
        for mode in params:
            if mode in (47, 1047, 1049):
                if enabled:
                    self._enter_alternate_screen()
                else:
                    self._leave_alternate_screen()
            elif mode == 25:
                self.cursor_visible = enabled
            elif mode in (1000, 1002, 1003, 1006):
                if enabled:
                    self.mouse_modes.add(mode)
                else:
                    self.mouse_modes.discard(mode)
            elif mode == 2004:
                self.bracketed_paste = enabled
            elif mode == 2026:
                self.synchronized_update = enabled

    def _apply_csi(self, sequence: str) -> None:
        final = sequence[-1]
        params, private = self._params(sequence[:-1])
        first = params[0] if params and params[0] > 0 else 1
        if private is not None:
            self._apply_private_csi(final, params, private)
            return
        if final == "m":
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
                self.buffer.soft_wrapped.pop(0)
                self.buffer.soft_wrapped.append(False)
        elif final == "T":
            for _ in range(first):
                self.grid.pop()
                self.grid.insert(0, [" "] * self.columns)
                self.buffer.soft_wrapped.pop()
                self.buffer.soft_wrapped.insert(0, False)


@dataclass(frozen=True)
class Frame:
    elapsed_ms: float
    screen: str


@dataclass(frozen=True)
class MarkerObservation:
    first_seen: tuple[int, ...]
    duplicates: tuple[int, ...]


class ScenarioFailure(RuntimeError):
    def __init__(
        self,
        scenario: str,
        fixture: "PtyFixture",
        final_screen: str,
        failure_reason: str,
    ) -> None:
        super().__init__(f"PTY scenario {scenario!r} failed")
        self.scenario = scenario
        self.fixture = fixture
        self.final_screen = final_screen
        self.failure_reason = failure_reason


class PtyFixture:
    def __init__(self, scenario: str, columns: int = 100, rows: int = 36) -> None:
        master, slave = os.openpty()
        self.master = master
        self.screen = VirtualScreen(columns, rows)
        self.screen.feed(PRIMARY_SCREEN_SENTINEL.encode("utf-8"))
        self.frames: list[Frame] = []
        self.raw_events: list[tuple[float, bytes]] = []
        self.started_ns = time.monotonic_ns()
        self.last_screen = ""
        self.closed = False
        self.scenario = scenario
        self._terminal_query_tail = b""
        self._temporary_directory: tempfile.TemporaryDirectory[str] | None = None
        self._set_winsize(slave, columns, rows)
        env = {
            **os.environ,
            "TERM": "xterm-256color",
            "COLORTERM": "truecolor",
            "FORCE_COLOR": "1",
            # Ink treats CI as non-interactive even when stdin/stdout are a real
            # PTY. Exercise the same interactive mode as a user terminal instead
            # of inheriting the parent runner's CI classification.
            "CI": "false",
            "CONTINUOUS_INTEGRATION": "false",
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
        combined = self._terminal_query_tail + chunk
        tail_length = len(self._terminal_query_tail)
        matches: list[tuple[int, bytes]] = []
        for query in TERMINAL_QUERIES:
            offset = 0
            while True:
                index = combined.find(query, offset)
                if index < 0:
                    break
                end_in_chunk = index + len(query) - tail_length
                if end_in_chunk > 0:
                    matches.append((end_in_chunk, query))
                offset = index + len(query)

        self._terminal_query_tail = b""
        for length in range(1, max(len(query) for query in TERMINAL_QUERIES)):
            suffix = combined[-length:]
            if any(
                len(suffix) < len(query) and query.startswith(suffix)
                for query in TERMINAL_QUERIES
            ):
                self._terminal_query_tail = suffix

        chunk_offset = 0
        for end_in_chunk, query in sorted(matches, key=lambda match: match[0]):
            self.screen.feed(chunk[chunk_offset:end_in_chunk])
            chunk_offset = end_in_chunk
            if query == b"\x1b[?u":
                response = b"\x1b[?0u"
            elif query == b"\x1b[6n":
                response = f"\x1b[{self.screen.y + 1};{self.screen.x + 1}R".encode()
            else:
                response = b"\x1b[?1;2c"
            try:
                os.write(self.master, response)
            except OSError:
                break
        self.screen.feed(chunk[chunk_offset:])

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
            # A real terminal answers each query after applying only the bytes that
            # precede it. PTY chunk boundaries do not preserve that ordering for us.
            self._respond_to_terminal_queries(chunk)
            rendered = self.screen.render()
            if self.screen.synchronized_update:
                # CSI ?2026 is a terminal-level frame transaction: capable terminals keep the
                # previous frame visible until the matching end marker. Do not turn PTY read
                # boundaries inside that transaction into user-observable intermediate frames.
                continue
            if rendered != self.last_screen:
                self.last_screen = rendered
                self.frames.append(Frame(elapsed, rendered))
                changed = True
        return changed

    def observable_screen(self) -> str:
        if self.screen.synchronized_update:
            return self.last_screen
        return self.screen.render()

    def wait_for(self, predicate: Callable[[str], bool], timeout: float, label: str) -> float:
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            if predicate(self.observable_screen()):
                return self.elapsed_ms()
            self.pump(min(0.05, max(0.0, deadline - time.monotonic())))
            if self.process.poll() is not None and not predicate(self.observable_screen()):
                raise AssertionError(
                    f"fixture exited before {label} (status={self.process.returncode})\n"
                    f"screen:\n{self.observable_screen()}"
                )
        raise AssertionError(f"timed out waiting for {label}\nscreen:\n{self.observable_screen()}")

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

    def assert_terminal_restored(self) -> None:
        state = self.screen.terminal_state()
        failures: list[str] = []
        if state["alternateEnterCount"] != 1:
            failures.append(
                "alternate screen enter count is not exactly one "
                f"(count={state['alternateEnterCount']})"
            )
        if state["activeBuffer"] != "primary":
            failures.append(f"active buffer is {state['activeBuffer']!r}, expected 'primary'")
        if state["alternateEnterCount"] != state["alternateLeaveCount"]:
            failures.append(
                "alternate screen enter/leave count differs "
                f"({state['alternateEnterCount']} != {state['alternateLeaveCount']})"
            )
        if not state["cursorVisible"]:
            failures.append("cursor remains hidden")
        if state["bracketedPaste"]:
            failures.append("bracketed paste remains enabled")
        if state["kittyKeyboard"]:
            failures.append("Kitty keyboard protocol remains enabled")
        if state["synchronizedUpdate"]:
            failures.append("synchronized update remains open")
        if state["mouseModes"]:
            failures.append(f"mouse modes remain enabled: {state['mouseModes']}")
        if b"\x1b[3J" in b"".join(chunk for _, chunk in self.raw_events):
            failures.append("terminal output cleared primary scrollback with CSI 3J")
        primary_screen = str(state["primaryScreen"])
        if primary_screen.count(PRIMARY_SCREEN_SENTINEL) != 1:
            failures.append(
                "primary screen sentinel was not restored exactly once "
                f"(count={primary_screen.count(PRIMARY_SCREEN_SENTINEL)})"
            )
        if failures:
            raise AssertionError("terminal cleanup failed: " + "; ".join(failures))

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


def assert_editor_cursor(screen: VirtualScreen, value: str) -> None:
    if not screen.cursor_visible:
        raise AssertionError("editor terminal cursor is hidden; IME preedit has no anchor")
    expected_text = f"{PROMPT} {value}"
    for row_index, cells in enumerate(screen.grid):
        rendered = "".join(cell for cell in cells if cell != "")
        if expected_text not in rendered:
            continue
        prompt_x = cells.index(PROMPT)
        expected_x = prompt_x + char_width(PROMPT) + 1 + sum(char_width(char) for char in value)
        if (screen.x, screen.y) != (expected_x, row_index):
            raise AssertionError(
                "editor terminal cursor is not at the insertion point "
                f"(actual={screen.x},{screen.y}; expected={expected_x},{row_index})"
            )
        return
    raise AssertionError(f"could not locate editor value for cursor assertion: {value!r}")


def has_unique_sentinels(screen: str, sentinels: Iterable[str]) -> bool:
    return all(screen.count(sentinel) == 1 for sentinel in sentinels)


def assert_unique_sentinels(label: str, screen: str, sentinels: Iterable[str]) -> None:
    invalid = {
        sentinel: screen.count(sentinel)
        for sentinel in sentinels
        if screen.count(sentinel) != 1
    }
    if invalid:
        raise AssertionError(f"{label} sentinel counts are not unique: {invalid}\n{screen}")


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
                15,
                "production CLI Ink prompt",
            )
            fixture.send("/")
            fixture.wait_for(
                lambda screen: re.search(r"›\s+/", screen) is not None
                and "↑↓ 选择 · Tab 补全" in screen,
                2,
                "production CLI Ink slash popup",
            )
            fixture.send("\x15")
            fixture.drain_for(0.04)
            fixture.wait_for(
                lambda screen: PROMPT in screen
                and re.search(r"›\s+/", screen) is None
                and "↑↓ 选择 · Tab 补全" not in screen,
                2,
                "production CLI Ink probe cleanup",
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
            assert_editor_cursor(fixture.screen, "")
        if scenario in ("resize-cycle", "resize-storm"):
            fixture.send("PTY_DRAFT_7A52")
            fixture.wait_for(
                lambda screen: has_unique_sentinels(
                    screen, (*RESIZE_SENTINELS, f"pty-fixture/{scenario}")
                ),
                2,
                "resize sentinels before first resize",
            )
            fixture.wait_quiet(quiet_ms=100)
        if scenario == "keypress":
            started = fixture.elapsed_ms()
            fixture.send("k")
            rendered = fixture.wait_for(
                lambda screen: re.search(r"›\s+k", screen) is not None,
                2,
                "keypress echo",
            )
            assert_prompt(fixture.screen.render())
            assert_editor_cursor(fixture.screen, "k")
            fixture.send("\x15")
            fixture.wait_for(
                lambda screen: re.search(r"›\s+k", screen) is None,
                2,
                "clear ASCII keypress before CJK input",
            )
            fixture.send("输入")
            fixture.wait_for(
                lambda screen: re.search(r"›\s+输入", screen) is not None,
                2,
                "committed CJK input",
            )
            assert_editor_cursor(fixture.screen, "输入")
            return {
                "keypressToRenderMs": rendered - started,
                "imeCursorReady": True,
                "committedCjkCursorAligned": True,
            }, fixture

        if scenario == "text-stream":
            started = fixture.elapsed_ms()
            first_frame_index = len(fixture.frames)
            fixture.send("stream\r")
            first_token = fixture.wait_for(
                lambda screen: "word000" in screen, 3, "first stream token"
            )
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

        if scenario == "resize-cycle":
            sizes = [(62, 20), (140, 42), (74, 24), (100, 36)]
            stable_latencies: list[float] = []
            for columns, rows in sizes:
                frames_before_resize = len(fixture.frames)
                resized_at = fixture.elapsed_ms()
                fixture.resize(columns, rows)
                stable = fixture.wait_for(
                    lambda screen: len(fixture.frames) > frames_before_resize
                    and has_unique_sentinels(
                        screen, (*RESIZE_SENTINELS, "pty-fixture/resize-cycle")
                    ),
                    3,
                    f"unique resize sentinels at {columns}x{rows}",
                )
                fixture.wait_quiet(quiet_ms=100)
                assert_unique_sentinels(
                    f"resize checkpoint {columns}x{rows}",
                    fixture.screen.render(),
                    (*RESIZE_SENTINELS, "pty-fixture/resize-cycle"),
                )
                assert_editor_cursor(fixture.screen, "PTY_DRAFT_7A52")
                stable_latencies.append(stable - resized_at)
            fixture.send("\x15")
            fixture.drain_for(0.04)
            fixture.send("/")
            fixture.resize(40, 10)
            fixture.wait_for(
                lambda screen: "/compact" in screen,
                3,
                "compact slash popup after resize",
            )
            fixture.wait_quiet(quiet_ms=100)
            compact_screen = fixture.screen.render()
            compact_lines = compact_screen.splitlines()
            compact_row = next(
                (
                    index
                    for index, line in enumerate(compact_lines)
                    if "/compact" in line
                ),
                -1,
            )
            if (
                compact_row <= 0
                or compact_row + 1 >= len(compact_lines)
                or not compact_lines[compact_row - 1].lstrip().startswith("╭")
                or not compact_lines[compact_row + 1].lstrip().startswith("╰")
            ):
                raise AssertionError(
                    "40x10 slash popup does not retain separate border/content rows\n"
                    + compact_screen
                )
            assert_prompt(compact_screen)
            assert_editor_cursor(fixture.screen, "/")
            return {
                "resizeCount": len(sizes) + 1,
                "stableAfterResizeMs": max(stable_latencies),
                "uniqueCheckpointCount": len(sizes),
                "compactPopupIntact": True,
                "imeCursorStable": True,
            }, fixture

        if scenario == "resize-storm":
            sizes = ([(62, 20), (140, 42), (78, 24), (120, 36)] * 6) + [(66, 22)]
            first_frame_index = len(fixture.frames)
            for columns, rows in sizes:
                fixture.resize(columns, rows)
                fixture.drain_for(0.004)
            frames_before_final_resize = len(fixture.frames)
            fixture.resize(104, 34)
            last_resize = fixture.elapsed_ms()
            stable = fixture.wait_for(
                lambda screen: len(fixture.frames) > frames_before_final_resize
                and has_unique_sentinels(
                    screen, (*RESIZE_SENTINELS, "pty-fixture/resize-storm")
                ),
                3,
                "settled redraw at the distinct final storm size",
            )
            fixture.wait_quiet(quiet_ms=150)
            final_screen = fixture.screen.render()
            assert_prompt(final_screen)
            assert_unique_sentinels(
                "resize storm final screen",
                final_screen,
                (*RESIZE_SENTINELS, "pty-fixture/resize-storm"),
            )
            assert_editor_cursor(fixture.screen, "PTY_DRAFT_7A52")
            return {
                "resizeCount": len(sizes) + 1,
                "stableAfterLastResizeMs": stable - last_resize,
                "redrawFrames": len(fixture.frames) - first_frame_index,
                "settledRedraw": True,
                "uniqueSentinels": True,
                "imeCursorStable": True,
            }, fixture

        if scenario == "stream-resize":
            assert_unique_sentinels(
                "stream resize initial history",
                fixture.screen.render(),
                ("PTY_USER_4F21", "PTY_ASSIST_91C7", "pty-fixture/stream-resize"),
            )
            started = fixture.elapsed_ms()
            first_frame_index = len(fixture.frames)
            fixture.send("stream\r")
            first_token = fixture.wait_for(
                lambda screen: "word000" in screen, 3, "first stream token"
            )
            sizes = [(64, 20), (132, 40), (76, 24), (116, 34)] * 5
            for columns, rows in sizes:
                fixture.resize(columns, rows)
                fixture.drain_for(0.025)
            frames_before_final_resize = len(fixture.frames)
            fixture.resize(100, 36)
            last_resize = fixture.elapsed_ms()
            stable = fixture.wait_for(
                lambda screen: len(fixture.frames) > frames_before_final_resize
                and PROMPT in screen
                and re.search(r"word\d{3}", screen) is not None,
                3,
                "stable stream frame after final resize",
            )
            completed = fixture.wait_for(
                lambda screen: screen.count("STREAM_COMPLETE_400") == 1,
                8,
                "resized 400-word completion",
            )
            fixture.wait_quiet(quiet_ms=150)
            relevant = fixture.frames[first_frame_index:]
            observed = observed_numeric_markers(relevant, re.compile(r"word(\d{3})"))
            assert_complete_sequence("resized text word", observed, 399)
            final_screen = fixture.screen.render()
            assert_prompt(final_screen)
            assert_unique_sentinels(
                "stream resize final screen",
                final_screen,
                ("STREAM_COMPLETE_400", "pty-fixture/stream-resize"),
            )
            assert_editor_cursor(fixture.screen, "")
            return {
                "firstTokenMs": first_token - started,
                "totalMs": completed - started,
                "stableAfterLastResizeMs": stable - last_resize,
                "resizeCount": len(sizes) + 1,
                "observableFrames": len(relevant),
                "observedWords": len(observed.first_seen) + 1,
                "wordOracleComplete": True,
                "uniqueSentinels": True,
                "imeCursorRestored": True,
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
    except Exception as error:
        final_screen = fixture.screen.render()
        failure_reason = format_exception(error)
        try:
            fixture.force_close()
        except Exception as cleanup_error:
            failure_reason += (
                "\n\nPTY cleanup also failed:\n"
                + format_exception(cleanup_error)
            )
        raise ScenarioFailure(
            scenario,
            fixture,
            final_screen,
            failure_reason,
        ) from error


def save_artifacts(
    artifact_dir: Path,
    scenario: str,
    sample: int,
    fixture: PtyFixture,
    final_screen: str,
    failure_reason: str | None = None,
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
    terminal_path = artifact_dir / f"{stem}.terminal.json"
    failure_path = artifact_dir / f"{stem}.failure.txt"
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
    terminal_path.write_text(
        json.dumps(fixture.screen.terminal_state(), ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    artifacts = {
        "ansi": display_path(ansi_path),
        "frames": display_path(frames_path),
        "screen": display_path(screen_path),
        "terminal": display_path(terminal_path),
    }
    if failure_reason is not None:
        failure_path.write_text(failure_reason.rstrip() + "\n", encoding="utf-8")
        artifacts["failure"] = display_path(failure_path)
    return artifacts


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

    def persist_failure(failure: ScenarioFailure, sample_index: int) -> int:
        artifacts = save_artifacts(
            artifact_dir,
            failure.scenario,
            sample_index,
            failure.fixture,
            failure.final_screen,
            failure.failure_reason,
        )
        print(
            f"PTY SCENARIO FAILED: {failure.scenario} sample {sample_index + 1}\n"
            f"{failure.failure_reason}\n"
            f"artifacts: {json.dumps(artifacts, ensure_ascii=False)}",
            file=sys.stderr,
        )
        return 1

    for scenario in selected:
        samples: list[dict[str, object]] = []
        for sample_index in range(args.samples):
            try:
                metrics, fixture = run_scenario(scenario)
            except ScenarioFailure as failure:
                return persist_failure(failure, sample_index)
            final_screen = fixture.screen.render()
            try:
                fixture.exit_cleanly()
                if scenario != "cli-bootstrap":
                    fixture.assert_terminal_restored()
            except Exception as error:
                failure_reason = format_exception(error)
                try:
                    fixture.force_close()
                except Exception as cleanup_error:
                    failure_reason += (
                        "\n\nPTY cleanup also failed:\n"
                        + format_exception(cleanup_error)
                    )
                return persist_failure(
                    ScenarioFailure(
                        scenario,
                        fixture,
                        final_screen,
                        failure_reason,
                    ),
                    sample_index,
                )
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
