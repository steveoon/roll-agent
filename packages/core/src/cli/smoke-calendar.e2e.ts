import assert from "node:assert/strict";
import { once } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { z } from "zod";
import { ScheduleStore } from "@roll-agent/runtime";
import {
  cleanupSpawnedRollProcess,
  formatSpawnedRollProcess,
  runRoll,
  spawnRollProcess,
  waitForSmokeCondition,
  waitForSpawnedRollExit,
} from "./smoke.e2e-harness.ts";

test("e2e calendar: Roll Core skill installation preserves calendar instructions and references", () => {
  const workspace = mkdtempSync(join(tmpdir(), "roll-calendar-skill-"));
  const source = resolve(import.meta.dirname, "../../../../openclaw-roll-core-skill-template");
  const target = join(workspace, ".agents", "skills");
  try {
    writeFileSync(
      join(workspace, "roll.config.yaml"),
      JSON.stringify({
        agents: { "data-dir": join(workspace, "agents") },
      }),
    );
    const installed = runRoll(["skills", "install", source, "--dir", target, "--json"], workspace);
    assert.equal(installed.status, 0, installed.stderr);
    assert.match(installed.stdout, /roll-core/u);
    for (const file of [
      "SKILL.md",
      "agents/openai.yaml",
      "references/workflows.md",
      "references/errors.md",
    ]) {
      assert.equal(
        readFileSync(join(target, "roll-core", file), "utf8"),
        readFileSync(join(source, file), "utf8"),
      );
    }
    const instructions = readFileSync(join(target, "roll-core", "SKILL.md"), "utf8");
    assert.match(instructions, /--start-at/u);
    assert.match(instructions, /--daily/u);
    assert.match(instructions, /--weekly/u);
    assert.doesNotMatch(instructions, /Interval only|There is no calendar/u);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test(
  "e2e calendar: future interval ends after two real rounds; daily/weekly and manual execution preserve quota",
  { timeout: 210_000 },
  async () => {
    const workspace = mkdtempSync(join(tmpdir(), "roll-calendar-success-"));
    const dataDir = join(workspace, "scheduler");
    const requests: string[] = [];
    const requestTimes: number[] = [];
    const server = createServer((req, res) => {
      let body = "";
      req.setEncoding("utf8");
      req.on("data", (chunk: string) => {
        body += chunk;
      });
      req.on("end", () => {
        requests.push(body);
        requestTimes.push(Date.now());
        const input = z.object({ stream: z.boolean().optional() }).parse(JSON.parse(body));
        const common = { id: "calendar-fixture", created: 1, model: "qwen-calendar-fixture" };
        if (input.stream) {
          res.writeHead(200, { "content-type": "text/event-stream" });
          for (const choice of [
            {
              index: 0,
              delta: { role: "assistant", content: "CALENDAR_E2E_OK" },
              finish_reason: null,
            },
            { index: 0, delta: {}, finish_reason: "stop" },
          ]) {
            res.write(
              `data: ${JSON.stringify({ ...common, object: "chat.completion.chunk", choices: [choice] })}\n\n`,
            );
          }
          res.end("data: [DONE]\n\n");
        } else {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(
            JSON.stringify({
              ...common,
              object: "chat.completion",
              choices: [
                {
                  index: 0,
                  message: { role: "assistant", content: "CALENDAR_E2E_OK" },
                  finish_reason: "stop",
                },
              ],
              usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
            }),
          );
        }
      });
    });
    let daemon: ReturnType<typeof spawnRollProcess> | undefined;
    let manualProcess: ReturnType<typeof spawnRollProcess> | undefined;
    let reader: ScheduleStore | undefined;
    try {
      server.listen(0, "127.0.0.1");
      await once(server, "listening");
      const address = server.address();
      assert.ok(address && typeof address !== "string");
      writeFileSync(
        join(workspace, "roll.config.yaml"),
        JSON.stringify({
          llm: {
            "default-provider": "qwen",
            "default-model": "qwen-calendar-fixture",
            providers: {
              qwen: {
                "api-key": "isolated-fixture-only",
                "base-url": `http://127.0.0.1:${String(address.port)}/v1`,
              },
            },
          },
          chat: { instructions: "off" },
          agents: { "data-dir": join(workspace, "agents") },
          runtime: {
            "threads-dir": join(workspace, "threads"),
            "thinking-level": "off",
            compaction: { strategy: "truncate" },
          },
          scheduler: { "data-dir": dataDir },
        }),
      );
      // All three first occurrences share an independently calculated UTC minute. Leave
      // at least 15 seconds for registration/startup; no clock or claim code is mocked.
      const firstAt = Math.ceil((Date.now() + 15_000) / 60_000) * 60_000;
      const local = new Date(firstAt + 345 * 60_000).toISOString().slice(0, 16);
      const shanghai = new Date(firstAt + 480 * 60_000);
      const time = shanghai.toISOString().slice(11, 16);
      const day = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"][shanghai.getUTCDay()];
      assert.ok(day);
      const ids: string[] = [];
      for (const [name, flags] of [
        ["future-interval", ["--every", "1m", "--start-at", local]],
        ["daily", ["--daily", local.slice(11), "--start-at", local]],
        [
          "weekly",
          [
            "--weekly",
            day,
            "--at",
            time,
            "--time-zone",
            "Asia/Shanghai",
            "--start-at",
            new Date(firstAt).toISOString(),
          ],
        ],
      ] as const) {
        const added = runRoll(
          [
            "schedule",
            "add",
            `Return CALENDAR_E2E_OK for ${name}; do not call tools.`,
            "--name",
            name,
            ...flags,
            "--rounds",
            name === "future-interval" ? "2" : "1",
            "--json",
          ],
          workspace,
          { env: { TZ: "Asia/Kathmandu" } },
        );
        assert.equal(added.status, 0, added.stderr);
        const result = z
          .object({ id: z.string(), nextRunAt: z.string() })
          .parse(JSON.parse(added.stdout));
        assert.equal(Date.parse(result.nextRunAt), firstAt);
        ids.push(result.id);
      }
      reader = new ScheduleStore(dataDir, { readOnly: true });
      const store = reader;
      assert.equal(store.listSchedules().length, 3);
      assert.equal(store.listSchedules().find((s) => s.name === "daily")?.trigger.kind, "calendar");
      // Switching the executor's machine zone must not reinterpret saved rules.
      const process = spawnRollProcess(["schedule", "daemon", "--foreground"], workspace, {
        TZ: "America/New_York",
      });
      daemon = process;
      const diagnostics = () =>
        `${formatSpawnedRollProcess("calendar daemon", process)}\n${JSON.stringify(store.listSchedules())}\n${JSON.stringify(ids.flatMap((id) => store.listInvocations(id)))}`;
      await waitForSmokeCondition(
        "daemon readiness before first occurrence",
        () => existsSync(join(dataDir, "daemon.json")),
        diagnostics,
        10_000,
      );
      assert.ok(Date.now() < firstAt, diagnostics());
      assert.equal(requests.length, 0);
      assert.ok(
        ids.every((id) => store.listInvocations(id).length === 0),
        diagnostics(),
      );
      await waitForSmokeCondition(
        "all scheduled rounds to settle",
        () => ids.every((id) => store.getSchedule(id)?.status === "completed"),
        diagnostics,
        170_000,
      );
      assert.equal(requests.length, 4, diagnostics());
      assert.ok(requestTimes.every((time) => time >= firstAt));
      for (const id of ids) {
        const schedule = store.getSchedule(id);
        const expectedRounds = schedule?.name === "future-interval" ? 2 : 1;
        assert.equal(schedule?.roundsStarted, expectedRounds);
        const runs = [...store.listInvocations(id)].sort(
          (a, b) => a.scheduledForMs - b.scheduledForMs,
        );
        assert.equal(runs.length, expectedRounds);
        assert.ok(runs.every((run) => run.status === "completed" && run.mode === "scheduled"));
        assert.equal(runs[0]?.status, "completed");
        assert.equal(runs[0]?.scheduledForMs, firstAt);
        if (expectedRounds === 2) assert.ok((runs[1]?.scheduledForMs ?? 0) >= firstAt + 60_000);
        assert.match(runs[0]?.outputExcerpt ?? "", /CALENDAR_E2E_OK/u);
        assert.ok(runs[0]?.threadId);
        const inspected = runRoll(["schedule", "inspect", runs[0]?.id ?? "", "--json"], workspace);
        assert.equal(inspected.status, 0, inspected.stderr);
        assert.match(inspected.stdout, /CALENDAR_E2E_OK/u);
      }
      assert.ok(
        requests.every(
          (body) =>
            body.includes("timeZone=America/New_York") && body.includes("turnOrigin=scheduled"),
        ),
      );
      const intervalId = ids[0];
      assert.ok(intervalId);
      const manual = spawnRollProcess(
        ["schedule", "run-now", intervalId, "--inline", "--json"],
        workspace,
        { TZ: "America/New_York" },
      );
      manualProcess = manual;
      const manualExit = await waitForSpawnedRollExit(manual, "manual scheduled turn", 30_000);
      assert.equal(manualExit.code, 0, formatSpawnedRollProcess("manual", manual));
      assert.equal(store.getSchedule(intervalId)?.roundsStarted, 2);
      assert.equal(store.getSchedule(intervalId)?.status, "completed");
      assert.equal(store.listInvocations(intervalId).length, 3);
      assert.equal(requests.length, 5);
      process.child.kill("SIGTERM");
      const exit = await waitForSpawnedRollExit(process, "calendar daemon");
      assert.equal(exit.code, 0, diagnostics());
    } finally {
      if (manualProcess) {
        manualProcess.child.kill("SIGTERM");
        await cleanupSpawnedRollProcess(manualProcess, "manual scheduled turn");
      }
      if (daemon) {
        daemon.child.kill("SIGTERM");
        await cleanupSpawnedRollProcess(daemon, "calendar daemon");
      }
      reader?.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(workspace, { recursive: true, force: true });
    }
  },
);
