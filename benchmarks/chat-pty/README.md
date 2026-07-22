# `roll chat` PTY performance and correctness harness

This test-only harness separates production CLI startup from deterministic Ink rendering while running
both paths inside a real Unix PTY.

| Scenario | Boundary measured | Isolation and correctness oracle |
| --- | --- | --- |
| `cli-bootstrap` | Production `roll chat --server` process through config loading, lazy imports, provider construction, and runtime-server readiness | Temporary `HOME`, config, threads, and agents directories; dummy key and loopback-only base URL; no model request |
| `cli-ink-cold-start` | Production `roll chat` process through the first interactive Ink prompt | Same isolated config; waits for the Prompt, opens `/`, requires the slash-menu navigation hint, clears it, makes no model request, and exits through bounded `/exit` cleanup |
| `fixture-ink-cold-start` | Real `runInkRepl()` startup through the first prompt | Deterministic in-process Session fixture; no provider or model request |
| `keypress`, `text-stream`, `tool-stream`, `resize-storm`, `idle` | Real Ink input/render/resize/idle paths after deterministic fixture startup | Scenario-specific screen and stream oracles |

The production CLI scenarios use the TypeScript source entrypoint for development/CI parity. Child
processes explicitly disable CI classification because Ink otherwise suppresses interactive rendering
even inside a real PTY. Their temporary provider URL is `127.0.0.1:1`, so an accidental model call fails locally instead of reaching
the network. They measure CLI architecture and UI readiness, not first-turn inference latency.

```bash
pnpm perf:chat                         # three samples per scenario
pnpm perf:chat:test                    # deterministic harness contract tests
pnpm perf:chat:check                   # one-sample correctness smoke, no timing budget
pnpm perf:chat -- --samples 5
pnpm perf:chat -- --baseline outputs/chat-pty/baseline.json
```

## Stream correctness

The stream scenarios reconstruct every visible terminal frame. The marker oracle records the order in
which each marker first appears and fails on any missing, unexpected, out-of-order, or simultaneously
duplicated marker. Persistent text across successive screen snapshots is not treated as duplication.

- Text: `word000..word398`, followed by `STREAM_COMPLETE_400`.
- Tool output: `tool-chunk-00..79`, followed by `TOOL_STREAM_COMPLETE`.

Both scenarios also report single-stream frame interval median, p95, and p99 instead of deriving frame
tail latency from aggregate sample duration.

## Results and fail-closed baselines

Results use schema version 2 and suite name `roll-chat-real-pty`. They are written to
`outputs/chat-pty/results.json`; raw ANSI bytes, timestamped base64 chunks, and the reconstructed final
screen are saved beside the result for CI artifact upload.
If a scenario fails, the harness still writes its raw ANSI stream, timestamped frames, reconstructed
screen, and traceback before returning a non-zero status, so CI failures remain diagnosable.

Baseline comparison is fail-closed. A supplied baseline must:

1. Match the current `schemaVersion` and `suite`.
2. Contain every scenario selected by the current run.
3. Contain a numeric median for every required metric in that scenario.

Any mismatch exits non-zero. `idle.cpuMs` remains optional because some hosts expose no supported live
CPU counter; it is compared only when both results contain a numeric value. By default, numeric
lower-is-better medians may regress by 25%; change this with `--max-regression-percent`.

The idle scenario also reports terminal redraw/output cost. Animation may make those values non-zero.
It reads live-process CPU counters from `/proc` on Linux and `libproc` on macOS; otherwise it sets
`cpuAvailable: false` and omits `cpuMs`.

## CI boundary

Pull-request CI runs `pnpm perf:chat:test` and the one-sample correctness smoke, then uploads
`chat-pty-<os>-<run-id>`. Shared runners do not enforce timing budgets. A stable runner is the
operational prerequisite for promoting a result to a baseline and enabling regression gating.

The driver uses Python standard-library `os.openpty()` and `ioctl(TIOCSWINSZ)`, avoiding the native
build surface of `node-pty`. Linux and macOS use this POSIX path; Windows remains outside this harness
until a separate ConPTY adapter is implemented.
