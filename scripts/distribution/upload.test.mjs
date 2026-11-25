import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { assetFilename, PLATFORMS, sha256, writeManifest } from "./metadata.mjs";

const exec = promisify(execFile);
const upload = join(import.meta.dirname, "upload.sh");
const finalizer = join(import.meta.dirname, "finalize.sh");

test(
  "download uses fresh tickets on disconnect, verifies the ZIP and gates atomic publication",
  {
    skip: process.platform === "win32",
  },
  async (t) => {
    const home = await realpath(await mkdtemp(join(tmpdir(), "roll-pull-")));
    t.after(() => rm(home, { recursive: true, force: true }));
    const root = join(home, "root");
    const assets = join(home, "assets");
    const bin = join(home, "bin");
    const keys = join(home, "keys");
    for (const path of [assets, bin, keys, join(root, "staging"), join(root, "releases")]) {
      await mkdir(path, { recursive: true });
    }
    for (const platform of PLATFORMS) {
      await writeFile(join(assets, assetFilename("1.2.3", platform)), platform);
    }
    await writeManifest(assets, "1.2.3");
    for (const file of ["install.sh", "install.ps1"]) {
      await writeFile(join(assets, file), "# fixture\n");
    }
    const checks = [];
    for (const name of await readdir(assets)) {
      checks.push((await sha256(join(assets, name))) + "  " + name + "\n");
    }
    await writeFile(join(assets, "CHECKSUMS.sha256"), checks.join(""));
    const zip = join(home, "publication.zip");
    await exec(
      "python3",
      [
        "-c",
        "import os,sys,zipfile; z=zipfile.ZipFile(sys.argv[1],'w'); [z.write(f,f) for f in os.listdir('.')]; z.close()",
        zip,
      ],
      { cwd: assets },
    );
    const bytes = await readFile(zip);
    const digest = createHash("sha256").update(bytes).digest("hex");
    const key = join(home, "server.key");
    const cert = join(home, "server.pem");
    const config = join(home, "openssl.cnf");
    await writeFile(
      config,
      "[req]\ndistinguished_name=dn\nx509_extensions=ext\n[dn]\n[ext]\nsubjectAltName=IP:127.0.0.1\nbasicConstraints=critical,CA:TRUE\nkeyUsage=critical,digitalSignature,keyEncipherment,keyCertSign\nsubjectKeyIdentifier=hash\nauthorityKeyIdentifier=keyid:always\n",
    );
    await exec("openssl", [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-days",
      "1",
      "-subj",
      "/CN=localhost",
      "-config",
      config,
      "-keyout",
      key,
      "-out",
      cert,
    ]);
    let mode = "complete";
    let requests = 0;
    const server = createServer(
      { key: await readFile(key), cert: await readFile(cert) },
      (req, res) => {
        requests++;
        assert.equal(req.headers.authorization, undefined);
        assert.ok(req.url.startsWith("/artifact?signature="));
        if (mode === "expired") {
          res.writeHead(403).end();
          return;
        }
        if (mode === "stall") {
          res.writeHead(200).write(bytes.subarray(0, 100));
          return;
        }
        const truncated = mode === "interrupt" && requests === 1;
        res.writeHead(200).end(truncated ? bytes.subarray(0, 100) : bytes);
      },
    );
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    t.after(() => new Promise((resolve) => server.close(resolve)));
    const tickets = join(home, "tickets");
    const mock = join(home, "api.mjs");
    const mockApi = async (url, options) => {
      const { default: assert } = await import("node:assert/strict");
      const { appendFileSync } = await import("node:fs");
      assert.equal(options.redirect, "manual");
      assert.equal(options.headers.Authorization, "Bearer private-test-token");
      if (url === "https://api.github.com/repos/test/example/actions/artifacts/456") {
        return Response.json({
          id: 456,
          name: "standalone-publication",
          expired: false,
          size_in_bytes: Number(process.env.TEST_SIZE),
          digest: "sha256:" + process.env.TEST_DIGEST,
        });
      }
      assert.equal(url, "https://api.github.com/repos/test/example/actions/artifacts/456/zip");
      appendFileSync(process.env.TEST_TICKETS, "ticket\n");
      return new Response(null, {
        status: 302,
        headers: { location: process.env.TEST_STORAGE + "/artifact?signature=" + Date.now() },
      });
    };
    await writeFile(mock, "globalThis.fetch = " + mockApi.toString() + "\n");
    // Execute real remote shell commands. Replace only SSH and the GitHub metadata service.
    await writeFile(
      join(bin, "ssh"),
      // eslint-disable-next-line no-template-curly-in-string -- POSIX shell parameter expansion
      '#!/bin/sh\nset -eu\ntest -z "${GH_TOKEN-}${ROLL_DIST_SSH_KEY-}${ROLL_DIST_SSH_KNOWN_HOSTS-}"\nfor command do :; done\ncase "$command" in python3*) command="exec $command";; esac\nexec sh -c "$command"\n',
      { mode: 0o755 },
    );
    const finalize = process.platform === "linux" ? finalizer : join(home, "finalize.sh");
    if (finalize !== finalizer) {
      await writeFile(
        finalize,
        'set -eu\nmv "$3/staging/$2" "$3/releases/$1"\nln -s "$1" "$3/releases/stable"\n',
      );
    }
    const env = {
      ...process.env,
      TMPDIR: keys,
      PATH: bin + ":" + process.env.PATH,
      GH_TOKEN: "private-test-token",
      GITHUB_REPOSITORY: "test/example",
      GITHUB_RUN_ID: "123",
      GITHUB_RUN_ATTEMPT: "1",
      ROLL_DIST_SSH_PORT: "2222",
      ROLL_DIST_SSH_USER: "fixture",
      ROLL_DIST_SSH_HOST: "example.invalid",
      ROLL_DIST_ROOT: root,
      ROLL_DIST_SSH_KEY: "fixture-private-key",
      ROLL_DIST_SSH_KNOWN_HOSTS: "fixture-host-key",
      SSL_CERT_FILE: cert,
      no_proxy: "127.0.0.1",
      NO_PROXY: "127.0.0.1",
      TEST_DIGEST: digest,
      TEST_SIZE: String(bytes.length),
      TEST_STORAGE: "https://127.0.0.1:" + server.address().port,
      TEST_TICKETS: tickets,
      NODE_OPTIONS: '--import="' + mock + '"',
    };
    const run = (overrides = {}) =>
      exec("bash", [upload, "1.2.3", "456", finalize], {
        env: { ...env, ...overrides },
        timeout: 20_000,
      });
    await assert.rejects(run(), "root marker is required");
    for (const port of ["0", "65536", "abc"]) {
      await assert.rejects(run({ ROLL_DIST_SSH_PORT: port }), /Invalid ROLL_DIST_SSH_PORT/);
    }
    for (const path of ["/", "/tmp", "/tmp//root", "/tmp/../etc", "/tmp/root'quoted"]) {
      await assert.rejects(run({ ROLL_DIST_ROOT: path }), /Invalid ROLL_DIST_ROOT/);
    }
    assert.equal(requests, 0);
    await writeFile(join(root, ".roll-distribution-root"), "roll-distribution-v1\n");
    await assert.rejects(run({ TEST_DIGEST: "0".repeat(64) }), /SHA-256 mismatch/);
    assert.deepEqual(await readdir(join(root, "releases")), []);
    assert.deepEqual(await readdir(join(root, "staging", "123-1")), []);
    mode = "expired";
    requests = 0;
    await assert.rejects(run({ GITHUB_RUN_ATTEMPT: "2" }), (err) => err.code === 75);
    assert.equal(requests, 3);
    assert.deepEqual(await readdir(join(root, "releases")), []);
    mode = "stall";
    const started = once(server, "request", { signal: AbortSignal.timeout(5_000) });
    const cancelled = run({ GITHUB_RUN_ATTEMPT: "3" });
    const stopped = assert.rejects(cancelled, (error) => error.code === 143);
    await started;
    cancelled.child.kill("SIGTERM");
    await stopped;
    assert.deepEqual(await readdir(join(root, "releases")), []);
    assert.deepEqual(await readdir(keys), []);
    mode = "interrupt";
    requests = 0;
    const { stdout, stderr } = await run({ GITHUB_RUN_ATTEMPT: "4" });
    assert.equal(requests, 2);
    assert.equal((await readFile(tickets, "utf8")).trim().split("\n").length, 7);
    assert.equal(await readlink(join(root, "releases/stable")), "1.2.3");
    assert.deepEqual(
      await readFile(join(root, "releases/stable/manifest.json")),
      await readFile(join(assets, "manifest.json")),
    );
    assert.match(stdout, /Received \d+\/\d+ bytes/);
    assert.doesNotMatch(stdout + stderr, /private-test-token|fixture-private-key|signature=/);
    assert.deepEqual(await readdir(keys), []);
  },
);
