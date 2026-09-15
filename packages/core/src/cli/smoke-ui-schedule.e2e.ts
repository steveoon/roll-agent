import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { z } from "zod";
import { ScheduleStore } from "@roll-agent/runtime";
import {
  createDaemonRecord,
  removeDaemonRecord,
  writeDaemonRecord,
} from "../scheduler-host/daemon-record.ts";
import { startRollUiServer, createRollUiRuntimeController } from "../ui/index.ts";
import { createDefaultScheduleController } from "./commands/ui-schedule-controller.ts";

test("e2e UI API: authenticated legacy reads, guarded writes, pause/resume/cancel and idempotent extension", async () => {
  const root = mkdtempSync(join(tmpdir(), "roll-ui-management-"));
  const previousCwd = process.cwd();
  const previousHome = process.env["HOME"];
  const previousProfile = process.env["USERPROFILE"];
  const dataDir = join(root, "ledger");
  let server: Awaited<ReturnType<typeof startRollUiServer>> | undefined;
  try {
    process.chdir(root);
    process.env["HOME"] = root;
    process.env["USERPROFILE"] = root;
    const configPath = join(root, "roll.config.yaml");
    writeFileSync(
      configPath,
      JSON.stringify({
        scheduler: { "data-dir": dataDir },
        agents: { "data-dir": join(root, "agents") },
      }),
    );
    const store = new ScheduleStore(dataDir);
    const active = store.createSchedule({
      name: "active",
      prompt: "noop",
      cwd: root,
      trigger: { kind: "interval", everyMs: 60_000, startAtMs: Date.parse("2099-01-01T00:00:00Z") },
      maxRounds: 2,
    });
    const completed = store.createSchedule({
      name: "completed",
      prompt: "noop",
      cwd: root,
      trigger: { kind: "interval", everyMs: 60_000 },
      fireImmediately: true,
      maxRounds: 1,
    });
    const claim = store.claimDue({ workerId: "fixture", nowMs: Date.now(), limit: 1 })[0];
    assert.ok(claim);
    assert.equal(claim.schedule.id, completed.id);
    assert.equal(
      store.completeInvocation({
        id: claim.invocation.id,
        ownershipToken: claim.ownershipToken,
        status: "completed",
        nowMs: Date.now(),
      }),
      "written",
    );
    const manual = store.enqueueManualInvocation(active.id, Date.now());
    store.close();
    const record = createDaemonRecord("legacy-ui-http-fixture");
    const recordPath = join(dataDir, "daemon.json");
    writeDaemonRecord(recordPath, record);
    server = await startRollUiServer({
      controller: createRollUiRuntimeController({ configPath }),
      scheduleController: await createDefaultScheduleController(),
      staticAssets: {
        getAsset: () => ({ body: "<!doctype html><title>test</title>", contentType: "text/html" }),
      },
    });
    const rootUrl = `${server.origin}${server.basePath}`;
    const bootstrap = await fetch(`${rootUrl}/api/bootstrap`, {
      method: "POST",
      headers: { origin: server.origin, "content-type": "application/json" },
      body: JSON.stringify({
        token: new URLSearchParams(new URL(server.url).hash.slice(1)).get("token"),
      }),
    });
    assert.equal(bootstrap.status, 200);
    const cookie = bootstrap.headers.get("set-cookie")?.split(";")[0];
    assert.ok(cookie);
    const { data } = z
      .object({ data: z.object({ csrfToken: z.string() }) })
      .parse(await bootstrap.json());
    const headers = {
      cookie,
      origin: server.origin,
      "x-csrf-token": data.csrfToken,
      "content-type": "application/json",
    };
    const post = (path: string, body: unknown) =>
      fetch(`${rootUrl}${path}`, { method: "POST", headers, body: JSON.stringify(body) });
    for (const path of ["/api/schedule/status", "/api/schedule/schedules", "/api/schedule/runs"]) {
      const response = await fetch(`${rootUrl}${path}`, { headers });
      assert.equal(response.status, 200, `${path}: ${await response.clone().text()}`);
      if (path.endsWith("status")) assert.match(await response.text(), /"requiresRestart":true/u);
    }
    const blocked = await post("/api/schedule/pause", { id: active.id });
    assert.notEqual(blocked.status, 200);
    assert.match(await blocked.text(), /版本不兼容/u);
    removeDaemonRecord(recordPath, record);
    for (const action of ["pause", "resume"]) {
      const response = await post(`/api/schedule/${action}`, { id: active.id });
      assert.equal(response.status, 200, await response.clone().text());
      const reader = new ScheduleStore(dataDir, { readOnly: true });
      try {
        assert.equal(
          reader.getSchedule(active.id)?.status,
          action === "pause" ? "paused" : "active",
        );
      } finally {
        reader.close();
      }
    }
    const cancelled = await post("/api/schedule/cancel", { id: manual.id, kill: false });
    assert.equal(cancelled.status, 200, await cancelled.clone().text());
    const request = {
      id: completed.id,
      rounds: 2,
      expectedMaxRounds: 1,
      requestId: "ui-http-extension",
    };
    for (const extended of [true, false]) {
      const response = await post("/api/schedule/extend", request);
      assert.equal(response.status, 200, await response.clone().text());
      const result = z
        .object({ data: z.object({ extended: z.boolean() }) })
        .parse(await response.json());
      assert.equal(result.data.extended, extended);
    }
    const reader = new ScheduleStore(dataDir, { readOnly: true });
    try {
      assert.equal(reader.getSchedule(completed.id)?.maxRounds, 3);
      assert.equal(reader.getSchedule(completed.id)?.roundsStarted, 1);
      assert.equal(reader.getSchedule(active.id)?.roundsStarted, 0);
      assert.equal(reader.getInvocation(manual.id)?.status, "failed");
    } finally {
      reader.close();
    }
  } finally {
    await server?.close();
    process.chdir(previousCwd);
    if (previousHome === undefined) delete process.env["HOME"];
    else process.env["HOME"] = previousHome;
    if (previousProfile === undefined) delete process.env["USERPROFILE"];
    else process.env["USERPROFILE"] = previousProfile;
    rmSync(root, { recursive: true, force: true });
  }
});
