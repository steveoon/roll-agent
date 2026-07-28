# `roll chat` PTY performance and correctness harness

This test-only harness separates production CLI startup from deterministic Ink rendering while running
both paths inside a real Unix PTY.

| Scenario | Boundary measured | Isolation and correctness oracle |
| --- | --- | --- |
| `cli-bootstrap` | Production `roll chat --server` process through config loading, lazy imports, provider construction, and runtime-server readiness | Temporary `HOME`, config, threads, and agents directories; dummy key and loopback-only base URL; no model request |
| `cli-ink-cold-start` | Production `roll chat` process through the first interactive Ink prompt | Same isolated config; waits for the Prompt, opens `/`, requires the slash-menu navigation hint, clears it, makes no model request, and exits through bounded `/exit` cleanup |
| `cli-server-1-agent-bootstrap` | A real `session.create` request through one stdio Agent connection and Tool discovery | One MCP process with a deterministic 400 ms `tools/list` delay; validates `session.capabilities`, the exact Agent Tool catalog, lifecycle, and clean EOF shutdown |
| `cli-server-5-agent-bootstrap` | A real `session.create` request through five registered stdio Agents | Registration-order delays of 400/300/250/150/100 ms; validates all five Agents and Tools, stable topology/catalog hashes, observed list concurrency, and cleanup |
| `cli-ink-5-agent-cold-start` | Production process start through the first prompt and visible `5 agents` banner | Uses the same five-Agent topology; validates each fixture's actual `tools/list` lifecycle and clean exit without inventing an unobservable catalog hash |
| `fixture-ink-cold-start` | Real `runInkRepl()` startup through the first prompt | Deterministic in-process Session fixture; no provider or model request |
| `keypress`, `text-stream`, `tool-stream`, `idle` | Real Ink input/render/stream/idle paths after deterministic fixture startup | Scenario-specific screen and stream oracles; `keypress` also requires a visible, CJK-width-aware terminal cursor for IME preedit anchoring |
| `resize-cycle` | Deliberate shrink/expand checkpoints plus a 40×10 compact-layout probe | Long-history sentinels remain unique; slash popup borders and the IME cursor anchor remain correct at every size |
| `resize-storm` | 25 rapid resizes followed by a distinct canonical final size | Requires a settled redraw containing every semantic sentinel exactly once with the draft cursor aligned |
| `stream-resize` | 400-token stream while 21 resizes are delivered | Complete ordered token oracle, unique final sentinels, and a restored IME cursor after streaming |

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

# Stable-runner A/B: 3 warmups per version, then 15 B-C-C-B rounds (30 paired samples)
pnpm perf:chat -- \
  --paired-baseline-root /path/to/baseline-worktree \
  --paired-candidate-root /path/to/candidate-worktree \
  --candidate-concurrency 3 \
  --output outputs/chat-pty/paired.json
