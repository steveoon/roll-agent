import assert from "node:assert/strict";
import { fork, spawnSync, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test } from "node:test";
import * as runtime from "@roll-agent/runtime";
import {
  createOwnedThreadStore,
  createSessionOwnershipHost,
  ROLL_SESSION_OCCUPANCY_CAPABILITY,
  createSessionLibraryBinding,
  EXPECTED_SESSION_LIBRARY_ENV,
  SessionLibraryBindingError,
} from "./session-ownership.ts";

function message(child: ChildProcess) {
  return once(child, "message", { signal: AbortSignal.timeout(15_000) }).then(
    ([value]: unknown[]) => {
      if (typeof value !== "object" || value === null || !("event" in value)) {
        throw new Error("Invalid child result");
      }
      return value;
    },
  );
}
async function child(dir: string, id: string, kind: string) {
  const proc = fork(
    fileURLToPath(new URL("./session-ownership.e2e-harness.ts", import.meta.url)),
    [dir, id, kind],
    {
      execArgv: ["--experimental-strip-types", "--experimental-sqlite"],
      stdio: ["ignore", "ignore", "pipe", "ipc"],
    },
  );
  assert.equal((await message(proc)).event, "ready");
  return proc;
}
async function command(proc: ChildProcess, cmd: string) {
  const result = message(proc);
  proc.send(cmd);
  return result;
}
async function finish(proc: ChildProcess, cmd = "close") {
  if (proc.exitCode !== null || proc.signalCode !== null) return;
  const exited = once(proc, "exit", { signal: AbortSignal.timeout(15_000) });
  proc.send(cmd);
  await exited;
}

test("public Core host verifies process identity; unknown and PID reuse are not live matches", () => {
  const host = createSessionOwnershipHost();
  assert.equal(host.probe(host.identity), "alive");
  assert.equal(host.probe("malformed"), "unknown");
  assert.equal(
    host.probe(JSON.stringify({ pid: process.pid, token: `pst-v2:${"0".repeat(64)}` })),
    "dead",
  );
  assert.equal(ROLL_SESSION_OCCUPANCY_CAPABILITY.version, 1);
});

