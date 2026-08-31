import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ScheduleStore, createIntervalTrigger } from "@roll-agent/runtime";
import { createInvocationSpawner } from "./spawn-invocation.ts";
import { SCHEDULE_INVOCATION_ENV, SCHEDULE_TOKEN_ENV } from "./paths.ts";

const NOW = Date.parse("2026-08-27T09:00:00.000Z");

test("createInvocationSpawner 把 invocation id 以 ROLL_SCHEDULE_INVOCATION 注入 exec 环境", async () => {
  const dir = mkdtempSync(join(tmpdir(), "roll-spawn-"));
  try {
    const store = new ScheduleStore(dir);
    store.createSchedule(
      {
        name: "巡检",
        prompt: "p",
        cwd: dir,
        trigger: createIntervalTrigger("30m"),
        fireImmediately: true,
      },
      NOW,
    );
    const claim = store.claimDue({ workerId: "w1", nowMs: NOW, limit: 1 })[0];
    assert.ok(claim);
    const outFile = join(dir, "env.json");
    const script = `require("node:fs").writeFileSync(process.argv[1], JSON.stringify({ marker: process.env.${SCHEDULE_INVOCATION_ENV}, token: process.env.${SCHEDULE_TOKEN_ENV} }))`;
    const spawner = createInvocationSpawner({
      invocation: {
        command: process.execPath,
        cliEntrypoint: outFile,
        runtimeArgs: [],
        companionArgs: [],
        execArgv: ["-e", script],
      },
      dataDir: dir,
      logPath: join(dir, "exec.log"),
    });
    const handle = spawner(claim);
    assert.equal(await handle.exited, 0);
    const written = JSON.parse(readFileSync(outFile, "utf-8")) as {
      marker?: string;
      token?: string;
    };
    assert.equal(written.marker, claim.invocation.id);
    assert.equal(written.token, claim.ownershipToken);
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
