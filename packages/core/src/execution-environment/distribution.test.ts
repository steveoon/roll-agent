import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { createServer } from "node:http";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  rm,
  symlink,
  access,
  readdir,
  watch,
  rename,
  chmod,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { resolveExecutionEnvironment } from "./index.ts";
import {
  distributionManifestSchema,
  selectDistributionAsset,
  fetchDistributionManifest,
  downloadDistributionAsset,
  validateArchiveEntry,
  extractDistributionArchive,
  prepareDistributionUpdate,
  acquireDistributionLock,
  smokeDistribution,
  retryWindowsFileOperation,
  validateDistributionTree,
  type DistributionManifest,
  DistributionDownloadTimeoutError,
  DistributionDownloadNetworkError,
} from "./distribution.ts";
import type { DistributionUpdateEvent } from "./distribution-progress.ts";

const platform = `${process.platform}-${process.arch}`;

test("Windows sharing failures retry with a bounded budget; other errors fail immediately", async () => {
  for (const code of ["EPERM", "EACCES", "EBUSY"]) {
    let attempts = 0;
    const waits: number[] = [];
    await retryWindowsFileOperation(
      async () => {
        if (++attempts < 3) throw Object.assign(new Error("busy"), { code });
      },
      {
        platform: "win32",
        wait: async (ms) => {
          waits.push(ms);
        },
      },
    );
    assert.equal(attempts, 3);
    assert.deepEqual(waits, [250, 500]);
  }
  for (const [platform, code, expected] of [
    ["win32", "EPERM", 7],
    ["win32", "ENOENT", 1],
    ["darwin", "EPERM", 1],
  ] as const) {
    let attempts = 0;
    let totalWait = 0;
    const failure = Object.assign(new Error("persistent failure"), { code });
    await assert.rejects(
      retryWindowsFileOperation(
        async () => {
          attempts++;
          throw failure;
        },
        {
          platform,
          wait: async (ms) => {
            totalWait += ms;
          },
        },
      ),
      (error) => error === failure,
    );
    assert.equal(attempts, expected);
    assert.ok(totalWait <= 7750);
  }
});

test(
  "extracted tree validation checks types without reading contents",
  { skip: process.platform === "win32" },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), "roll-tree-check-"));
    const file = join(root, "content");
    t.after(() => rm(root, { recursive: true, force: true }));
    await writeFile(file, "content already covered by the archive checksum");
    await chmod(file, 0);
    await validateDistributionTree(root);
    await chmod(file, 0o600);
    await symlink(file, join(root, "link"));
    await assert.rejects(validateDistributionTree(root), /symbolic link/);
    await rm(join(root, "link"));
    execFileSync("mkfifo", [join(root, "pipe")]);
    await assert.rejects(validateDistributionTree(root), /special file/);
    await assert.rejects(validateDistributionTree(root, AbortSignal.abort()), /aborted/i);
  },
);

test(
  "aborted preflight waits for the Node child to close before returning",
  { skip: process.platform === "win32", timeout: 10_000 },
  async () => {
    const root = await mkdtemp(join(tmpdir(), "roll-preflight-stop-"));
    const controller = new AbortController();
    try {
      await mkdir(join(root, "app/bin"), { recursive: true });
      await mkdir(join(root, "home"));
      await writeFile(
        join(root, "distribution.json"),
        JSON.stringify({ nodeVersion: process.versions.node }),
      );
      const started = join(root, "started");
      const stopped = join(root, "stopped");
      await writeFile(
        join(root, "app/bin/roll.js"),
        `
const fs=require('node:fs');
process.on('SIGTERM',()=>setTimeout(()=>{fs.writeFileSync(${JSON.stringify(stopped)},'closed');process.exit(0);},150));
fs.writeFileSync(${JSON.stringify(started)},'ready');
setInterval(()=>{},1000);
`,
      );
      const events = watch(root);
      const host = resolveExecutionEnvironment();
      const pending = smokeDistribution(
        {
          ...host,
          installation: { ...host.installation, packageRoot: join(root, "app"), versionRoot: root },
        },
        join(root, "home"),
        controller.signal,
      );
      const rejected = assert.rejects(pending, /aborted/i);
      for await (const event of events) {
        if (event.filename === "started") break;
      }
      controller.abort();
      await rejected;
      assert.equal(await readFile(stopped, "utf8"), "closed");
    } finally {
      controller.abort();
      await rm(root, { recursive: true, force: true });
    }
  },
);