test(
  "real processes simultaneously open one thread: one idle owner, reverse conflict, actual exit/reload",
  { timeout: 60_000 },
  async () => {
    const dir = mkdtempSync(join(tmpdir(), "roll-host-claims-"));
    const setup = createOwnedThreadStore(runtime, dir);
    const id = setup.createThread();
    setup.close();
    const cli = await child(dir, id, "cli");
    const desktop = await child(dir, id, "desktop");
    try {
      const results = await Promise.all([command(cli, "open"), command(desktop, "open")]);
      assert.equal(results.filter((value) => value.event === "opened").length, 1);
      const cliWon = results[0]?.event === "opened";
      const winner = cliWon ? cli : desktop;
      const loser = cliWon ? desktop : cli;
      assert.equal(
        (await command(loser, "open")).event,
        "conflict",
        "idle owner retains claim between inputs",
      );
      const inspect = new runtime.ThreadStore(dir, { readOnly: true });
      assert.equal(inspect.getThread(id)?.title, cliWon ? "cli idle" : "desktop idle");
      inspect.close();
      await finish(winner, "crash"); // No release: Core must prove actual process death and CAS-reclaim.
      const reloaded = await command(loser, "open");
      assert.equal(reloaded.event, "opened");
      assert.ok(
        "messageCount" in reloaded && reloaded.messageCount === 1,
        "resume loaded latest durable messages",
      );
      const reverse = await child(dir, id, cliWon ? "cli" : "desktop");
      try {
        assert.equal((await command(reverse, "open")).event, "conflict");
      } finally {
        await finish(reverse);
      }
      await finish(loser);
      const final = createOwnedThreadStore(runtime, dir);
      assert.equal(final.getThread(id)?.title, cliWon ? "desktop idle" : "cli idle");
      final.close();
    } finally {
      for (const proc of [cli, desktop]) {
        if (proc.exitCode === null && proc.signalCode === null) {
          proc.kill();
          await once(proc, "exit");
        }
      }
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

test(
  "separate processes can own different threads in one library and same ID in different libraries",
  { timeout: 60_000 },
  async () => {
    const dir = mkdtempSync(join(tmpdir(), "roll-host-independent-"));
    const a = join(dir, "a");
    const b = join(dir, "b");
    const first = createOwnedThreadStore(runtime, a);
    const one = first.createThread();
    const two = first.createThread();
    first.close();
    const other = createOwnedThreadStore(runtime, b);
    other.createThread({ id: one });
    other.close();
    const children = await Promise.all([
      child(a, one, "cli"),
      child(a, two, "desktop"),
      child(b, one, "cli"),
    ]);
    try {
      const results = await Promise.all(children.map((proc) => command(proc, "open")));
      assert.deepEqual(
        results.map((value) => value.event),
        ["opened", "opened", "opened"],
      );
    } finally {
      await Promise.all(children.map((proc) => finish(proc)));
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

test("expected-library launch binding rejects changed config, malformed and replaced identity before writes", () => {
  const dir = mkdtempSync(join(tmpdir(), "roll-library-binding-"));
  const selected = join(dir, "pristine", "not-created", "threads");
  const changed = join(dir, "wrong-library");
  const previous = process.env[EXPECTED_SESSION_LIBRARY_ENV];
  try {
    const token = createSessionLibraryBinding(runtime, selected);
    assert.equal(existsSync(join(dir, "pristine")), false, "binding discovery is read-only");
    process.env[EXPECTED_SESSION_LIBRARY_ENV] = token;
    assert.throws(() => createOwnedThreadStore(runtime, changed), SessionLibraryBindingError);
    assert.equal(existsSync(changed), false, "mismatched config must not create B or its sidecar");
    const store = createOwnedThreadStore(runtime, selected);
    store.close();
    assert.throws(
      () => createOwnedThreadStore(runtime, selected),
      SessionLibraryBindingError,
      "missing expectation cannot accept a now-present replacement",
    );
    const present = createSessionLibraryBinding(runtime, selected);
    process.env[EXPECTED_SESSION_LIBRARY_ENV] = present;
    const reopened = createOwnedThreadStore(runtime, selected);
    reopened.close();
    const parsed: unknown = JSON.parse(present);
    assert.ok(typeof parsed === "object" && parsed !== null && "physicalIdentity" in parsed);
    process.env[EXPECTED_SESSION_LIBRARY_ENV] = JSON.stringify({
      ...parsed,
      physicalIdentity: "inode:0:0:0",
    });
    assert.throws(() => createOwnedThreadStore(runtime, selected), SessionLibraryBindingError);
    for (const invalid of [
      "not json",
      "x".repeat(8193),
      JSON.stringify({ version: 1, databasePath: selected, state: "present" }),
    ]) {
      process.env[EXPECTED_SESSION_LIBRARY_ENV] = invalid;
      assert.throws(() => createOwnedThreadStore(runtime, changed), SessionLibraryBindingError);
      assert.equal(existsSync(changed), false);
    }
  } finally {
    if (previous === undefined) delete process.env[EXPECTED_SESSION_LIBRARY_ENV];
    else process.env[EXPECTED_SESSION_LIBRARY_ENV] = previous;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("captured launch binding stays in its host and is absent from nested Roll environments", () => {
  const dir = mkdtempSync(join(tmpdir(), "roll-binding-scope-"));
  const a = join(dir, "a");
  const b = join(dir, "b");
  const moduleUrl = new URL("./session-ownership.ts", import.meta.url).href;
  const runtimeUrl = pathToFileURL(
    fileURLToPath(new URL("../../../runtime/src/index.ts", import.meta.url)),
  ).href;
  const token = createSessionLibraryBinding(runtime, a);
  const script = `import * as runtime from ${JSON.stringify(runtimeUrl)};
import {captureSessionLibraryBinding,createOwnedThreadStore,SessionLibraryBindingError} from ${JSON.stringify(moduleUrl)};
import {spawnSync} from "node:child_process";
captureSessionLibraryBinding();
if(process.env.ROLL_EXPECTED_SESSION_LIBRARY !== undefined) throw new Error("inherited guard");
createOwnedThreadStore(runtime,${JSON.stringify(a)}).close();
createOwnedThreadStore(runtime,${JSON.stringify(a)}).close();
let blocked=false;try{createOwnedThreadStore(runtime,${JSON.stringify(b)});}catch(error){blocked=error instanceof SessionLibraryBindingError;}
if(!blocked)throw new Error("original host lost binding");
const child = spawnSync(process.execPath,["--experimental-strip-types","--experimental-sqlite","--input-type=module","-e",${JSON.stringify(`import * as runtime from ${JSON.stringify(runtimeUrl)}; import {createOwnedThreadStore} from ${JSON.stringify(moduleUrl)}; if(process.env.ROLL_EXPECTED_SESSION_LIBRARY!==undefined)throw new Error("inherited guard"); createOwnedThreadStore(runtime,${JSON.stringify(b)}).close();`)}],{env:process.env,encoding:"utf8"});
if(child.status!==0)throw new Error(child.stderr);
`;
  try {
    const result = spawnSync(
      process.execPath,
      ["--experimental-strip-types", "--experimental-sqlite", "--input-type=module", "-e", script],
      {
        env: { ...process.env, [EXPECTED_SESSION_LIBRARY_ENV]: token },
        encoding: "utf8",
        timeout: 30_000,
      },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.equal(existsSync(join(a, "threads.db")), true);
    assert.equal(existsSync(join(b, "threads.db")), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
