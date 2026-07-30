#!/usr/bin/env python3
"""Minimal stdlib-only Roll Runtime Protocol v1.1 smoke client."""

from __future__ import annotations

import argparse
from collections import deque
import json
import subprocess
import sys
import uuid
from pathlib import Path
from typing import Any, Union

JsonRpcId = Union[str, int]
JsonObject = dict[str, Any]
TERMINAL_TURN_EVENTS = {"turn.completed", "turn.cancelled", "turn.failed"}


class RollRuntimeClient:
    def __init__(self, cwd: Path, command: str = "roll") -> None:
        self._next_id = 0
        self._protocol_version: str | None = None
        self._queued_events: deque[JsonObject] = deque()
        self._queued_responses: dict[JsonRpcId, JsonObject] = {}
        self._legacy_approval_ids: set[str] = set()
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

    def _write(self, message: JsonObject) -> None:
        self._stdin.write(json.dumps(message) + "\n")
        self._stdin.flush()

    def _read(self) -> JsonObject:
        line = self._stdout.readline()
        if line == "":
            raise RuntimeError("Roll Runtime exited; in-flight outcomes are unknown")
        message: Any = json.loads(line)
        if not isinstance(message, dict):
            raise RuntimeError("Roll Runtime emitted a non-object JSON-RPC frame")
        return message

    @staticmethod
    def _json_rpc_id(value: Any) -> JsonRpcId | None:
        if isinstance(value, str):
            return value
        if isinstance(value, int) and not isinstance(value, bool):
            return value
        return None

    def _send_error(self, request_id: JsonRpcId, code: int, message: str) -> None:
        self._write(
            {
                "jsonrpc": "2.0",
                "id": request_id,
                "error": {"code": code, "message": message},
            }
        )

    def _handle_server_request(self, message: JsonObject) -> None:
        request_id = self._json_rpc_id(message.get("id"))
        if request_id is None:
            raise RuntimeError("Roll Runtime emitted a Server Request without a valid id")
        method = message.get("method")
        if method != "approval.request":
            self._send_error(request_id, -32601, "Method not found")
            return

        params = message.get("params")
        if not isinstance(params, dict):
            self._send_error(request_id, -32602, "Invalid approval.request params")
            return
        approval = params.get("approval")
        if (
            not isinstance(params.get("threadId"), str)
            or not isinstance(approval, dict)
            or not isinstance(approval.get("id"), str)
            or not isinstance(approval.get("turnId"), str)
            or not isinstance(approval.get("agentName"), str)
            or not isinstance(approval.get("toolName"), str)
        ):
            self._send_error(request_id, -32602, "Invalid approval.request params")
            return

        print(
            "rejecting approval request "
            f"{approval['agentName']}.{approval['toolName']} ({approval['id']})",
            file=sys.stderr,
        )
        self._write(
            {
                "jsonrpc": "2.0",
                "id": request_id,
                "result": {
                    "decision": "reject",
                    "reason": "Python smoke client rejects approvals by default",
                },
            }
        )

    def _handle_cancel_notification(self, params: Any) -> None:
        if not isinstance(params, dict):
            raise RuntimeError("Invalid runtime.serverRequest.cancel params")
        server_request_id = self._json_rpc_id(params.get("serverRequestId"))
        reason = params.get("reason")
        if server_request_id is None or not isinstance(reason, str) or reason == "":
            raise RuntimeError("Invalid runtime.serverRequest.cancel params")
        print(
            f"server request {server_request_id!r} cancelled: {reason}",
            file=sys.stderr,
        )

    def _reject_legacy_approval(self, envelope: JsonObject) -> None:
        event = envelope.get("event")
        if not isinstance(event, dict) or event.get("type") != "approval.required":
            return
        approval = event.get("approval")
        thread_id = envelope.get("threadId")
        if (
            not isinstance(approval, dict)
            or not isinstance(approval.get("id"), str)
            or not isinstance(approval.get("turnId"), str)
            or not isinstance(thread_id, str)
        ):
            raise RuntimeError("Invalid Protocol 1.0 approval.required event")
        approval_id = approval["id"]
        if approval_id in self._legacy_approval_ids:
            return
        self._legacy_approval_ids.add(approval_id)
        self.request(
            "approval.respond",
            {
                "requestId": str(uuid.uuid4()),
                "threadId": thread_id,
                "turnId": approval["turnId"],
                "approvalId": approval_id,
                "decision": "reject",
                "reason": "Python smoke client rejects approvals by default",
            },
        )

    def _handle_event_notification(self, params: Any) -> None:
        if not isinstance(params, dict):
            raise RuntimeError("Invalid runtime.event params")
        self._queued_events.append(params)
        print(json.dumps(params, ensure_ascii=False))
        if self._protocol_version == "1.0":
            self._reject_legacy_approval(params)

    def _dispatch(self, message: JsonObject) -> None:
        method = message.get("method")
        if isinstance(method, str):
            if "id" in message:
                self._handle_server_request(message)
            elif method == "runtime.event":
                self._handle_event_notification(message.get("params"))
            elif method == "runtime.serverRequest.cancel":
                self._handle_cancel_notification(message.get("params"))
            else:
                raise RuntimeError(f"Roll Runtime emitted unknown notification {method!r}")
            return

        response_id = self._json_rpc_id(message.get("id"))
        if response_id is None:
            raise RuntimeError("Roll Runtime emitted an uncorrelated JSON-RPC response")
        self._queued_responses[response_id] = message

    def request(self, method: str, params: JsonObject) -> JsonObject:
        request_id = self._next_id
        self._next_id += 1
        self._write(
            {
                "jsonrpc": "2.0",
                "id": request_id,
                "method": method,
                "params": params,
            }
        )
        while request_id not in self._queued_responses:
            self._dispatch(self._read())
        message = self._queued_responses.pop(request_id)
        if "error" in message:
            raise RuntimeError(json.dumps(message["error"], ensure_ascii=False))
        result = message.get("result")
        if not isinstance(result, dict):
            raise RuntimeError(f"{method} returned a non-object result")
        return result

    def wait_for_turn(self, thread_id: str, turn_id: str) -> None:
        while True:
            if not self._queued_events:
                self._dispatch(self._read())
                continue
            envelope = self._queued_events.popleft()
            event = envelope.get("event")
            if (
                envelope.get("threadId") == thread_id
                and envelope.get("turnId") == turn_id
                and isinstance(event, dict)
                and event.get("type") in TERMINAL_TURN_EVENTS
            ):
                return

    def initialize(self) -> JsonObject:
        initialized = self.request(
            "initialize",
            {
                "protocolVersions": ["1.1", "1.0"],
                "client": {"name": "python-smoke", "version": "1.1.0"},
            },
        )
        protocol_version = initialized.get("protocolVersion")
        if protocol_version not in {"1.1", "1.0"}:
            raise RuntimeError(f"Runtime selected unsupported Protocol {protocol_version!r}")
        self._protocol_version = protocol_version
        return initialized

    def close(self) -> None:
        if not self._stdin.closed:
            self._stdin.close()
        try:
            self._process.wait(timeout=5)
        except subprocess.TimeoutExpired:
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
        initialized = client.initialize()
        print(
            "connected "
            f"protocol={initialized['protocolVersion']} "
            f"runtime={initialized['runtimeInstanceId']}",
            file=sys.stderr,
        )
        created = client.request(
            "thread.create",
            {"requestId": str(uuid.uuid4()), "title": "Python smoke"},
        )
        thread_id = created["thread"]["id"]
        turn_id = str(uuid.uuid4())
        client.request(
            "turn.start",
            {
                "requestId": str(uuid.uuid4()),
                "threadId": thread_id,
                "turnId": turn_id,
                "input": {"text": args.message},
            },
        )
        client.wait_for_turn(thread_id, turn_id)
        return 0
    finally:
        client.close()


if __name__ == "__main__":
    raise SystemExit(main())
