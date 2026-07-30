# Python Runtime Protocol v1.1 smoke client

This example uses only the Python standard library and talks to the public
`Roll Runtime Protocol v1` over stdio. It is bidirectional: while waiting for a
Client→Runtime response, it also dispatches Runtime→Client requests and
notifications.

This is a local-only Runtime Protocol example. It does not implement Companion Relay, does not
import `@roll-agent/relay-protocol`, and does not make the local Runtime remotely reachable.

```bash
python3 examples/python-runtime-client/client.py \
  --cwd /absolute/path/to/workspace
```

The `cwd` is mandatory because it controls Roll config discovery, Skills,
Shell access, Git context, and the local workspace boundary.

The client advertises `["1.1", "1.0"]`:

| Negotiated version | Approval control path |
|---|---|
| `"1.1"` | Handles `approval.request` and safely rejects by default; recognizes `runtime.serverRequest.cancel` by its `serverRequestId` |
| `"1.0"` | Treats `approval.required` as a control event and sends one idempotent `approval.respond` rejection |

For a real GUI, replace the default rejection with a non-blocking prompt and
track each Runtime→Client JSON-RPC `id`. A
`runtime.serverRequest.cancel.params.serverRequestId` notification must close
that prompt and suppress any late response. In `"1.1"`, `approval.required` and
`approval.resolved` are view events only; do not also call `approval.respond`.
