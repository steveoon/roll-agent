import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  parseLatestRuntimeMethodParams,
  parseLatestRuntimeMethodResult,
  type RuntimeProtocolVersion,
} from "@roll-agent/protocol";
import type { SessionOwnershipHost } from "../host-contracts/session-ownership.ts";
import { SessionOccupiedError } from "../ownership/session-claims.ts";
import { RuntimeClientRequestCoordinator } from "../server/runtime-client-request-coordinator.ts";
import { RuntimeProtocolAdapter } from "../server/runtime-protocol-adapter.ts";
import type { JsonRpcConnection } from "../server/protocol.ts";
import { ThreadStore } from "../store/thread-store.ts";
import {
  RuntimeService,
  RuntimeServiceError,
  type RuntimeServiceEngine,
} from "./runtime-service.ts";

function host(identity: string): SessionOwnershipHost {
  return {
    identity,
    owner: { kind: "test", label: identity },
    probe: () => "alive",
  };
}

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "roll-browse-service-"));
  const peer = new ThreadStore(dir, { ownership: host("Desktop") });
  const a = peer.createThread({ workspace: "/project/a", title: "Project A" });
  const b = peer.createThread({ workspace: "/project/b", title: "Project B" });
  const legacy = peer.createThread({ title: "Unclassified" });
  peer.appendMessages(a, [{ role: "user", content: "committed history" }]);
  peer.createThread({
    workspace: "/project/a",
    origin: {
      kind: "scheduled",
      scheduleId: "schedule",
      invocationId: "invocation",
      attempt: 1,
      name: "Scheduled execution",
      cwd: "/project/a",
      scheduledFor: new Date(0).toISOString(),
      ledgerDir: dir,
    },
  });
  const claim = peer.retainThread(a);
  assert.ok(claim);
  const store = new ThreadStore(dir, { readOnly: true, ownershipProbe: host("reader") });
  let engineCalls = 0;
  const engine: RuntimeServiceEngine = {
    async createSession() {
      engineCalls++;
      throw new Error("Browsing must never create an execution session");
    },
    async resumeSession() {
      engineCalls++;
      throw new Error("Browsing must never restore an execution session");
    },
  };
  const service = new RuntimeService(engine, store);
  return {
    a,
    b,
    legacy,
    dir,
    store,
    service,
    peer,
    claim,
    engineCalls: () => engineCalls,
    async close() {
      await service.close();
      store.close();
      claim.release();
      peer.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

const connection: JsonRpcConnection = {
  send() {},
  onMessage() {},
  onClose() {},
  close() {},
};

test("browse filters interactive history before pagination and leaves frozen list unchanged", async () => {
  const f = fixture();
  try {
    const current = f.service.browseThreads(
      parseLatestRuntimeMethodParams("thread.browse", { workspace: "/project/a" }),
    );
    assert.deepEqual(
      current.items.map((item) => item.thread.id),
      [f.a],
    );
    assert.equal(current.items[0]?.workspace, "/project/a");
    assert.deepEqual(current.items[0]?.occupancy, {
      status: "occupied",
      owner: { kind: "test", label: "Desktop" },
    });
    assert.equal(current.nextCursor, null);
    const unclassified = f.service.browseThreads(
      parseLatestRuntimeMethodParams("thread.browse", { workspace: null }),
    );
    assert.deepEqual(
      unclassified.items.map((item) => item.thread.id),
      [f.legacy],
    );
    const first = f.service.browseThreads(
      parseLatestRuntimeMethodParams("thread.browse", { limit: 1 }),
    );
    assert.equal(first.nextCursor, "1");
    const rest = f.service.browseThreads(
      parseLatestRuntimeMethodParams("thread.browse", { cursor: first.nextCursor }),
    );
    assert.deepEqual(
      new Set([...first.items, ...rest.items].map((item) => item.thread.id)),
      new Set([f.a, f.b, f.legacy]),
    );
    assert.equal(rest.nextCursor, null);
    assert.deepEqual(
      f.service.browseThreads(
        parseLatestRuntimeMethodParams("thread.browse", { workspace: "/project/missing" }),
      ),
      { items: [], nextCursor: null },
    );
    const original = f.service.listThreads({ limit: 100 });
    assert.equal(original.items.length, 3);
    for (const thread of original.items) {
      assert.equal("workspace" in thread, false);
      assert.equal("occupancy" in thread, false);
    }
    assert.throws(
      () =>
        f.service.browseThreads(
          parseLatestRuntimeMethodParams("thread.browse", { cursor: "9007199254740992" }),
        ),
      /安全整数/,
    );
    assert.equal(f.engineCalls(), 0);
  } finally {
    await f.close();
  }
});

test("Protocol browsing and snapshot read a live peer's committed state without taking its lease", async () => {
  const f = fixture();
  const adapter = new RuntimeProtocolAdapter(
    f.service,
    connection,
    new RuntimeClientRequestCoordinator(),
  );
  try {
    const beforeFiles = readdirSync(f.dir).sort();
    const sidecar = join(f.dir, "threads.db.occupancy.sqlite");
    const beforeClaims = readFileSync(sidecar);
    await assert.rejects(
      adapter.dispatch({ jsonrpc: "2.0", id: 1, method: "thread.browse", params: {} }),
      /initialize/,
    );
    await adapter.dispatch({
      jsonrpc: "2.0",
      id: 2,
      method: "initialize",
      params: { protocolVersions: ["1.6"], client: { name: "browser", version: "1" } },
    });
    const response = await adapter.dispatch({
      jsonrpc: "2.0",
      id: 3,
      method: "thread.browse",
      params: { workspace: "/project/a", limit: 1 },
    });
    const browsed = parseLatestRuntimeMethodResult("thread.browse", response.result);
    assert.equal(browsed.items[0]?.thread.id, f.a);
    assert.equal(browsed.items[0]?.occupancy.status, "occupied");
    const snapshot = await adapter.dispatch({
      jsonrpc: "2.0",
      id: 4,
      method: "thread.snapshot",
      params: { threadId: f.a, limit: 100 },
    });
    const projected = parseLatestRuntimeMethodResult("thread.snapshot", snapshot.result);
    assert.equal(projected.thread.id, f.a);
    assert.equal(projected.messages.items[0]?.parts[0]?.type, "text");
    assert.equal(f.engineCalls(), 0);
    f.claim.assert();
    const contender = new ThreadStore(f.dir, { ownership: host("other terminal") });
    try {
      assert.throws(() => contender.retainThread(f.a), SessionOccupiedError);
    } finally {
      contender.close();
    }
    assert.deepEqual(readFileSync(sidecar), beforeClaims);
    assert.deepEqual(readdirSync(f.dir).sort(), beforeFiles);
  } finally {
    await adapter.close();
    await f.close();
  }
});

for (const version of [
  "1.0",
  "1.1",
  "1.2",
  "1.3",
  "1.4",
  "1.5",
] as const satisfies readonly RuntimeProtocolVersion[]) {
  test(`Protocol ${version} rejects the optional browsing method without touching execution`, async () => {
    const f = fixture();
    const adapter = new RuntimeProtocolAdapter(
      f.service,
      connection,
      new RuntimeClientRequestCoordinator(),
    );
    try {
      await adapter.dispatch({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersions: [version], client: { name: "legacy", version: "1" } },
      });
      await assert.rejects(
        adapter.dispatch({ jsonrpc: "2.0", id: 2, method: "thread.browse", params: {} }),
        (error: unknown) =>
          error instanceof RuntimeServiceError && /不支持方法/.test(error.message),
      );
      assert.equal(f.engineCalls(), 0);
      f.claim.assert();
    } finally {
      await adapter.close();
      await f.close();
    }
  });
}
