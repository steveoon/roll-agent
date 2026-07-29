#!/usr/bin/env python3
"""Minimal stdlib-only Roll Runtime Protocol v1 smoke client."""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
import uuid
from pathlib import Path
from typing import Any


class RollRuntimeClient:
    def __init__(self, cwd: Path, command: str = "roll") -> None:
        self._next_id = 0
        self._process = subprocess.Popen(
            [command, "runtime", "serve", "--stdio"],
            cwd=cwd,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=None,
            text=True,
            bufsize=1,
        )
        if self._process.stdin is None or self._process.stdout is None:
            raise RuntimeError("failed to open Roll Runtime stdio")
        self._stdin = self._process.stdin
        self._stdout = self._process.stdout

    def request(self, method: str, params: dict[str, Any]) -> dict[str, Any]:
        request_id = self._next_id
        self._next_id += 1
        self._stdin.write(
            json.dumps(
                {
                    "jsonrpc": "2.0",
                    "id": request_id,
                    "method": method,
                    "params": params,
                }
            )
            + "\n"
        )
        self._stdin.flush()
        while line := self._stdout.readline():
            message = json.loads(line)
            if message.get("method") == "runtime.event":
                print(json.dumps(message["params"], ensure_ascii=False))
                continue
            if message.get("id") != request_id:
                continue
            if "error" in message:
                raise RuntimeError(json.dumps(message["error"], ensure_ascii=False))
            return message["result"]
        raise RuntimeError("Roll Runtime exited before returning a response")

    def wait_for_turn(self, turn_id: str) -> None:
        terminal = {"turn.completed", "turn.cancelled", "turn.failed"}
        while line := self._stdout.readline():
            message = json.loads(line)
            if message.get("method") != "runtime.event":
                continue
            envelope = message["params"]
            print(json.dumps(envelope, ensure_ascii=False))
            if envelope.get("turnId") == turn_id and envelope["event"]["type"] in terminal:
                return
        raise RuntimeError("Roll Runtime exited while the Turn was active; outcome is unknown")

    def close(self) -> None:
        self._stdin.close()
        self._process.terminate()
        self._process.wait(timeout=5)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--cwd", type=Path, required=True)
    parser.add_argument("--command", default="roll")
    parser.add_argument("--message", default="Reply with a short hello.")
    args = parser.parse_args()
    client = RollRuntimeClient(args.cwd.resolve(), args.command)
    try:
        initialized = client.request(
            "initialize",
            {
                "protocolVersions": ["1.0"],
                "client": {"name": "python-smoke", "version": "1.0.0"},
            },
        )
        print(f"connected runtime={initialized['runtimeInstanceId']}", file=sys.stderr)
        created = client.request(
            "thread.create",
            {"requestId": str(uuid.uuid4()), "title": "Python smoke"},
        )
        turn_id = str(uuid.uuid4())
        client.request(
            "turn.start",
            {
                "requestId": str(uuid.uuid4()),
                "threadId": created["thread"]["id"],
                "turnId": turn_id,
                "input": {"text": args.message},
            },
        )
        client.wait_for_turn(turn_id)
        return 0
    finally:
        client.close()


if __name__ == "__main__":
    raise SystemExit(main())