```

Paired mode defaults to the two zero-Agent startup controls plus the 1-Agent, 5-Agent server, and
5-Agent Ink scenarios. It runs the current harness against each supplied worktree's CLI source, so
the baseline worktree does not need to contain this newer harness. `--paired-warmups` and
`--paired-rounds` can reduce the schedule for local correctness smoke tests; only the default 30
samples per version can pass the paired-stability gate.

The paired result reports baseline/candidate median and p95, candidate-minus-baseline absolute and
percent deltas (negative is faster), and `fasterPairCount`. It fails closed when sample counts,
topology hashes, or server catalog hashes differ. Its `goNoGo` section applies the Issue #161
thresholds directly, including zero/one-Agent regressions, 24/30 paired wins, p95, and requiring
every candidate sample to satisfy `1 < peakActive <= --candidate-concurrency`.
The nested metric summaries still display p99, but a 30-pair campaign does not use it as a gate.

Run separate campaigns for candidate limits 2, 3, and 4. Among candidates whose `goNoGo.passed` is
true, keep the smallest limit whose 5-Agent server and Ink medians are each no more than 10% slower
than the fastest passing candidate for that same scenario.

## Agent bootstrap fixture

The bootstrap scenarios write an isolated schema-v2 `agents.json` and spawn real stdio MCP servers.
Each server owns a separate lifecycle JSON file with `started`, `list-start`, `list-end`, and
`exited` timestamps. These observations prove Tool discovery occurred, calculate `peakActive`, and
make missing or orphaned processes correctness failures.

The server scenarios keep JSON-RPC input on a separate pipe while stdout/stderr remain on the PTY.
After `session.create`, the driver sends `session.capabilities` and checks its result, manifest,
Agent count, and the exact set of non-built-in Tools. Identity fields must match registration order,
while the catalog hash covers each complete Agent capability, including its schema, annotations,
approval, role, and description when present. A pre-turn response legitimately has no `turnContext`;
when one is present it must be an object. Teardown closes the input pipe and requires the CLI and all
Agent processes to exit naturally with status 0. TERM/KILL are failure-only fallbacks and set
`forcedCleanup`.

The measured clock begins immediately before `Popen`, after temporary config and registry setup.
`sessionCreateReadyMs` starts immediately before the JSON-RPC request, while
`cliInkFiveAgentFirstInteractiveMs` spans process start to the first prompt with the five-Agent
banner.

Child environments remove variables whose names contain `KEY`, `TOKEN`, `SECRET`, `PASSWORD`, or
`CREDENTIAL`; the only provider credential is a fixed dummy key and the provider URL is the local
unreachable address `127.0.0.1:1`. No scenario sends a model request or accesses an external
provider.

## Stream correctness

The stream scenarios reconstruct every visible terminal frame. The marker oracle records the order in
which each marker first appears and fails on any missing, unexpected, out-of-order, or simultaneously
duplicated marker. Persistent text across successive screen snapshots is not treated as duplication.

- Text and resize-during-text: `word000..word398`, followed by `STREAM_COMPLETE_400`.
- Tool output: `tool-chunk-00..79`, followed by `TOOL_STREAM_COMPLETE`.

Both scenarios also report single-stream frame interval median, p95, and p99 instead of deriving frame
tail latency from aggregate sample duration.

The PTY can validate the terminal-side IME contract (a visible cursor at the current insertion cell)
and committed UTF-8 input. It cannot synthesize the macOS input method's uncommitted composition UI,
which is drawn by the terminal emulator rather than sent to the child process.

## Results and fail-closed baselines

Results use schema version 3 and suite name `roll-chat-real-pty`. They are written to
`outputs/chat-pty/results.json`; raw ANSI bytes, timestamped base64 chunks, and the reconstructed final
screen are saved beside the result for CI artifact upload. A terminal-state artifact also records the
primary and alternate buffers, alternate-screen enter/leave counts, cursor visibility, and any input
protocol modes that remain enabled after teardown.
If a scenario fails, the harness still writes its raw ANSI stream, timestamped frames, reconstructed
screen, and traceback before returning a non-zero status, so CI failures remain diagnosable.

Every interactive scenario must enter and leave the alternate screen exactly once, restore the seeded
primary-screen sentinel, show the cursor, and disable bracketed paste, Kitty keyboard, synchronized
updates, and mouse reporting. Cleanup failures are correctness failures even when the UI frame itself
looked valid.

Baseline comparison is fail-closed. A supplied baseline must:

1. Match the current `schemaVersion` and `suite`.
2. Contain every scenario selected by the current run.
3. Contain a numeric median for every required metric in that scenario.

Agent bootstrap comparisons additionally require equal sample counts and stable/equal topology
hashes. Server comparisons also require equal catalog hashes. The Ink scenario intentionally has no
catalog hash because the TUI exposes the Agent count but not the full capability manifest; its Tool
completeness is instead grounded by the fixture's observed `tools/list` lifecycle.

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