test("installation lock records its owner and refuses to remove replacement ownership", async () => {
  const root = await mkdtemp(join(tmpdir(), "roll-lock-owner-"));
  try {
    const release = await acquireDistributionLock(root);
    const ownerPath = join(root, ".install-lock/owner.json");
    const owner = JSON.parse(await readFile(ownerPath, "utf8")) as {
      pid: number;
      startedAt: string;
      token: string;
    };
    assert.equal(owner.pid, process.pid);
    assert.ok(Number.isFinite(Date.parse(owner.startedAt)));
    await writeFile(ownerPath, JSON.stringify({ ...owner, token: "replacement-owner" }));
    await assert.rejects(release(), /ownership changed/);
    assert.equal(JSON.parse(await readFile(ownerPath, "utf8")).token, "replacement-owner");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  test(
    `interrupted download (${signal}) closes the stream and releases its scratch and lock`,
    { skip: process.platform === "win32", timeout: 10_000 },
    async () => {
      const home = await mkdtemp(join(tmpdir(), "roll-interrupt-"));
      let child: ReturnType<typeof spawn> | undefined;
      try {
        const old = join(home, "versions/1.0.0");
        await fixtureVersion(old, "1.0.0");
        await writeFile(
          join(home, "installation.json"),
          '{"schemaVersion":1,"channel":"standalone"}',
        );
        await writeFile(join(home, "current.txt"), "1.0.0\n");
        const entry = join(home, "interrupt.mjs");
        await writeFile(
          entry,
          `
import {createServer} from 'node:http';
import {resolveExecutionEnvironment} from ${JSON.stringify(new URL("./index.ts", import.meta.url).href)};
import {prepareDistributionUpdate} from ${JSON.stringify(new URL("./distribution.ts", import.meta.url).href)};
const server=createServer((req,res)=>{ res.write('x'); process.stdout.write('downloading\\n'); });
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
try {
  await prepareDistributionUpdate(resolveExecutionEnvironment({packageRoot:${JSON.stringify(join(old, "app"))}}),${JSON.stringify(manifestFor(Buffer.alloc(1024)))},{fetch:(_url,options)=>fetch('http://127.0.0.1:'+server.address().port,options)});
} catch(error) { console.error(error); process.exitCode=error.exitCode ?? 1; }
finally { server.closeAllConnections(); server.close(); }
`,
        );
        child = spawn(process.execPath, ["--experimental-strip-types", entry], {
          stdio: ["ignore", "pipe", "pipe"],
        });
        let stderr = "";
        child.stderr!.on("data", (data) => {
          stderr += data;
        });
        const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
          (resolve, reject) => {
            child!.on("error", reject);
            child!.on("close", (code, signal) => resolve({ code, signal }));
          },
        );
        await new Promise<void>((resolve, reject) => {
          child!.stdout!.once("data", () => resolve());
          child!.once("error", reject);
          child!.once("exit", () =>
            reject(new Error(`Child exited before downloading: ${stderr}`)),
          );
        });
        child.kill(signal);
        const result = await closed;
        assert.equal(result.code, signal === "SIGINT" ? 130 : 143);
        assert.equal(await readFile(join(home, "current.txt"), "utf8"), "1.0.0\n");
        assert.equal(
          (await readdir(home)).some(
            (name) => name === ".install-lock" || name.startsWith(".update-"),
          ),
          false,
        );
        const release = await acquireDistributionLock(home);
        await release();
      } finally {
        child?.kill("SIGKILL");
        await rm(home, { recursive: true, force: true });
      }
    },
  );
}
function manifestFor(bytes: Uint8Array, version = "1.0.1"): DistributionManifest {
  return distributionManifestSchema.parse({
    schemaVersion: 1,
    version,
    nodeVersion: "24.18.0",
    assets: [
      {
        platform,
        filename: `roll-${version}-${platform}.${process.platform === "win32" ? "zip" : "tar.gz"}`,
        sha256: createHash("sha256").update(bytes).digest("hex"),
        size: bytes.length,
      },
    ],
  });
}
test("manifest only admits canonical immutable filenames and unique platforms", () => {
  const manifest = manifestFor(Buffer.from("archive"));
  assert.throws(() => distributionManifestSchema.parse({ ...manifest, version: "../../escape" }));
  assert.throws(() =>
    distributionManifestSchema.parse({
      ...manifest,
      assets: [manifest.assets[0], manifest.assets[0]],
    }),
  );
  assert.throws(() =>
    distributionManifestSchema.parse({
      ...manifest,
      assets: [{ ...manifest.assets[0], filename: "https://other.test/a" }],
    }),
  );
  assert.throws(() => selectDistributionAsset(manifest, "linux-s390x"));
});
test("manifest fetch uses fixed HTTPS origin, refuses redirects and enforces version identity", async () => {
  const manifest = manifestFor(Buffer.from("archive"));
  const fetch: typeof globalThis.fetch = async (url, options) => {
    assert.equal(String(url), "https://roll.duliday.com/releases/1.0.1/manifest.json");
    assert.equal(options?.redirect, "error");
    return new Response(JSON.stringify(manifest));
  };
  assert.deepEqual(await fetchDistributionManifest({ version: "1.0.1", fetch }), manifest);
  await assert.rejects(
    fetchDistributionManifest({ fetch: async () => new Response("x".repeat(70_000)) }),
    /size limit/,
  );
  await assert.rejects(
    fetchDistributionManifest({
      version: "1.0.2",
      fetch: async () => new Response(JSON.stringify(manifest)),
    }),
    /version mismatch/,
  );
});
test("streaming download rejects corrupt or oversized archives", async () => {
  const home = await mkdtemp(join(tmpdir(), "roll-download-"));
  try {
    const bytes = Buffer.from("archive");
    const manifest = manifestFor(bytes);
    const asset = manifest.assets[0]!;
    await downloadDistributionAsset(manifest, asset, join(home, "good"), {
      fetch: async (url, init) => {
        assert.equal(
          String(url),
          `https://roll.duliday.com/releases/${manifest.version}/${asset.filename}`,
        );
        assert.equal(init?.redirect, "error");
        return new Response(new Uint8Array(bytes));
      },
    });
    assert.deepEqual(await readFile(join(home, "good")), bytes);
    await assert.rejects(
      downloadDistributionAsset(manifest, asset, join(home, "bad"), {
        fetch: async () => new Response("corrupt"),
      }),
      /checksum/,
    );
    await assert.rejects(
      downloadDistributionAsset(manifest, asset, join(home, "large"), {
        fetch: async () => new Response("archive plus more"),
      }),
      /size mismatch/,
    );
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("native fetch body abort is diagnosed as a download timeout with partial byte counts", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "roll-native-timeout-"));
  const server = createServer((_request, response) => response.write("arc"));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(home, { recursive: true, force: true });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const manifest = manifestFor(Buffer.from("archive"));
  const destination = join(home, "archive");
  await assert.rejects(
    downloadDistributionAsset(manifest, manifest.assets[0]!, destination, {
      timeoutMs: 2000,
      fetch: (_url, options) => fetch("http://127.0.0.1:" + address.port, options),
    }),
    (error: unknown) => {
      assert.ok(error instanceof DistributionDownloadTimeoutError);
      assert.equal(error.progress.downloadedBytes, 3);
      assert.equal(error.progress.totalBytes, 7);
      assert.ok(error.progress.elapsedMs >= 2000);
      return true;
    },
  );
  assert.equal(await readFile(destination, "utf8"), "arc");
});

test("native fetch connection loss retains partial byte counts and its transport cause", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "roll-native-disconnect-"));
  let disconnect: (() => void) | undefined;
  const server = createServer((_request, response) => {
    response.write("arc");
    disconnect = () => response.destroy();
  });
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(home, { recursive: true, force: true });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const manifest = manifestFor(Buffer.from("archive"));
  await assert.rejects(
    downloadDistributionAsset(manifest, manifest.assets[0]!, join(home, "archive"), {
      timeoutMs: 10_000,
      fetch: (_url, options) => fetch("http://127.0.0.1:" + address.port, options),
      onEvent: (event) => {
        if (event.phase === "download" && event.progress.downloadedBytes === 3) {
          assert.ok(disconnect);
          disconnect();
        }
      },
    }),
    (error: unknown) => {
      assert.ok(error instanceof DistributionDownloadNetworkError);
      assert.equal(error.progress.downloadedBytes, 3);
      assert.equal(error.progress.totalBytes, 7);
      assert.ok(error.cause instanceof TypeError);
      assert.equal(error.cause.message, "terminated");
      assert.ok(error.cause.cause instanceof Error);
      assert.match(error.cause.cause.message, /other side closed/);
      return true;
    },
  );
});

