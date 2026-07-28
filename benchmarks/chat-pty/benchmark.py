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


HARNESS_ROOT = Path(__file__).resolve().parents[2]
REPO_ROOT = Path(
    os.environ.get("ROLL_CHAT_BENCH_TARGET_ROOT", str(HARNESS_ROOT))
).resolve()
FIXTURE = HARNESS_ROOT / "benchmarks" / "chat-pty" / "fixture.ts"
AGENT_FIXTURE = HARNESS_ROOT / "benchmarks" / "chat-pty" / "agent-fixture.ts"
CLI_ENTRY = REPO_ROOT / "packages" / "core" / "src" / "cli" / "index.ts"
DEFAULT_OUTPUT = HARNESS_ROOT / "outputs" / "chat-pty" / "results.json"
RESULT_SCHEMA_VERSION = 3
SUITE_NAME = "roll-chat-real-pty"
CLI_SERVER_SCENARIOS = (
    "cli-bootstrap",
    "cli-server-1-agent-bootstrap",
    "cli-server-5-agent-bootstrap",
)
CLI_INK_SCENARIOS = ("cli-ink-cold-start", "cli-ink-5-agent-cold-start")
BOOTSTRAP_DELAYS: Mapping[str, tuple[int, ...]] = {
    "cli-server-1-agent-bootstrap": (400,),
    "cli-server-5-agent-bootstrap": (400, 300, 250, 150, 100),
    "cli-ink-5-agent-cold-start": (400, 300, 250, 150, 100),
}
SCENARIOS = (
    "cli-bootstrap",
    "cli-ink-cold-start",
    "cli-server-1-agent-bootstrap",
    "cli-server-5-agent-bootstrap",
    "cli-ink-5-agent-cold-start",
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
SENSITIVE_ENV_NAME = re.compile(
    r"(?:KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)", re.IGNORECASE
)

REQUIRED_BASELINE_METRICS: Mapping[str, tuple[str, ...]] = {
    "cli-bootstrap": ("cliBootstrapReadyMs",),
    "cli-ink-cold-start": ("cliInkFirstInteractiveMs",),
    "cli-server-1-agent-bootstrap": ("sessionCreateReadyMs",),
    "cli-server-5-agent-bootstrap": ("sessionCreateReadyMs",),
    "cli-ink-5-agent-cold-start": ("cliInkFiveAgentFirstInteractiveMs",),
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
BOOTSTRAP_COMPARISON_METRICS: Mapping[str, str] = {
    "cli-server-1-agent-bootstrap": "sessionCreateReadyMs",
    "cli-server-5-agent-bootstrap": "sessionCreateReadyMs",
    "cli-ink-5-agent-cold-start": "cliInkFiveAgentFirstInteractiveMs",
}
PAIRED_COMPARISON_METRICS: Mapping[str, str] = {
    "cli-bootstrap": "cliBootstrapReadyMs",
    "cli-ink-cold-start": "cliInkFirstInteractiveMs",
    **BOOTSTRAP_COMPARISON_METRICS,
}


def format_exception(error: BaseException) -> str:
    return "".join(
        traceback.format_exception(type(error), error, error.__traceback__)
    ).rstrip()


def sanitized_child_env(source: Mapping[str, str]) -> dict[str, str]:
    return {
        name: value
        for name, value in source.items()
        if SENSITIVE_ENV_NAME.search(name) is None and name != "NO_COLOR"
    }


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


def bootstrap_topology(scenario: str) -> tuple[dict[str, object], ...]:
    delays = BOOTSTRAP_DELAYS.get(scenario, ())
    return tuple(
        {
            "name": f"benchmark-agent-{index + 1}",
            "delayMs": delay_ms,
            "tool": "bootstrap_probe",
            "transport": "stdio",
            "runtimeOwnership": "on-demand",
        }
        for index, delay_ms in enumerate(delays)
    )


def canonical_hash(value: object) -> str:
    encoded = json.dumps(
        value, ensure_ascii=False, sort_keys=True, separators=(",", ":")
    ).encode()
    return hashlib.sha256(encoded).hexdigest()


def write_agent_registry(
    data_dir: Path, lifecycle_dir: Path, topology: tuple[dict[str, object], ...]
) -> None:
    data_dir.mkdir(parents=True, exist_ok=True)
    agents = []
    for entry in topology:
        name = str(entry["name"])
        delay_ms = int(entry["delayMs"])
        agents.append(
            {
                "skill": {
                    "name": name,
                    "description": f"Deterministic bootstrap benchmark Agent {name}",
                    "metadata": {},
                },
                "skillBody": f"# {name}\n\nSynthetic bootstrap benchmark fixture.",
                "transport": {
                    "type": "stdio",
                    "command": os.environ.get("NODE", "node"),
                    "args": [
                        "--disable-warning=ExperimentalWarning",
                        "--experimental-strip-types",
                        str(AGENT_FIXTURE),
                        "--name",
                        name,
                        "--delay-ms",
                        str(delay_ms),
                        "--lifecycle-dir",
                        str(lifecycle_dir),
                    ],
                },
                "runtime": {"ownership": "on-demand"},
                "installPath": str(AGENT_FIXTURE.parent),
                "registeredAt": "2026-01-01T00:00:00.000Z",
                "status": "idle",
                "source": {"type": "local-path", "path": str(AGENT_FIXTURE.parent)},
            }
        )
    (data_dir / "agents.json").write_text(
        json.dumps({"schemaVersion": 2, "agents": agents}, ensure_ascii=False, indent=2)
        + "\n",
        encoding="utf-8",
    )


class PtyFixture:
    def __init__(self, scenario: str, columns: int = 100, rows: int = 36) -> None:
        master, slave = os.openpty()
        self.master = master
        self.screen = VirtualScreen(columns, rows)
        self.screen.feed(PRIMARY_SCREEN_SENTINEL.encode("utf-8"))
        self.frames: list[Frame] = []
        self.raw_events: list[tuple[float, bytes]] = []
        self.started_ns = 0
        self.last_screen = ""
        self.closed = False
        self.scenario = scenario
        self._terminal_query_tail = b""
        self._rpc_line_buffer = b""
        self._rpc_responses: dict[int, list[dict[str, object]]] = {}
        self._rpc_protocol_error: str | None = None
        self._temporary_directory: tempfile.TemporaryDirectory[str] | None = None
        self._rpc_id = 0
        self.topology = bootstrap_topology(scenario)
        self.topology_hash = canonical_hash(self.topology)
        self.expected_agent_count = len(self.topology)
        self._agent_lifecycle_dir: Path | None = None
        self._final_lifecycle: tuple[dict[str, object], ...] = ()
        self.forced_cleanup = False
        self._set_winsize(slave, columns, rows)
        env = {
            **sanitized_child_env(os.environ),
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
        if scenario in (*CLI_SERVER_SCENARIOS, *CLI_INK_SCENARIOS):
            self._temporary_directory = tempfile.TemporaryDirectory(prefix="roll-chat-cli-")
            cwd = Path(self._temporary_directory.name)
            env["HOME"] = str(cwd)
            agents_dir = cwd / "agents"
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
                "agents": {"data-dir": str(agents_dir)},
                "runtime": {
                    "threads-dir": str(cwd / "threads"),
                    "thinking-level": "off",
                },
            }
            (cwd / "roll.config.yaml").write_text(
                json.dumps(config, ensure_ascii=False), encoding="utf-8"
            )
            if self.topology:
                self._agent_lifecycle_dir = cwd / "agent-lifecycle"
                write_agent_registry(agents_dir, self._agent_lifecycle_dir, self.topology)
            command = [
                os.environ.get("NODE", "node"),
                "--disable-warning=ExperimentalWarning",
                "--experimental-strip-types",
                str(CLI_ENTRY),
                "chat",
            ]
            if scenario in CLI_SERVER_SCENARIOS:
                command.append("--server")
        self.started_ns = time.monotonic_ns()
        self.process = subprocess.Popen(
            command,
            cwd=cwd,
            env=env,
            stdin=subprocess.PIPE if scenario in CLI_SERVER_SCENARIOS else slave,
            stdout=slave,
            stderr=slave,
            close_fds=True,
            start_new_session=True,
        )
        self._server_stdin = (
            self.process.stdin if scenario in CLI_SERVER_SCENARIOS else None
        )
        os.close(slave)
        os.set_blocking(master, False)

    @staticmethod
    def _set_winsize(fd: int, columns: int, rows: int) -> None:
        fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, columns, 0, 0))

    def elapsed_ms(self) -> float:
        return (time.monotonic_ns() - self.started_ns) / 1_000_000

    def send(self, text: str) -> None:
        encoded = text.encode("utf-8")
        if self._server_stdin is not None:
            self._server_stdin.write(encoded)
            self._server_stdin.flush()
            return
        os.write(self.master, encoded)

    def _record_rpc_line(self, line: bytes) -> None:
        trimmed = line.rstrip(b"\r").strip()
        if not trimmed.startswith(b"{"):
            return
        try:
            value: object = json.loads(trimmed.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            if b'"jsonrpc"' in trimmed:
                self._rpc_protocol_error = "malformed JSON-RPC output line"
            return
        message = object_mapping(value)
        if message is None or message.get("jsonrpc") != "2.0":
            return
        request_id = message.get("id")
        if (
            isinstance(request_id, bool)
            or not isinstance(request_id, int)
            or ("result" not in message and "error" not in message)
        ):
            return
        responses = self._rpc_responses.setdefault(request_id, [])
        responses.append(dict(message))
        if len(responses) > 1:
            self._rpc_protocol_error = (
                f"duplicate JSON-RPC responses for id {request_id}"
            )

    def _feed_rpc_output(self, chunk: bytes) -> None:
        combined = self._rpc_line_buffer + chunk
        lines = combined.split(b"\n")
        self._rpc_line_buffer = lines.pop()
        for line in lines:
            self._record_rpc_line(line)

    def rpc_request(
        self, method: str, params: Mapping[str, object], timeout: float = 15
    ) -> tuple[dict[str, object], float]:
        self._rpc_id += 1
        request_id = self._rpc_id
        started_ms = self.elapsed_ms()
        self.send(
            json.dumps(
                {
                    "jsonrpc": "2.0",
                    "id": request_id,
                    "method": method,
                    "params": dict(params),
                },
                ensure_ascii=False,
                separators=(",", ":"),
            )
            + "\n"
        )
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            if self._rpc_protocol_error is not None:
                raise AssertionError(self._rpc_protocol_error)
            responses = self._rpc_responses.get(request_id, [])
            if len(responses) == 1:
                response = responses[0]
                if "error" in response:
                    raise AssertionError(
                        f"JSON-RPC {method} failed: {json.dumps(response['error'], ensure_ascii=False)}"
                    )
                return response, self.elapsed_ms() - started_ms
            self.pump(min(0.05, max(0.0, deadline - time.monotonic())))
            if self.process.poll() is not None:
                raise AssertionError(
                    f"fixture exited before JSON-RPC {method} response "
                    f"(status={self.process.returncode})"
                )
        raise AssertionError(f"timed out waiting for JSON-RPC {method} response")

    def agent_lifecycle(self) -> tuple[dict[str, object], ...]:
        if self._agent_lifecycle_dir is None or not self._agent_lifecycle_dir.exists():
            return ()
        records: list[dict[str, object]] = []
        for path in sorted(self._agent_lifecycle_dir.glob("*.json")):
            try:
                value: object = json.loads(path.read_text(encoding="utf-8"))
            except (OSError, json.JSONDecodeError) as error:
                raise AssertionError(
                    f"invalid Agent fixture lifecycle file: {path}: {error}"
                ) from error
            record = object_mapping(value)
            if record is None:
                raise AssertionError(f"Agent fixture lifecycle must be an object: {path}")
            records.append(dict(record))
        return tuple(records)

    @staticmethod
    def _pid_is_alive(pid: int) -> bool:
        try:
            os.kill(pid, 0)
        except ProcessLookupError:
            return False
        except PermissionError:
            return True
        return True

    def validate_agent_lifecycle(self, require_exited: bool) -> int:
        records = self.agent_lifecycle()
        if len(records) != self.expected_agent_count:
            raise AssertionError(
                "Agent fixture lifecycle count differs "
                f"(actual={len(records)}, expected={self.expected_agent_count})"
            )
        intervals: list[tuple[int, int]] = []
        pids: list[int] = []
        expected_events = ["started", "list-start", "list-end"]
        if require_exited:
            expected_events.append("exited")
        for record, topology in zip(records, self.topology):
            if (
                record.get("name") != topology["name"]
                or record.get("delayMs") != topology["delayMs"]
                or record.get("toolCount") != 1
            ):
                raise AssertionError(
                    f"Agent lifecycle metadata differs: {json.dumps(record, ensure_ascii=False)}"
                )
            pid = record.get("pid")
            raw_events = record.get("events")
            if isinstance(pid, bool) or not isinstance(pid, int) or not isinstance(
                raw_events, list
            ):
                raise AssertionError("Agent lifecycle is missing pid or events")
            event_names: list[object] = []
            timestamps: list[int] = []
            for raw_event in raw_events:
                event = object_mapping(raw_event)
                if event is None:
                    raise AssertionError("Agent lifecycle event must be an object")
                event_names.append(event.get("event"))
                timestamp = event.get("monotonicNs")
                if not isinstance(timestamp, str) or not timestamp.isdigit():
                    raise AssertionError("Agent lifecycle timestamp must be a numeric string")
                timestamps.append(int(timestamp))
            if event_names != expected_events:
                raise AssertionError(
                    f"Agent lifecycle sequence differs for {record.get('name')}: "
                    f"{event_names} != {expected_events}"
                )
            if timestamps != sorted(timestamps):
                raise AssertionError("Agent lifecycle timestamps are not monotonic")
            intervals.append((timestamps[1], timestamps[2]))
            pids.append(pid)
        if require_exited:
            alive = [pid for pid in pids if self._pid_is_alive(pid)]
            if alive:
                raise AssertionError(
                    f"orphan Agent fixture processes remain after clean EOF: {alive}"
                )
        else:
            not_alive = [pid for pid in pids if not self._pid_is_alive(pid)]
            if not_alive:
                raise AssertionError(
                    f"Agent fixture exited before session readiness: {not_alive}"
                )
        points = sorted(
            [
                point
                for started, ended in intervals
                for point in ((started, 1), (ended, -1))
            ],
            key=lambda point: (point[0], point[1]),
        )
        active = 0
        peak = 0
        for _, delta in points:
            active += delta
            peak = max(peak, active)
        return peak

    def assert_agent_processes_stopped(self, timeout: float = 2) -> None:
        initial = self.agent_lifecycle()
        pids = [
            int(record["pid"])
            for record in initial
            if isinstance(record.get("pid"), int)
            and not isinstance(record.get("pid"), bool)
        ]
        deadline = time.monotonic() + timeout
        alive = [pid for pid in pids if self._pid_is_alive(pid)]
        while alive and time.monotonic() < deadline:
            time.sleep(0.02)
            alive = [pid for pid in alive if self._pid_is_alive(pid)]
        if alive:
            raise AssertionError(f"orphan Agent fixture processes remain after cleanup: {alive}")
        self._final_lifecycle = self.agent_lifecycle()
        self.validate_agent_lifecycle(require_exited=True)

    def cleanup_metrics(self) -> dict[str, object]:
        return {
            "cleanExit": self.process.returncode == 0,
            "forcedCleanup": self.forced_cleanup,
            "orphanAgentProcesses": 0,
            "agentExitCount": len(self._final_lifecycle),
        }

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
            if getattr(self, "scenario", "") in CLI_SERVER_SCENARIOS:
                self._feed_rpc_output(chunk)
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

    def _wait_for_process_exit(self, timeout: float) -> bool:
        deadline = time.monotonic() + timeout
        while self.process.poll() is None and time.monotonic() < deadline:
            self.pump(min(0.03, max(0.0, deadline - time.monotonic())))
        return self.process.poll() is not None

    def _force_process_cleanup(self) -> None:
        self.forced_cleanup = True
        try:
            os.killpg(self.process.pid, signal.SIGTERM)
        except ProcessLookupError:
            pass
        if not self._wait_for_process_exit(1):
            try:
                os.killpg(self.process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            self.process.wait(timeout=1)

    def exit_cleanly(self) -> None:
        if self.process.poll() is None and self.scenario in CLI_SERVER_SCENARIOS:
            if self._server_stdin is None:
                raise AssertionError("runtime-server stdin pipe is unavailable for clean EOF")
            self._server_stdin.close()
            self._server_stdin = None
            if not self._wait_for_process_exit(5):
                self._force_process_cleanup()
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
                self._force_process_cleanup()
        try:
            self.drain_for(0.05)
            if self.expected_agent_count > 0:
                self.assert_agent_processes_stopped()
            if not self.closed:
                os.close(self.master)
                self.closed = True
            if self.process.returncode != 0:
                raise AssertionError(f"fixture exited with status {self.process.returncode}")
            if self.forced_cleanup:
                raise AssertionError(
                    "fixture required TERM/KILL fallback instead of protocol-driven cleanup"
                )
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
                self._force_process_cleanup()
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


def expected_agent_catalog(
    topology: tuple[dict[str, object], ...],
) -> tuple[dict[str, object], ...]:
    return tuple(
        {
            "id": f"{entry['name']}__{entry['tool']}",
            "agentName": entry["name"],
            "toolName": entry["tool"],
            "source": "local-path",
            "transport": entry["transport"],
            "runtimeOwnership": entry["runtimeOwnership"],
        }
        for entry in topology
    )


def assert_no_bootstrap_issues(fixture: PtyFixture) -> None:
    output = b"".join(chunk for _, chunk in fixture.raw_events).decode("utf-8", "replace")
    if re.search(r'Agent\s+"[^"]+"\s+启动失败', output) is not None:
        raise AssertionError(f"Agent bootstrap issue was reported\n{output}")


def validate_capabilities(
    response: Mapping[str, object], topology: tuple[dict[str, object], ...]
) -> str:
    result = object_mapping(response.get("result"))
    manifest = object_mapping(result.get("manifest")) if result is not None else None
    if result is None:
        raise AssertionError("session.capabilities result must be an object")
    if manifest is None:
        raise AssertionError("session.capabilities response is missing manifest")
    turn_context_value = result.get("turnContext")
    if turn_context_value is not None and object_mapping(turn_context_value) is None:
        raise AssertionError(
            "session.capabilities turnContext must be an object when present"
        )
    turn_context = object_mapping(turn_context_value)
    if manifest.get("agentCount") != len(topology):
        raise AssertionError(
            "session.capabilities Agent count differs "
            f"(actual={manifest.get('agentCount')!r}, expected={len(topology)})"
        )
    raw_tools = manifest.get("tools")
    if not isinstance(raw_tools, list):
        raise AssertionError("session.capabilities manifest.tools must be an array")
    expected = expected_agent_catalog(topology)
    agent_capabilities: list[dict[str, object]] = []
    for value in raw_tools:
        tool = object_mapping(value)
        if tool is None:
            raise AssertionError(
                "session.capabilities manifest.tools entries must be objects"
            )
        if tool.get("source") == "built-in":
            continue
        agent_capabilities.append(dict(tool))
    actual_identities = [
        {
            key: tool.get(key)
            for key in (
                "id",
                "agentName",
                "toolName",
                "source",
                "transport",
                "runtimeOwnership",
            )
        }
        for tool in agent_capabilities
    ]
    if actual_identities != list(expected):
        raise AssertionError(
            "session.capabilities Agent Tool catalog differs "
            f"(actual={json.dumps(actual_identities, ensure_ascii=False)}, "
            f"expected={json.dumps(expected, ensure_ascii=False)})"
        )
    if turn_context is not None:
        effective_tool_ids = turn_context.get("effectiveToolIds")
        if not isinstance(effective_tool_ids, list) or not all(
            entry["id"] in effective_tool_ids for entry in expected
        ):
            raise AssertionError(
                "session.capabilities turnContext is missing expected Agent Tool ids"
            )
    return canonical_hash(
        {
            "agentCount": len(topology),
            "tools": agent_capabilities,
        }
    )


def run_scenario(scenario: str) -> tuple[dict[str, object], PtyFixture]:
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

        if scenario in (
            "cli-server-1-agent-bootstrap",
            "cli-server-5-agent-bootstrap",
        ):
            fixture.wait_for(
                lambda screen: "roll runtime-server 已启动" in screen,
                8,
                "production CLI runtime-server readiness",
            )
            create_response, create_ms = fixture.rpc_request(
                "session.create", {"title": "PTY bootstrap benchmark"}, timeout=20
            )
            create_result = object_mapping(create_response.get("result"))
            session_id = (
                create_result.get("sessionId") if create_result is not None else None
            )
            if not isinstance(session_id, str) or not session_id:
                raise AssertionError("session.create response is missing sessionId")
            capabilities, _ = fixture.rpc_request(
                "session.capabilities", {"sessionId": session_id}, timeout=5
            )
            catalog_hash = validate_capabilities(capabilities, fixture.topology)
            peak_active = fixture.validate_agent_lifecycle(require_exited=False)
            assert_no_bootstrap_issues(fixture)
            fixture.rpc_request("session.close", {"sessionId": session_id}, timeout=5)
            return {
                "sessionCreateReadyMs": create_ms,
                "agentCount": fixture.expected_agent_count,
                "toolCount": fixture.expected_agent_count,
                "sessionCapabilitiesAvailable": True,
                "bootstrapIssues": 0,
                "peakActive": peak_active,
                "lifecycleValidated": True,
                "topologyHash": fixture.topology_hash,
                "catalogHash": catalog_hash,
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

        if scenario == "cli-ink-5-agent-cold-start":
            ready_ms = fixture.wait_for(
                lambda screen: PROMPT in screen and "5 agents" in screen,
                20,
                "production CLI Ink prompt with five-Agent banner",
            )
            peak_active = fixture.validate_agent_lifecycle(require_exited=False)
            assert_no_bootstrap_issues(fixture)
            final_screen = fixture.screen.render()
            assert_prompt(final_screen)
            if final_screen.count("5 agents") != 1:
                raise AssertionError(
                    "production CLI Ink banner does not contain exactly one five-Agent marker"
                )
            return {
                "cliInkFiveAgentFirstInteractiveMs": ready_ms,
                "agentCount": fixture.expected_agent_count,
                "toolCount": fixture.expected_agent_count,
                "agentBannerReady": True,
                "bootstrapIssues": 0,
                "peakActive": peak_active,
                "lifecycleValidated": True,
                "topologyHash": fixture.topology_hash,
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


def stable_sample_string(samples: list[dict[str, object]], key: str) -> str | None:
    values = [sample.get(key) for sample in samples]
    present = [value for value in values if value is not None]
    if not present:
        return None
    if len(present) != len(values) or not all(isinstance(value, str) for value in present):
        raise AssertionError(f"sample invariant {key} must be a string in every sample")
    unique = set(present)
    if len(unique) != 1:
        raise AssertionError(f"sample invariant {key} is unstable: {sorted(unique)}")
    return str(present[0])


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


def metric_stat(
    scenario: Mapping[str, object], metric: str, statistic: str
) -> float | None:
    metrics = object_mapping(scenario.get("metrics"))
    metric_stats = (
        object_mapping(metrics.get(metric)) if metrics is not None else None
    )
    value = metric_stats.get(statistic) if metric_stats is not None else None
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    return float(value)


def comparison_delta(baseline: float, candidate: float) -> dict[str, float]:
    percent = (
        ((candidate - baseline) / baseline) * 100
        if baseline != 0
        else (0.0 if candidate == 0 else math.inf)
    )
    return {
        "baselineMs": round(baseline, 3),
        "candidateMs": round(candidate, 3),
        "absoluteDeltaMs": round(candidate - baseline, 3),
        "percentDelta": round(percent, 3),
    }


def compare_bootstrap_results(
    current: Mapping[str, object], baseline: Mapping[str, object]
) -> tuple[dict[str, object], list[str]]:
    current_scenarios = object_mapping(current.get("scenarios"))
    baseline_scenarios = object_mapping(baseline.get("scenarios"))
    if current_scenarios is None or baseline_scenarios is None:
        return {}, ["bootstrap comparison requires scenario objects in both results"]

    comparisons: dict[str, object] = {}
    failures: list[str] = []
    for scenario, metric in PAIRED_COMPARISON_METRICS.items():
        current_value = current_scenarios.get(scenario)
        if current_value is None:
            continue
        current_scenario = object_mapping(current_value)
        baseline_scenario = object_mapping(baseline_scenarios.get(scenario))
        if current_scenario is None:
            failures.append(f"bootstrap comparison current scenario is invalid: {scenario}")
            continue
        if baseline_scenario is None:
            failures.append(f"bootstrap comparison baseline missing scenario: {scenario}")
            continue

        topology_required = scenario in BOOTSTRAP_COMPARISON_METRICS
        current_topology = current_scenario.get("topologyHash")
        baseline_topology = baseline_scenario.get("topologyHash")
        if topology_required:
            if (
                not isinstance(current_topology, str)
                or not isinstance(baseline_topology, str)
                or current_topology != baseline_topology
            ):
                failures.append(
                    f"bootstrap comparison topologyHash mismatch: {scenario} "
                    f"({current_topology!r} != {baseline_topology!r})"
                )
                continue
        elif current_topology is not None or baseline_topology is not None:
            failures.append(
                f"bootstrap comparison unexpected topologyHash for zero-Agent scenario: {scenario}"
            )
            continue

        current_catalog = current_scenario.get("catalogHash")
        baseline_catalog = baseline_scenario.get("catalogHash")
        catalog_required = scenario in (
            "cli-server-1-agent-bootstrap",
            "cli-server-5-agent-bootstrap",
        )
        if catalog_required and (
            not isinstance(current_catalog, str)
            or not isinstance(baseline_catalog, str)
            or current_catalog != baseline_catalog
        ):
            failures.append(
                f"bootstrap comparison catalogHash mismatch: {scenario} "
                f"({current_catalog!r} != {baseline_catalog!r})"
            )
            continue
        if not catalog_required and (
            current_catalog is not None or baseline_catalog is not None
        ):
            failures.append(
                f"bootstrap comparison unexpected catalogHash for Ink scenario: {scenario}"
            )
            continue

        current_median = metric_stat(current_scenario, metric, "median")
        baseline_median = metric_stat(baseline_scenario, metric, "median")
        current_p95 = metric_stat(current_scenario, metric, "p95")
        baseline_p95 = metric_stat(baseline_scenario, metric, "p95")
        if None in (current_median, baseline_median, current_p95, baseline_p95):
            failures.append(
                f"bootstrap comparison metric is missing or non-numeric: {scenario}.{metric}"
            )
            continue

        current_samples = current_scenario.get("samples")
        baseline_samples = baseline_scenario.get("samples")
        if not isinstance(current_samples, list) or not isinstance(baseline_samples, list):
            failures.append(f"bootstrap comparison samples are missing: {scenario}")
            continue
        if len(current_samples) == 0 or len(current_samples) != len(baseline_samples):
            failures.append(
                f"bootstrap comparison sample count mismatch: {scenario} "
                f"({len(current_samples)} != {len(baseline_samples)})"
            )
            continue
        pairs: list[tuple[float, float]] = []
        invalid_pair = False
        for index, (current_sample, baseline_sample) in enumerate(
            zip(current_samples, baseline_samples)
        ):
            current_mapping = object_mapping(current_sample)
            baseline_mapping = object_mapping(baseline_sample)
            current_metric = (
                current_mapping.get(metric) if current_mapping is not None else None
            )
            baseline_metric = (
                baseline_mapping.get(metric) if baseline_mapping is not None else None
            )
            if (
                isinstance(current_metric, bool)
                or not isinstance(current_metric, (int, float))
                or isinstance(baseline_metric, bool)
                or not isinstance(baseline_metric, (int, float))
            ):
                failures.append(
                    f"bootstrap comparison sample metric is invalid: "
                    f"{scenario}.samples[{index}].{metric}"
                )
                invalid_pair = True
                break
            pairs.append((float(baseline_metric), float(current_metric)))
        if invalid_pair:
            continue

        comparisons[scenario] = {
            "metric": metric,
            **({"topologyHash": current_topology} if topology_required else {}),
            **({"catalogHash": current_catalog} if catalog_required else {}),
            "pairCount": len(pairs),
            "fasterPairCount": sum(
                1 for baseline_sample, current_sample in pairs if current_sample < baseline_sample
            ),
            "median": comparison_delta(baseline_median, current_median),
            "p95": comparison_delta(baseline_p95, current_p95),
        }
    return comparisons, failures


def evaluate_go_no_go(
    comparisons: Mapping[str, object],
    candidate: Mapping[str, object],
    candidate_concurrency: int,
) -> dict[str, object]:
    checks: list[dict[str, object]] = []

    def add(name: str, passed: bool, actual: object, required: str) -> None:
        checks.append(
            {
                "name": name,
                "passed": passed,
                "actual": actual,
                "required": required,
            }
        )

    def comparison(scenario: str) -> Mapping[str, object] | None:
        return object_mapping(comparisons.get(scenario))

    for scenario, minimum_percent, minimum_ms in (
        ("cli-server-5-agent-bootstrap", 20.0, 200.0),
        ("cli-ink-5-agent-cold-start", 15.0, 150.0),
    ):
        value = comparison(scenario)
        median = object_mapping(value.get("median")) if value is not None else None
        p95 = object_mapping(value.get("p95")) if value is not None else None
        median_delta = median.get("absoluteDeltaMs") if median is not None else None
        median_percent = median.get("percentDelta") if median is not None else None
        p95_delta = p95.get("absoluteDeltaMs") if p95 is not None else None
        faster = value.get("fasterPairCount") if value is not None else None
        pair_count = value.get("pairCount") if value is not None else None
        add(
            f"{scenario}.median-improvement",
            isinstance(median_delta, (int, float))
            and not isinstance(median_delta, bool)
            and isinstance(median_percent, (int, float))
            and not isinstance(median_percent, bool)
            and median_delta <= -minimum_ms
            and median_percent <= -minimum_percent,
            {
                "absoluteMs": median_delta,
                "percent": median_percent,
            },
            f">= {minimum_ms:.0f}ms and >= {minimum_percent:.0f}%",
        )
        add(
            f"{scenario}.paired-stability",
            pair_count == 30
            and isinstance(faster, int)
            and not isinstance(faster, bool)
            and faster >= 24,
            {"fasterPairCount": faster, "pairCount": pair_count},
            ">= 24/30 candidate-faster pairs",
        )
        add(
            f"{scenario}.p95",
            isinstance(p95_delta, (int, float))
            and not isinstance(p95_delta, bool)
            and p95_delta <= 0,
            p95_delta,
            "no regression",
        )

    for scenario in (
        "cli-bootstrap",
        "cli-ink-cold-start",
        "cli-server-1-agent-bootstrap",
    ):
        value = comparison(scenario)
        median = object_mapping(value.get("median")) if value is not None else None
        baseline_ms = median.get("baselineMs") if median is not None else None
        delta_ms = median.get("absoluteDeltaMs") if median is not None else None
        allowed = (
            max(float(baseline_ms) * 0.05, 20.0)
            if isinstance(baseline_ms, (int, float))
            and not isinstance(baseline_ms, bool)
            else None
        )
        add(
            f"{scenario}.median-regression",
            allowed is not None
            and isinstance(delta_ms, (int, float))
            and not isinstance(delta_ms, bool)
            and delta_ms <= allowed,
            {"absoluteDeltaMs": delta_ms, "allowedMs": allowed},
            "<= max(5%, 20ms)",
        )

    one_agent = comparison("cli-server-1-agent-bootstrap")
    one_p95 = object_mapping(one_agent.get("p95")) if one_agent is not None else None
    one_p95_percent = one_p95.get("percentDelta") if one_p95 is not None else None
    add(
        "cli-server-1-agent-bootstrap.p95-regression",
        isinstance(one_p95_percent, (int, float))
        and not isinstance(one_p95_percent, bool)
        and one_p95_percent <= 10,
        one_p95_percent,
        "<= 10%",
    )

    candidate_scenarios = object_mapping(candidate.get("scenarios"))
    for scenario in (
        "cli-server-5-agent-bootstrap",
        "cli-ink-5-agent-cold-start",
    ):
        scenario_value = (
            object_mapping(candidate_scenarios.get(scenario))
            if candidate_scenarios is not None
            else None
        )
        minimum_peak = (
            metric_stat(scenario_value, "peakActive", "min")
            if scenario_value is not None
            else None
        )
        maximum_peak = (
            metric_stat(scenario_value, "peakActive", "max")
            if scenario_value is not None
            else None
        )
        add(
            f"{scenario}.peak-active",
            minimum_peak is not None
            and maximum_peak is not None
            and 1 < minimum_peak
            and maximum_peak <= candidate_concurrency,
            {"min": minimum_peak, "max": maximum_peak},
            f"every sample has 1 < peakActive <= {candidate_concurrency}",
        )

    return {
        "passed": all(bool(check["passed"]) for check in checks),
        "candidateConcurrency": candidate_concurrency,
        "checks": checks,
    }


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


def build_scenario_result(samples: list[dict[str, object]]) -> dict[str, object]:
    scenario_result: dict[str, object] = {
        "samples": samples,
        "metrics": aggregate(samples),
    }
    for invariant in ("topologyHash", "catalogHash"):
        value = stable_sample_string(samples, invariant)
        if value is not None:
            scenario_result[invariant] = value
    return scenario_result


def run_paired_member_sample(
    target_root: Path,
    scenario: str,
    output_path: Path,
) -> tuple[dict[str, object], Mapping[str, object]]:
    env = {
        **sanitized_child_env(os.environ),
        "ROLL_CHAT_BENCH_TARGET_ROOT": str(target_root),
    }
    completed = subprocess.run(
        [
            sys.executable,
            str(Path(__file__).resolve()),
            "--samples",
            "1",
            "--check",
            "--scenario",
            scenario,
            "--output",
            str(output_path),
        ],
        cwd=HARNESS_ROOT,
        env=env,
        text=True,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.PIPE,
        timeout=45,
    )
    if completed.returncode != 0:
        raise RuntimeError(
            f"paired benchmark member failed for {target_root} / {scenario}:\n"
            f"{completed.stderr.rstrip()}"
        )
    value: object = json.loads(output_path.read_text(encoding="utf-8"))
    result = object_mapping(value)
    scenarios = object_mapping(result.get("scenarios")) if result is not None else None
    scenario_result = (
        object_mapping(scenarios.get(scenario)) if scenarios is not None else None
    )
    samples = scenario_result.get("samples") if scenario_result is not None else None
    if not isinstance(samples, list) or len(samples) != 1:
        raise RuntimeError(
            f"paired benchmark member returned invalid samples for {scenario}"
        )
    sample = object_mapping(samples[0])
    member_environment = (
        object_mapping(result.get("environment")) if result is not None else None
    )
    if sample is None or member_environment is None:
        raise RuntimeError(
            f"paired benchmark member returned invalid result for {scenario}"
        )
    return (
        {key: entry for key, entry in sample.items() if key != "artifacts"},
        member_environment,
    )


def run_paired_benchmark(args: argparse.Namespace) -> int:
    baseline_root = args.paired_baseline_root.resolve()
    candidate_root = args.paired_candidate_root.resolve()
    for label, target_root in (
        ("baseline", baseline_root),
        ("candidate", candidate_root),
    ):
        entry = target_root / "packages" / "core" / "src" / "cli" / "index.ts"
        if not entry.is_file():
            print(
                f"paired {label} root does not contain the Roll CLI entrypoint: {entry}",
                file=sys.stderr,
            )
            return 2
    selected = tuple(args.scenarios or PAIRED_COMPARISON_METRICS)
    unsupported = [
        scenario
        for scenario in selected
        if scenario not in PAIRED_COMPARISON_METRICS
    ]
    if unsupported:
        print(
            "paired mode only supports CLI startup and Agent bootstrap scenarios: "
            + ", ".join(unsupported),
            file=sys.stderr,
        )
        return 2

    baseline_samples: dict[str, list[dict[str, object]]] = {
        scenario: [] for scenario in selected
    }
    candidate_samples: dict[str, list[dict[str, object]]] = {
        scenario: [] for scenario in selected
    }
    baseline_environment: Mapping[str, object] | None = None
    candidate_environment: Mapping[str, object] | None = None
    started = time.time()
    try:
        with tempfile.TemporaryDirectory(prefix="roll-chat-paired-") as temporary:
            temporary_root = Path(temporary)
            invocation = 0

            def invoke(
                label: str, root: Path, scenario: str
            ) -> tuple[dict[str, object], Mapping[str, object]]:
                nonlocal invocation
                invocation += 1
                output = (
                    temporary_root
                    / f"{invocation:04d}-{label}-{scenario}"
                    / "result.json"
                )
                output.parent.mkdir(parents=True)
                return run_paired_member_sample(root, scenario, output)

            for scenario in selected:
                for _ in range(args.paired_warmups):
                    invoke("baseline-warmup", baseline_root, scenario)
                    invoke("candidate-warmup", candidate_root, scenario)
                for _ in range(args.paired_rounds):
                    for label, root, destination in (
                        ("baseline", baseline_root, baseline_samples),
                        ("candidate", candidate_root, candidate_samples),
                        ("candidate", candidate_root, candidate_samples),
                        ("baseline", baseline_root, baseline_samples),
                    ):
                        sample, member_environment = invoke(label, root, scenario)
                        destination[scenario].append(sample)
                        if label == "baseline":
                            baseline_environment = member_environment
                        else:
                            candidate_environment = member_environment
    except (OSError, subprocess.SubprocessError, RuntimeError, json.JSONDecodeError) as error:
        print(f"PAIRED BENCHMARK FAILED: {error}", file=sys.stderr)
        return 1

    baseline_result: dict[str, object] = {
        "schemaVersion": RESULT_SCHEMA_VERSION,
        "suite": SUITE_NAME,
        "mode": "paired-baseline",
        "environment": dict(baseline_environment or {}),
        "scenarios": {
            scenario: build_scenario_result(samples)
            for scenario, samples in baseline_samples.items()
        },
    }
    candidate_result: dict[str, object] = {
        "schemaVersion": RESULT_SCHEMA_VERSION,
        "suite": SUITE_NAME,
        "mode": "paired-candidate",
        "environment": dict(candidate_environment or {}),
        "scenarios": {
            scenario: build_scenario_result(samples)
            for scenario, samples in candidate_samples.items()
        },
    }
    comparisons, failures = compare_bootstrap_results(
        candidate_result, baseline_result
    )
    missing = sorted(set(selected) - set(comparisons))
    failures.extend(
        f"paired comparison missing scenario: {scenario}" for scenario in missing
    )
    go_no_go = evaluate_go_no_go(
        comparisons, candidate_result, args.candidate_concurrency
    )
    if not go_no_go["passed"]:
        failures.append("candidate did not satisfy the Agent bootstrap Go/No-Go gates")
    result: dict[str, object] = {
        "schemaVersion": RESULT_SCHEMA_VERSION,
        "suite": SUITE_NAME,
        "mode": "paired",
        "createdAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "durationMs": round((time.time() - started) * 1_000, 3),
        "schedule": {
            "warmupsPerVersion": args.paired_warmups,
            "rounds": args.paired_rounds,
            "order": ["baseline", "candidate", "candidate", "baseline"],
            "samplesPerVersion": args.paired_rounds * 2,
        },
        "baselineRoot": str(baseline_root),
        "candidateRoot": str(candidate_root),
        "baseline": baseline_result,
        "candidate": candidate_result,
        "comparisons": comparisons,
        "goNoGo": go_no_go,
        "failures": failures,
    }
    output_path = args.output.resolve()
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(
        json.dumps(result, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 1 if failures else 0


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--samples", type=int, default=3)
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    parser.add_argument("--baseline", type=Path)
    parser.add_argument("--max-regression-percent", type=float, default=25.0)
    parser.add_argument("--check", action="store_true", help="correctness smoke; no timing budget")
    parser.add_argument("--scenario", action="append", choices=SCENARIOS, dest="scenarios")
    parser.add_argument("--paired-baseline-root", type=Path)
    parser.add_argument("--paired-candidate-root", type=Path)
    parser.add_argument("--paired-warmups", type=int, default=3)
    parser.add_argument("--paired-rounds", type=int, default=15)
    parser.add_argument("--candidate-concurrency", type=int, choices=(2, 3, 4))
    args = parser.parse_args()
    if args.samples < 1:
        parser.error("--samples must be >= 1")
    if (args.paired_baseline_root is None) != (
        args.paired_candidate_root is None
    ):
        parser.error(
            "--paired-baseline-root and --paired-candidate-root must be provided together"
        )
    paired_mode = args.paired_baseline_root is not None
    if paired_mode and args.candidate_concurrency is None:
        parser.error("--candidate-concurrency is required in paired mode")
    if not paired_mode and args.candidate_concurrency is not None:
        parser.error("--candidate-concurrency requires paired mode")
    if args.paired_warmups < 0:
        parser.error("--paired-warmups must be >= 0")
    if args.paired_rounds < 1:
        parser.error("--paired-rounds must be >= 1")
    return args


def main() -> int:
    if os.name != "posix":
        print("chat PTY benchmark currently requires macOS or Linux", file=sys.stderr)
        return 2
    args = parse_args()
    if getattr(args, "paired_baseline_root", None) is not None:
        return run_paired_benchmark(args)
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
                if scenario not in CLI_SERVER_SCENARIOS:
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
                **fixture.cleanup_metrics(),
                "finalScreenSha256": hashlib.sha256(final_screen.encode()).hexdigest(),
                "artifacts": save_artifacts(
                    artifact_dir, scenario, sample_index, fixture, final_screen
                ),
            }
            samples.append(sample_result)
        scenario_results[scenario] = build_scenario_result(samples)

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

    failures: list[str] = []
    bootstrap_comparisons: dict[str, object] = {}
    if args.baseline is not None and not args.check:
        failures.extend(
            compare_baseline(result, args.baseline, args.max_regression_percent)
        )
        try:
            baseline_value: object = json.loads(
                args.baseline.read_text(encoding="utf-8")
            )
        except (OSError, json.JSONDecodeError):
            pass
        else:
            baseline = object_mapping(baseline_value)
            if baseline is not None:
                bootstrap_comparisons, comparison_failures = (
                    compare_bootstrap_results(result, baseline)
                )
                failures.extend(comparison_failures)
    result["budget"]["bootstrapComparisons"] = bootstrap_comparisons
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
