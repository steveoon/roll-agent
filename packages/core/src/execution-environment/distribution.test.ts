import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
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
  type DistributionManifest,
} from "./distribution.ts";

const platform = `${process.platform}-${process.arch}`;

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
      const prepared = await prepareDistributionUpdate(environment, manifestFor(bytes), {
        fetch: async () => new Response(new Uint8Array(bytes)),
        smoke: async (env) => {
          smoked = true;
          assert.equal(env.installation.version, "1.0.1");
        },
      });
      try {
        assert.equal(smoked, true);
        assert.equal(await readFile(join(home, "current.txt"), "utf8"), "1.0.0\n");
        await assert.rejects(acquireDistributionLock(home), /Another Roll/);
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
