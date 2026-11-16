import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { setTimeout } from "node:timers/promises";
import { mkdir, mkdtemp, readFile, readlink, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { assetFilename, PLATFORMS, sha256, writeManifest } from "./metadata.mjs";

test(
  "upload and finalization use the configured root and require a provisioned marker",
  { skip: process.platform !== "linux" },
  async (t) => {
    const home = await mkdtemp(join(tmpdir(), "roll-transport-"));
    t.after(() => rm(home, { recursive: true, force: true }));
    const root = join(home, "target");
    const assets = join(home, "assets");
    const bin = join(home, "bin");
    await mkdir(join(root, "staging"), { recursive: true });
    await mkdir(join(root, "releases"));
    await mkdir(assets);
    await mkdir(bin);
    for (const platform of PLATFORMS) {
      await writeFile(join(assets, assetFilename("1.2.3", platform)), platform);
    }
    await writeManifest(assets, "1.2.3");
    await writeFile(join(assets, "install.sh"), "#!/bin/sh\n");
    await writeFile(join(assets, "install.ps1"), "# fixture\n");
    const checksums = [];
    for (const name of (await readdir(assets)).sort()) {
      checksums.push(`${await sha256(join(assets, name))}  ${name}\n`);
    }
    await writeFile(join(assets, "CHECKSUMS.sha256"), checksums.join(""));
    // Emulate only transport, then execute the real remote commands/finalizer in this fixture.
    await writeFile(
      join(bin, "ssh"),
      '#!/bin/sh\nfor command do :; done\nexec sh -c "$command"\n',
      { mode: 0o755 },
    );
    await writeFile(
      join(bin, "scp"),
      '#!/bin/sh\nset -eu\nfor target do :; done\ntarget=$(echo "$target" | cut -d: -f2-)\nfor source do\n case "$source" in "$TEST_ASSETS"/*) cp "$source" "$target";; esac\ndone\n',
      { mode: 0o755 },
    );
    const run = () =>
      spawnSync("bash", [join(import.meta.dirname, "upload.sh"), assets], {
        encoding: "utf8",
        timeout: 15_000,
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH}`,
          TEST_ASSETS: assets,
          ROLL_DIST_ROOT: root,
          ROLL_DIST_SSH_HOST: "example.invalid",
          ROLL_DIST_SSH_USER: "fixture",
          ROLL_DIST_SSH_PORT: "2222",
          ROLL_DIST_SSH_KEY: "fixture",
          ROLL_DIST_SSH_KNOWN_HOSTS: "fixture",
          GITHUB_RUN_ID: "123",
          GITHUB_RUN_ATTEMPT: "1",
        },
      });
    assert.notEqual(run().status, 0);
    assert.deepEqual(await readdir(join(root, "staging")), []);
    await writeFile(join(root, ".roll-distribution-root"), "roll-distribution-v1\n");
    const result = run();
    assert.equal(result.status, 0, result.stderr);
    assert.equal(await readlink(join(root, "releases/stable")), "1.2.3");
    assert.equal(
      (await readFile(join(root, "releases/stable/linux-x64.txt"), "utf8")).split("\t")[0],
      "1.2.3",
    );
    assert.deepEqual(await readdir(join(root, "staging")), []);
  },
);

// These fixtures exercise transport orchestration only; the Linux test above runs the real finalizer.
async function transportFixture(t, overrides = {}) {
  const home = await mkdtemp(join(tmpdir(), "roll-upload-observe-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const assets = join(home, "assets");
  const bin = join(home, "bin");
  const root = join(home, "distribution");
  for (const path of [
    assets,
    bin,
    join(root, "staging"),
    join(root, "releases"),
    join(home, "keys"),
  ]) {
    await mkdir(path, { recursive: true });
  }
  await writeFile(join(assets, "linux-x64.txt"), "1.2.3\tfixture\n");
  await writeFile(join(assets, "CHECKSUMS.sha256"), "fixture\n");
  await writeFile(join(root, "releases", "previous"), "keep previous stable\n");
  const calls = join(home, "calls.jsonl");
  const uploadPid = join(home, "upload.pid");
  const env = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    TMPDIR: join(home, "keys"),
    TEST_CALLS: calls,
    TEST_UPLOAD_PID: uploadPid,
    TEST_STAGE: join(root, "staging", "123-1"),
    TEST_UPLOAD_DELAY: "0",
    TEST_UPLOAD_STATUS: "0",
    TEST_FINALIZE_STATUS: "0",
    TEST_CHECKSUM_STATUS: "0",
    ROLL_DIST_ROOT: root,
    ROLL_DIST_SSH_HOST: "private-host.invalid",
    ROLL_DIST_SSH_USER: "private-user",
    ROLL_DIST_SSH_KEY: "fixture-private-key",
    ROLL_DIST_SSH_KNOWN_HOSTS: "fixture-private-host-key",
    GITHUB_RUN_ID: "123",
    GITHUB_RUN_ATTEMPT: "1",
    ...overrides,
  };
  const record = `
const args = process.argv.slice(2);
const key = args[args.indexOf("-i") + 1];
fs.appendFileSync(process.env.TEST_CALLS, JSON.stringify({
  tool: TOOL, args,
  keyMode: fs.statSync(key).mode & 0o777,
  keyEnv: process.env.ROLL_DIST_SSH_KEY ?? null,
  hostsEnv: process.env.ROLL_DIST_SSH_KNOWN_HOSTS ?? null,
}) + "\\n");
`;
  await writeFile(
    join(bin, "ssh"),
    `#!${process.execPath}
const fs = require("node:fs");
const TOOL = "ssh";
${record}
if (args.at(-1).startsWith("sh -s -- ")) {
  process.stdin.resume();
  process.stdin.on("end", () => process.exit(Number(process.env.TEST_FINALIZE_STATUS)));
} else {
  fs.mkdirSync(process.env.TEST_STAGE);
}
`,
    { mode: 0o755 },
  );
  await writeFile(
    join(bin, "scp"),
    `#!${process.execPath}
const fs = require("node:fs");
const TOOL = "scp";
${record}
fs.writeFileSync(process.env.TEST_UPLOAD_PID, String(process.pid));
fs.writeFileSync(process.env.TEST_STAGE + "/partial", "retained for diagnosis");
setTimeout(() => process.exit(Number(process.env.TEST_UPLOAD_STATUS)), Number(process.env.TEST_UPLOAD_DELAY));
`,
    { mode: 0o755 },
  );
  await writeFile(join(bin, "sha256sum"), '#!/bin/sh\nexit "$TEST_CHECKSUM_STATUS"\n', {
    mode: 0o755,
  });
  const args = [join(import.meta.dirname, "upload.sh"), assets];
  return {
    env,
    args,
    root,
    uploadPid,
    run: () => spawnSync("bash", args, { env, encoding: "utf8", timeout: 45_000 }),
    calls: async () =>
      (await readFile(calls, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line)),
    keys: () => readdir(join(home, "keys")),
  };
}

test(
  "upload reports elapsed process time and passes fixed SSH safety options",
  {
    skip: process.platform === "win32",
    timeout: 45_000,
  },
  async (t) => {
    const fixture = await transportFixture(t, { TEST_UPLOAD_DELAY: "31000" });
    const result = fixture.run();
    assert.equal(result.status, 0, result.stderr);
    const calls = await fixture.calls();
    assert.deepEqual(
      calls.map((call) => call.tool),
      ["ssh", "scp", "ssh"],
    );
    for (const call of calls) {
      for (const option of [
        "ConnectTimeout=15",
        "ConnectionAttempts=1",
        "ServerAliveInterval=15",
        "ServerAliveCountMax=3",
        "StrictHostKeyChecking=yes",
        "BatchMode=yes",
        "IdentitiesOnly=yes",
      ]) {
        assert.ok(call.args.includes(option), `${call.tool}: ${option}`);
      }
      assert.equal(call.keyMode, 0o600);
      assert.equal(call.keyEnv, null);
      assert.equal(call.hostsEnv, null);
      await assert.rejects(readFile(call.args[call.args.indexOf("-i") + 1]), { code: "ENOENT" });
    }
    const phases = result.stderr.split("\n").filter((line) => line.startsWith("[deploy]"));
    assert.match(phases[0], /Local checksums verified/);
    assert.match(phases[1], /Remote staging ready; uploading \d+ bytes/);
    assert.match(phases[2], /Upload process still running; elapsed \d+s \(not byte progress\)/);
    assert.match(phases.at(-2), /Upload complete; verifying and publishing remotely/);
    assert.match(phases.at(-1), /Published successfully/);
    for (const value of [
      fixture.env.ROLL_DIST_SSH_HOST,
      fixture.env.ROLL_DIST_SSH_USER,
      fixture.env.ROLL_DIST_SSH_KEY,
      fixture.env.ROLL_DIST_SSH_KNOWN_HOSTS,
      fixture.root,
    ]) {
      assert.ok(!`${result.stdout}${result.stderr}`.includes(value));
    }
    assert.deepEqual(await fixture.keys(), []);
  },
);

test(
  "upload failures preserve their status, skip publication and retain staging",
  {
    skip: process.platform === "win32",
  },
  async (t) => {
    const fixture = await transportFixture(t, { TEST_UPLOAD_STATUS: "37" });
    const result = fixture.run();
    assert.equal(result.status, 37, result.stderr);
    assert.deepEqual(
      (await fixture.calls()).map((call) => call.tool),
      ["ssh", "scp"],
    );
    assert.match(result.stderr, /Upload failed \(exit 37\)/);
    assert.doesNotMatch(result.stderr, /Upload complete|Published successfully/);
    assert.equal(
      await readFile(join(fixture.env.TEST_STAGE, "partial"), "utf8"),
      "retained for diagnosis",
    );
    assert.equal(
      await readFile(join(fixture.root, "releases", "previous"), "utf8"),
      "keep previous stable\n",
    );
    assert.deepEqual(await fixture.keys(), []);
  },
);

test(
  "checksum and finalization failures cannot log publication success",
  {
    skip: process.platform === "win32",
  },
  async (t) => {
    for (const [overrides, expectedStatus, expectedCalls] of [
      [{ TEST_CHECKSUM_STATUS: "22" }, 22, 0],
      [{ TEST_FINALIZE_STATUS: "19" }, 19, 3],
    ]) {
      const fixture = await transportFixture(t, overrides);
      const result = fixture.run();
      assert.equal(result.status, expectedStatus, result.stderr);
      if (expectedCalls) assert.equal((await fixture.calls()).length, expectedCalls);
      else await assert.rejects(fixture.calls(), { code: "ENOENT" });
      assert.doesNotMatch(result.stderr, /Published successfully/);
      assert.deepEqual(await fixture.keys(), []);
    }
  },
);

for (const [cancelSignal, expectedStatus] of [
  ["SIGINT", 130],
  ["SIGTERM", 143],
]) {
  test(
    `${cancelSignal} stops the local upload and removes credentials without removing staging`,
    {
      skip: process.platform === "win32",
      timeout: 10_000,
    },
    async (t) => {
      const fixture = await transportFixture(t, { TEST_UPLOAD_DELAY: "60000" });
      const child = spawn("bash", fixture.args, {
        env: fixture.env,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stderr = "";
      child.stdout.resume();
      child.stderr.on("data", (chunk) => {
        stderr += chunk;
      });
      const closed = once(child, "close", { signal: AbortSignal.timeout(8_000) });
      let uploadPid;
      t.after(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
        if (uploadPid) {
          try {
            process.kill(uploadPid, "SIGKILL");
          } catch {
            /* Already exited. */
          }
        }
      });
      for (let i = 0; i < 100; i++) {
        try {
          uploadPid = Number(await readFile(fixture.uploadPid, "utf8"));
          break;
        } catch (error) {
          if (error.code !== "ENOENT") throw error;
        }
        await setTimeout(20);
      }
      assert.ok(uploadPid, "upload must start before cancellation");
      child.kill(cancelSignal);
      const [status, signal] = await closed;
      assert.equal(status, expectedStatus, stderr);
      assert.equal(signal, null);
      assert.throws(() => process.kill(uploadPid, 0), { code: "ESRCH" });
      uploadPid = undefined;
      assert.deepEqual(await fixture.keys(), []);
      assert.equal((await fixture.calls()).length, 2, "cancelled upload must not finalize");
      assert.ok((await readdir(fixture.env.TEST_STAGE)).includes("partial"));
      assert.doesNotMatch(stderr, /Upload complete|Published successfully/);
    },
  );
}

test(
  "invalid SSH ports stop before any publication files, credentials or SSH are used",
  { skip: process.platform === "win32" },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), "roll-upload-port-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const bin = join(root, "bin");
    await mkdir(bin);
    const marker = join(root, "cut-was-called");
    await writeFile(join(bin, "cut"), '#!/bin/sh\nprintf called > "$TEST_MARKER"\nexit 91\n', {
      mode: 0o755,
    });
    const env = {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      TEST_MARKER: marker,
      ROLL_DIST_SSH_HOST: "example.invalid",
      ROLL_DIST_SSH_USER: "fixture",
      ROLL_DIST_SSH_KEY: "fixture",
      ROLL_DIST_SSH_KNOWN_HOSTS: "fixture",
      ROLL_DIST_ROOT: "/srv/example-distribution",
    };
    for (const port of ["abc", "0", "65536", "99999999999999999999", "-1"]) {
      const result = spawnSync("bash", [join(import.meta.dirname, "upload.sh"), root], {
        env: { ...env, ROLL_DIST_SSH_PORT: port },
        encoding: "utf8",
      });
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /Invalid ROLL_DIST_SSH_PORT/);
      await assert.rejects(readFile(marker), { code: "ENOENT" });
    }
    for (const port of ["22", "2222", "00022"]) {
      const result = spawnSync("bash", [join(import.meta.dirname, "upload.sh"), root], {
        env: { ...env, ROLL_DIST_SSH_PORT: port },
        encoding: "utf8",
      });
      assert.equal(result.status, 91);
      assert.equal(await readFile(marker, "utf8"), "called");
      await rm(marker);
    }
    for (const path of [
      "/",
      "/tmp",
      "relative/path",
      "/tmp/../etc",
      "/tmp//root",
      "/tmp/root/",
      "/tmp/root;touch",
      "/tmp/root name",
      "/tmp/root'quoted",
      "/tmp/$HOME",
    ]) {
      const result = spawnSync("bash", [join(import.meta.dirname, "upload.sh"), root], {
        env: { ...env, ROLL_DIST_SSH_PORT: "22", ROLL_DIST_ROOT: path },
        encoding: "utf8",
      });
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /Invalid ROLL_DIST_ROOT/);
      await assert.rejects(readFile(marker), { code: "ENOENT" });
      const finalize = spawnSync(
        "sh",
        [join(import.meta.dirname, "finalize.sh"), "1.2.3", "fixture", path],
        { encoding: "utf8" },
      );
      assert.notEqual(finalize.status, 0);
      assert.match(finalize.stderr, /Invalid ROLL_DIST_ROOT/);
    }
  },
);
