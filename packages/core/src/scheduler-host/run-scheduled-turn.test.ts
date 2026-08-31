import assert from "node:assert/strict";
import test from "node:test";
import type { InvocationRecord, ScheduleRecord } from "@roll-agent/runtime";
import type { RollConfig } from "../config/schema.ts";
import {
  createScheduledTurnRunner,
  type CreateScheduledTurnRunnerInput,
} from "./run-scheduled-turn.ts";

test("scheduled turn refuses to start when the exec stop signal is already aborted", async () => {
  const controller = new AbortController();
  controller.abort(new Error("scheduled exec stopping"));
  const unavailable = new Proxy(
    {},
    {
      get() {
        throw new Error("aborted scheduled turn must not read runtime/config dependencies");
      },
    },
  );
  const runner = createScheduledTurnRunner({
    config: unavailable as RollConfig,
    runtime: unavailable as CreateScheduledTurnRunnerInput["runtime"],
    stopSignal: controller.signal,
  });

  const result = await runner({} as ScheduleRecord, {} as InvocationRecord);

  assert.equal(result.status, "failed");
  assert.match(result.status === "failed" ? result.error : "", /停止请求/u);
});