test("fetch and body transport timeouts carry progress without becoming the total deadline error", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "roll-transport-timeout-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const manifest = manifestFor(Buffer.from("archive"));
  for (const body of [false, true]) {
    const cause = Object.assign(new Error(body ? "Body Timeout Error" : "Headers Timeout Error"), {
      code: body ? "UND_ERR_BODY_TIMEOUT" : "UND_ERR_HEADERS_TIMEOUT",
    });
    const original = new TypeError(body ? "terminated" : "fetch failed", { cause });
    await assert.rejects(
      downloadDistributionAsset(manifest, manifest.assets[0]!, join(home, String(body)), {
        fetch: async () => {
          if (!body) throw original;
          let sent = false;
          return new Response(
            new ReadableStream<Uint8Array>({
              pull(controller) {
                if (!sent) {
                  sent = true;
                  controller.enqueue(Buffer.from("arc"));
                } else controller.error(original);
              },
            }),
          );
        },
      }),
      (error: unknown) => {
        assert.ok(error instanceof DistributionDownloadNetworkError);
        assert.equal(error.cause, original);
        assert.equal(error.progress.downloadedBytes, body ? 3 : 0);
        assert.equal(error.progress.totalBytes, 7);
        return true;
      },
    );
  }
});

test("abort, filesystem and observer failures are not relabeled as network errors", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "roll-download-error-identity-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const bytes = Buffer.from("archive");
  const manifest = manifestFor(bytes);
  const aborted = new DOMException("cancelled", "AbortError");
  await assert.rejects(
    downloadDistributionAsset(manifest, manifest.assets[0]!, join(home, "abort"), {
      fetch: async () => {
        throw aborted;
      },
    }),
    (error: unknown) => error === aborted,
  );
  await assert.rejects(
    downloadDistributionAsset(manifest, manifest.assets[0]!, join(home, "missing/archive"), {
      fetch: async () => new Response(bytes),
    }),
    (error: unknown) => {
      assert.ok(error instanceof Error && "code" in error && error.code === "ENOENT");
      assert.equal(error instanceof DistributionDownloadNetworkError, false);
      return true;
    },
  );
  const observer = new Error("observer failed");
  await assert.rejects(
    downloadDistributionAsset(manifest, manifest.assets[0]!, join(home, "observer"), {
      fetch: async () => new Response(bytes),
      onEvent: (event) => {
        if (event.phase === "download" && event.progress.downloadedBytes > 0) throw observer;
      },
    }),
    (error: unknown) => error === observer,
  );
});

