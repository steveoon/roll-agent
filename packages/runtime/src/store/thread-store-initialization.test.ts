import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { Worker } from "node:worker_threads";
import type { SessionOwnershipHost } from "../host-contracts/session-ownership.ts";
import {
  ThreadStore,
  inspectThreadLibrary,
  ThreadLibraryMigrationRequiredError,
} from "./thread-store.ts";

function host(identity: string): SessionOwnershipHost {
  return { identity, owner: { kind: "test", label: identity }, probe: () => "alive" };
}

test(
  "coordinated open waits for a concurrent first schema commit before preflight",
  { timeout: 20000 },
  async () => {
    const dir = mkdtempSync(join(tmpdir(), "roll-library-initialization-"));
    const moduleUrl = new URL("./thread-store.ts", import.meta.url).href;
    const script = `
    import {parentPort,workerData} from 'node:worker_threads';
    import {ThreadStore} from ${JSON.stringify(moduleUrl)};
    const store=new ThreadStore(workerData.dir,{
      ownership:{identity:'initializer',owner:{kind:'test',label:'initializer'},probe:()=> 'alive'},
      now:()=>{
        parentPort.postMessage('initializing');
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,2000);
        return new Date();
      },
    });
    store.close();
  `;
    const initializer = new Worker(new URL(`data:text/javascript,${encodeURIComponent(script)}`), {
      workerData: { dir },
      execArgv: ["--experimental-strip-types", "--experimental-sqlite"],
    });
    try {
      const [message] = await once(initializer, "message");
      assert.equal(message, "initializing");
      assert.equal(inspectThreadLibrary(dir).schemaVersion, 0);
      const store = new ThreadStore(dir, { ownership: host("second") });
      try {
        const id = store.createThread({ title: "concurrent opener" });
        assert.equal(store.getThread(id)?.title, "concurrent opener");
        assert.equal(inspectThreadLibrary(dir).status, "current");
      } finally {
        store.close();
      }
    } finally {
      await initializer.terminate();
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

test("coordinated open still refuses existing v0 evidence without changing it", () => {
  const dir = mkdtempSync(join(tmpdir(), "roll-existing-v0-"));
  try {
    const path = join(dir, "threads.db");
    const db = new DatabaseSync(path);
    db.exec("CREATE TABLE evidence (value TEXT); INSERT INTO evidence VALUES ('preserve');");
    db.close();
    const before = readFileSync(path);
    assert.throws(
      () => new ThreadStore(dir, { ownership: host("reader") }),
      ThreadLibraryMigrationRequiredError,
    );
    assert.deepEqual(readFileSync(path), before);
    assert.equal(inspectThreadLibrary(dir).status, "needs_migration");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("opening a current library preserves a live sibling claim", () => {
  const dir = mkdtempSync(join(tmpdir(), "roll-open-sibling-"));
  const first = new ThreadStore(dir, { ownership: host("first") });
  const id = first.createThread();
  const held = first.retainThread(id);
  try {
    const second = new ThreadStore(dir, { ownership: host("second") });
    try {
      held?.assert();
      assert.equal(second.getThread(id)?.id, id);
      const other = second.createThread();
      assert.equal(second.getThread(other)?.id, other);
    } finally {
      second.close();
    }
  } finally {
    held?.release();
    first.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