test("default archive deadline permits a slow download beyond the old 120 seconds", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
  t.mock.method(performance, "now", () => Date.now());
  const deadlines: number[] = [];
  t.mock.method(AbortSignal, "timeout", (ms: number) => {
    deadlines.push(ms);
    const controller = new AbortController();
    setTimeout(() => controller.abort(new DOMException("timeout", "TimeoutError")), ms);
    return controller.signal;
  });
  const home = await mkdtemp(join(tmpdir(), "roll-slow-download-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const bytes = Buffer.from("archive");
  const manifest = manifestFor(bytes);
  const events: DistributionUpdateEvent[] = [];
  const halfway = Promise.withResolvers<void>();
  const stream = new TransformStream<Uint8Array, Uint8Array>();
  const writer = stream.writable.getWriter();
  const pending = downloadDistributionAsset(manifest, manifest.assets[0]!, join(home, "archive"), {
    fetch: async () => new Response(stream.readable),
    onEvent: (event) => {
      events.push(event);
      if (event.phase === "download" && event.progress.downloadedBytes > 0) halfway.resolve();
    },
  });
  await writer.write(bytes.subarray(0, 3));
  await halfway.promise;
  t.mock.timers.tick(120_001);
  await writer.write(bytes.subarray(3));
  await writer.close();
  await pending;
  assert.deepEqual(deadlines, [900_000]);
  assert.deepEqual(await readFile(join(home, "archive")), bytes);
  assert.equal(events[0]?.phase, "download");
  assert.equal(events.at(-1)?.phase, "verify");
  const completed = events.at(-2);
  assert.equal(completed?.phase, "download");
  if (completed?.phase === "download") {
    assert.equal(completed.progress.downloadedBytes, bytes.length);
    assert.equal(completed.progress.elapsedMs, 120_001);
  }
});

test("download timeout reports partial bytes and removes scratch without changing the old version", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
  t.mock.method(performance, "now", () => Date.now());
  t.mock.method(AbortSignal, "timeout", (ms: number) => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(new DOMException("timeout", "TimeoutError")), ms);
    return controller.signal;
  });
  const home = await mkdtemp(join(tmpdir(), "roll-timeout-cleanup-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const old = join(home, "versions/1.0.0");
  await fixtureVersion(old, "1.0.0");
  await writeFile(join(home, "installation.json"), '{"schemaVersion":1,"channel":"standalone"}');
  await writeFile(join(home, "current.txt"), "1.0.0\n");
  const halfway = Promise.withResolvers<void>();
  const events: DistributionUpdateEvent[] = [];
  const pending = prepareDistributionUpdate(
    resolveExecutionEnvironment({ packageRoot: join(old, "app") }),
    manifestFor(Buffer.from("archive")),
    {
      timeoutMs: 10_000,
      fetch: async (_url, options) =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(Buffer.from("arc"));
              options?.signal?.addEventListener(
                "abort",
                () => controller.error(options.signal?.reason),
                { once: true },
              );
            },
          }),
        ),
      onEvent: (event) => {
        events.push(event);
        if (event.phase === "download" && event.progress.downloadedBytes > 0) halfway.resolve();
      },
    },
  );
  const rejected = assert.rejects(pending, (error: unknown) => {
    assert.ok(error instanceof DistributionDownloadTimeoutError);
    assert.equal(error.timeoutMs, 10_000);
    assert.deepEqual(error.progress, { downloadedBytes: 3, totalBytes: 7, elapsedMs: 10_000 });
    return true;
  });
  await halfway.promise;
  t.mock.timers.tick(10_000);
  await rejected;
  assert.equal(await readFile(join(home, "current.txt"), "utf8"), "1.0.0\n");
  assert.equal(
    (await readdir(home)).some((name) => name === ".install-lock" || name.startsWith(".update-")),
    false,
  );
  assert.equal(
    events.some((event) => event.phase !== "download"),
    false,
  );
  const release = await acquireDistributionLock(home);
  await release();
});
test("archive entry validation rejects traversal, unexpected roots and Windows paths", () => {
  for (const name of [
    "../escape",
    "app/../../escape",
    "/app/a",
    "C:/app",
    "app\\a",
    "app/a\nb",
    "other/file",
  ]) {
    assert.throws(() => validateArchiveEntry(name), name);
  }
  for (const name of ["./", "app/", "./app/bin/roll.js", "runtime/bin/node", "distribution.json"]) {
    validateArchiveEntry(name);
  }
});
test(
  "archive links are rejected before extraction",
  { skip: process.platform === "win32" },
  async () => {
    const home = await mkdtemp(join(tmpdir(), "roll-link-"));
    try {
      await mkdir(join(home, "source/app"), { recursive: true });
      await symlink("../../outside", join(home, "source/app/escape"));
      const archive = join(home, "bad.tar.gz");
      execFileSync("tar", ["-czf", archive, "-C", join(home, "source"), "app"]);
      await mkdir(join(home, "out"));
      await assert.rejects(
        extractDistributionArchive(archive, join(home, "out"), platform),
        /links/,
      );
      await assert.rejects(access(join(home, "out/app")));
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  },
);

async function fixtureVersion(root: string, version: string): Promise<void> {
  const npm =
    process.platform === "win32"
      ? "runtime/node_modules/npm/bin"
      : "runtime/lib/node_modules/npm/bin";
  await mkdir(join(root, npm), { recursive: true });
  await mkdir(join(root, "runtime/bin"), { recursive: true });
  await mkdir(join(root, "app/bin"), { recursive: true });
  await writeFile(
    join(root, process.platform === "win32" ? "runtime/node.exe" : "runtime/bin/node"),
    "fixture",
    { mode: 0o755 },
  );
  await writeFile(join(root, npm, "npm-cli.js"), "");
  await writeFile(join(root, npm, "npx-cli.js"), "");
  for (const tool of ["npm", "npx"]) {
    await writeFile(
      join(root, process.platform === "win32" ? `runtime/${tool}.cmd` : `runtime/bin/${tool}`),
      "fixture",
      { mode: 0o755 },
    );
  }
  await writeFile(
    join(root, "app/package.json"),
    JSON.stringify({
      name: "@roll-agent/core",
      version,
      rollDistribution: { schemaVersion: 1, channel: "standalone" },
    }),
  );
  await writeFile(
    join(root, "distribution.json"),
    JSON.stringify({
      schemaVersion: 1,
      channel: "standalone",
      version,
      platform,
      nodeVersion: "24.18.0",
    }),
  );
}
test(
  "prepare is non-activating, shared lock excludes installers, activation uses target environment",
  { skip: process.platform === "win32" },
  async () => {
    const home = await mkdtemp(join(tmpdir(), "roll update 中文 "));
    try {
      const old = join(home, "versions/1.0.0");
      await fixtureVersion(old, "1.0.0");
      await writeFile(
        join(home, "installation.json"),
        '{"schemaVersion":1,"channel":"standalone"}',
      );
      await writeFile(join(home, "current.txt"), "1.0.0\n");
      const candidate = join(home, "fixture");
      await fixtureVersion(candidate, "1.0.1");
      const archive = join(home, "fixture.tar.gz");
      execFileSync("tar", [
        "-czf",
        archive,
        "-C",
        candidate,
        "app",
        "runtime",
        "distribution.json",
      ]);
      const bytes = await readFile(archive);
      const environment = resolveExecutionEnvironment({ packageRoot: join(old, "app") });
      let smoked = false;
      const events: DistributionUpdateEvent[] = [];
      let failure: "candidate" | "pointer" = "candidate";
      let prepared = await prepareDistributionUpdate(environment, manifestFor(bytes), {
        fetch: async () => new Response(new Uint8Array(bytes)),
        onEvent: (event) => events.push(event),
        smoke: async (env) => {
          smoked = true;
          assert.equal(env.installation.version, "1.0.1");
        },
        rename: async (source, target) => {
          if (failure === "candidate" || String(target).endsWith("current.txt")) {
            throw Object.assign(new Error(`${failure} still in use`), { code: "EPERM" });
          }
          await rename(source, target);
        },
      });
      try {
        assert.equal(smoked, true);
        assert.deepEqual(
          events.filter((event) => event.phase !== "download").map((event) => event.phase),
          ["verify", "extract", "check"],
        );
        assert.equal(await readFile(join(home, "current.txt"), "utf8"), "1.0.0\n");
        await assert.rejects(acquireDistributionLock(home), /Another Roll/);
        await assert.rejects(prepared.activate(), /Cannot activate Roll.*candidate still in use/);
        assert.equal(await readFile(join(home, "current.txt"), "utf8"), "1.0.0\n");
        await assert.rejects(access(join(home, "versions/1.0.1")));
        failure = "pointer";
        await assert.rejects(prepared.activate(), /pointer still in use/);
        assert.equal(await readFile(join(home, "current.txt"), "utf8"), "1.0.0\n");
        await access(join(home, "versions/1.0.1"));
        await prepared.dispose();
        prepared = await prepareDistributionUpdate(environment, manifestFor(bytes), {
          fetch: async () => new Response(new Uint8Array(bytes)),
          smoke: async () => {},
        });
        const changed = join(home, "versions/1.0.1/app/changed");
        await writeFile(changed, "different immutable contents");
        await assert.rejects(prepared.activate(), /different immutable/);
        assert.equal(await readFile(join(home, "current.txt"), "utf8"), "1.0.0\n");
        await rm(changed);
        const next = await prepared.activate();
        assert.equal(next.installation.version, "1.0.1");
        assert.match(next.nodePath, /versions\/1\.0\.1\/runtime\/bin\/node$/);
        assert.equal(await readFile(join(home, "current.txt"), "utf8"), "1.0.1\n");
        assert.equal((await prepared.activate()).nodePath, next.nodePath);
      } finally {
        await prepared.dispose();
      }
      const release = await acquireDistributionLock(home);
      await release();
      await assert.rejects(
        prepareDistributionUpdate(environment, manifestFor(bytes)),
        /not the current/,
      );
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  },
);
