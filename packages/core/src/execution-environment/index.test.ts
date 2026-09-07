import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { after, test } from "node:test";
import { McpClientManager } from "../mcp/client-manager.ts";
import { startAgent, stopAgent } from "../registry/process-manager.ts";
import type { RegisteredAgent } from "../types/agent.ts";
import { runAgentSetup } from "../registry/runtime-setup.ts";
import { runPackageManager } from "../cli/utils/package-manager.ts";
import { createBundledRollInvocation } from "../companion-host/invocation.ts";
import {
  getExecutionEnvironment,
  resolveExecutionEnvironment,
  withExecutionEnvironment,
} from "./index.ts";

const root = realpathSync(mkdtempSync(join(tmpdir(), "roll 私有 runtime ")));
after(() => rmSync(root, { recursive: true, force: true }));
const versionRoot = join(root, "versions/1.2.3");
const packageRoot = join(versionRoot, "app");
const runtimeRoot = join(versionRoot, "runtime");
const bin = process.platform === "win32" ? runtimeRoot : join(runtimeRoot, "bin");
const nodePath = join(bin, process.platform === "win32" ? "node.exe" : "node");
const npmRoot = join(
  runtimeRoot,
  process.platform === "win32" ? "node_modules/npm" : "lib/node_modules/npm",
);
mkdirSync(packageRoot, { recursive: true });
mkdirSync(bin, { recursive: true });
mkdirSync(join(npmRoot, "bin"), { recursive: true });
copyFileSync(process.execPath, nodePath);
chmodSync(nodePath, 0o755);
// Homebrew Node uses a sibling libnode dylib; official release Node is self contained.
if (process.platform === "darwin") {
  const hostLib = resolve(dirname(realpathSync(process.execPath)), "../lib");
  const privateLib = join(runtimeRoot, "lib");
  mkdirSync(privateLib, { recursive: true });
  for (const name of readdirSync(hostLib)) {
    if (/^libnode.*\.dylib$/.test(name)) copyFileSync(join(hostLib, name), join(privateLib, name));
  }
}
const pkg = {
  name: "@roll-agent/core",
  version: "1.2.3",
  rollDistribution: { schemaVersion: 1, channel: "standalone" },
};
const metadata = {
  schemaVersion: 1,
  channel: "standalone",
  version: "1.2.3",
  platform: `${process.platform}-${process.arch}`,
  nodeVersion: "24.18.0",
};
writeFileSync(join(packageRoot, "package.json"), JSON.stringify(pkg));
writeFileSync(join(versionRoot, "distribution.json"), JSON.stringify(metadata));
writeFileSync(
  join(root, "installation.json"),
  JSON.stringify({ schemaVersion: 1, channel: "standalone" }),
);
const npmScript = `const {execFileSync} = require('node:child_process');
console.log(JSON.stringify({ node: process.execPath, args: process.argv.slice(2), child: execFileSync('node', ['-p', 'process.execPath'], {encoding:'utf8'}).trim() }));`;
writeFileSync(join(npmRoot, "bin/npm-cli.js"), npmScript);
writeFileSync(join(npmRoot, "bin/npx-cli.js"), npmScript);
for (const tool of ["npm", "npx"]) {
  if (process.platform === "win32") {
    writeFileSync(
      join(bin, `${tool}.cmd`),
      `@"%~dp0node.exe" "%~dp0node_modules\\npm\\bin\\${tool}-cli.js" %*\r\n`,
    );
  } else {
    writeFileSync(
      join(bin, tool),
      `#!/bin/sh\nexec "$(dirname "$0")/node" "$(dirname "$0")/../lib/node_modules/npm/bin/${tool}-cli.js" "$@"\n`,
      { mode: 0o755 },
    );
  }
}
const fakeBin = join(root, "fake-bin");
mkdirSync(fakeBin);
for (const tool of ["node", "npm", "npx"]) {
  writeFileSync(join(fakeBin, tool), "#!/bin/sh\nexit 99\n", { mode: 0o755 });
}

function bundled() {
  return resolveExecutionEnvironment({ packageRoot, baseEnv: { PATH: fakeBin } });
}

test("bundled npm and its Node child ignore a poisoned PATH, preserving arguments", async () => {
  const environment = bundled();
  const args = ["install", "包 with spaces", "a&b", 'literal"quote', "%PATH%!"];
  const result = await withExecutionEnvironment(environment, () =>
    runPackageManager({ command: "npm", args }, { env: { ...process.env, PATH: fakeBin } }),
  );
  const output: unknown = JSON.parse(result.stdout);
  assert.deepEqual(output, { node: nodePath, child: nodePath, args });
  assert.equal(environment.installation.installRoot, root);
  assert.equal(environment.mode, "bundled");
});

test("bare Node uses private executable and child PATH without mutating the parent", () => {
  const original = process.env["PATH"];
  const invocation = bundled().resolveCommand("node", ["-p", "process.execPath"], {
    PATH: fakeBin,
    KEEP: "yes",
    UNSET: undefined,
  });
  assert.equal(
    execFileSync(invocation.command, [...invocation.args], {
      env: invocation.env,
      encoding: "utf8",
    }).trim(),
    nodePath,
  );
  assert.equal(invocation.env["KEEP"], "yes");
  assert.equal("UNSET" in invocation.env, false);
  assert.equal(process.env["PATH"], original);
});

test("explicit interpreters, Python and unrelated executables retain exact command/environment", () => {
  for (const command of [process.execPath, "/company/node", "./node", "python3", "uv", "docker"]) {
    const invocation = bundled().resolveCommand(command, ["agent.py"], {
      PATH: fakeBin,
      KEEP: "yes",
    });
    assert.deepEqual(invocation, {
      command,
      args: ["agent.py"],
      env: { PATH: fakeBin, KEEP: "yes" },
    });
  }
});

test("bundled Companion invocation follows the scoped target version", () => {
  const invocation = withExecutionEnvironment(bundled(), () =>
    createBundledRollInvocation({ execArgv: [] }),
  );
  assert.equal(invocation.command, nodePath);
  assert.equal(invocation.cliEntrypoint, join(packageRoot, "dist/cli/index.js"));
});

test("scoped execution environments propagate across awaits and do not leak", async () => {
  const original = getExecutionEnvironment().nodePath;
  await withExecutionEnvironment(bundled(), async () => {
    await Promise.resolve();
    assert.equal(getExecutionEnvironment().nodePath, nodePath);
  });
  assert.equal(getExecutionEnvironment().nodePath, original);
});

test("missing distribution metadata fails closed instead of using the host", () => {
  const path = join(versionRoot, "distribution.json");
  rmSync(path);
  try {
    assert.throws(bundled, /ENOENT/);
  } finally {
    writeFileSync(path, JSON.stringify(metadata));
  }
});

test("installed root marker catches a missing app sentinel and distribution metadata", () => {
  const path = join(versionRoot, "distribution.json");
  rmSync(path);
  writeFileSync(
    join(packageRoot, "package.json"),
    JSON.stringify({ name: pkg.name, version: pkg.version }),
  );
  try {
    assert.throws(bundled, /package marker/);
  } finally {
    writeFileSync(path, JSON.stringify(metadata));
    writeFileSync(join(packageRoot, "package.json"), JSON.stringify(pkg));
  }
});

test("missing private npm fails at resolution even if the host npm exists", () => {
  const path = join(npmRoot, "bin/npm-cli.js");
  rmSync(path);
  try {
    assert.throws(bundled, /ENOENT/);
  } finally {
    writeFileSync(path, npmScript);
  }
});

test(
  "runtime files cannot escape the distribution via symlinks",
  { skip: process.platform === "win32" },
  () => {
    const path = join(npmRoot, "bin/npm-cli.js");
    const external = join(root, "external.js");
    writeFileSync(external, npmScript);
    rmSync(path);
    symlinkSync(external, path);
    try {
      assert.throws(bundled, /escapes/);
    } finally {
      rmSync(path);
      writeFileSync(path, npmScript);
    }
  },
);

test("mismatched metadata version and platform fail closed", () => {
  const path = join(versionRoot, "distribution.json");
  try {
    for (const changed of [
      { ...metadata, version: "9.9.9" },
      { ...metadata, platform: "linux-riscv64" },
    ]) {
      writeFileSync(path, JSON.stringify(changed));
      assert.throws(bundled, /Invalid or incompatible/);
    }
  } finally {
    writeFileSync(path, JSON.stringify(metadata));
  }
});

test("future Node security releases can be resolved without upgrading the old resolver first", () => {
  const path = join(versionRoot, "distribution.json");
  try {
    writeFileSync(path, JSON.stringify({ ...metadata, nodeVersion: "24.19.0" }));
    assert.equal(bundled().nodePath, nodePath);
  } finally {
    writeFileSync(path, JSON.stringify(metadata));
  }
});

test("missing npm child launcher fails before falling back to the host PATH", () => {
  const path = join(bin, process.platform === "win32" ? "npm.cmd" : "npm");
  const original = readFileSync(path);
  rmSync(path);
  try {
    assert.throws(bundled, /ENOENT/);
  } finally {
    writeFileSync(path, original, { mode: 0o755 });
  }
});

test("Windows environment produces one PATH and direct JS npm invocation", () => {
  const env = resolveExecutionEnvironment({ platform: "win32", baseEnv: {} });
  const childEnv = env.createEnv({ Path: "C:\\custom", PATH: "C:\\other" });
  assert.deepEqual(
    Object.keys(childEnv).filter((key) => key.toLowerCase() === "path"),
    ["PATH"],
  );
  assert.ok(childEnv["PATH"]?.startsWith(`${dirname(env.nodePath)};`));
});

test("host runtime remains available without npm and only npm use fails", () => {
  const isolated = join(root, "isolated-host/node");
  mkdirSync(dirname(isolated), { recursive: true });
  copyFileSync(process.execPath, isolated);
  const environment = resolveExecutionEnvironment({ nodePath: isolated, baseEnv: {} });
  assert.equal(environment.mode, "host");
  assert.equal(environment.installation.channel, "development");
  assert.equal(environment.npmCliPath, undefined);
  assert.equal(environment.resolveCommand("node", [], {}).command, isolated);
  assert.throws(() => environment.resolveCommand("npm", [], {}), /cannot locate npm/);
});

test("stdio MCP handshake and child processes use private Node with poisoned agent PATH", async () => {
  const script = join(root, "stdio.cjs");
  writeFileSync(
    script,
    `const {createInterface} = require('node:readline');
const {execFileSync} = require('node:child_process');
createInterface({input: process.stdin}).on('line', line => {
 const request = JSON.parse(line);
 if (request.id === undefined) return;
 const result = request.method === 'initialize'
   ? {protocolVersion: request.params.protocolVersion, capabilities: {tools:{}}, serverInfo: {name: process.execPath, version:'1.0.0'}}
   : {tools:[{name:'runtime', description:execFileSync('node',['-p','process.execPath'],{encoding:'utf8'}).trim(), inputSchema:{type:'object'}}]};
 process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:request.id,result})+'\\n');
});`,
  );
  const manager = new McpClientManager();
  try {
    await withExecutionEnvironment(bundled(), async () => {
      const client = await manager.connect(
        "private-node-test",
        { type: "stdio", command: "node", args: [script] },
        root,
        { env: { PATH: fakeBin } },
      );
      assert.equal(client.getServerVersion()?.name, nodePath);
      assert.equal((await client.listTools()).tools[0]?.description, nodePath);
    });
  } finally {
    await manager.disconnectAll();
  }
});

test("managed HTTP process uses private Node after agent environment merging", async () => {
  const output = join(root, "http-runtime.json");
  const script = join(root, "http.cjs");
  writeFileSync(
    script,
    `const {createServer} = require('node:http');
const {execFileSync} = require('node:child_process');
const {writeFileSync} = require('node:fs');
const identity = {node:process.execPath,child:execFileSync('node',['-p','process.execPath'],{encoding:'utf8'}).trim()};
const server=createServer((req,res)=>{res.setHeader('Content-Type','application/json');res.end(JSON.stringify(identity));});
server.listen(0,'127.0.0.1',()=>writeFileSync(${JSON.stringify(output)},JSON.stringify({port:server.address().port})));`,
  );
  const agent: RegisteredAgent = {
    skill: { name: "execution-environment-http", description: "fixture", metadata: {} },
    transport: { type: "streamable-http", endpoint: "http://127.0.0.1:1/mcp" },
    runtime: {
      ownership: "core-managed",
      start: { command: "node", args: [script] },
      endpoint: { path: "/mcp", port: 1 },
    },
    installPath: root,
    registeredAt: new Date().toISOString(),
    status: "stopped",
    source: { type: "local-path", path: root },
  };
  const dataDir = join(root, "http-data");
  withExecutionEnvironment(bundled(), () => startAgent(agent, dataDir, { PATH: fakeBin }));
  try {
    let port: number | undefined;
    for (let attempt = 0; attempt < 100; attempt++) {
      try {
        const info: unknown = JSON.parse(readFileSync(output, "utf8"));
        if (
          typeof info === "object" &&
          info !== null &&
          "port" in info &&
          typeof info.port === "number"
        ) {
          port = info.port;
          break;
        }
      } catch {
        /* Wait for the owned process to bind its listener. */
      }
      await delay(50);
    }
    assert.ok(port);
    const response = await fetch(`http://127.0.0.1:${port}/mcp`);
    assert.deepEqual(await response.json(), { node: nodePath, child: nodePath });
  } finally {
    stopAgent(dataDir, agent.skill.name);
  }
});

test("Playwright setup launches with the scoped runtime and supplies Node to children", async () => {
  const agentRoot = join(root, "playwright-agent");
  const playwrightRoot = join(agentRoot, "node_modules/playwright-core");
  mkdirSync(playwrightRoot, { recursive: true });
  writeFileSync(join(agentRoot, "package.json"), "{}");
  writeFileSync(
    join(playwrightRoot, "package.json"),
    JSON.stringify({ name: "playwright-core", exports: { "./cli.js": "./cli.cjs" } }),
  );
  const output = join(root, "playwright-runtime.json");
  writeFileSync(
    join(playwrightRoot, "cli.cjs"),
    `const {execFileSync}=require('node:child_process');require('node:fs').writeFileSync(${JSON.stringify(output)},JSON.stringify({node:process.execPath,child:execFileSync('node',['-p','process.execPath'],{encoding:'utf8'}).trim()}));`,
  );
  const agent: RegisteredAgent = {
    skill: { name: "playwright-fixture", description: "fixture", metadata: {} },
    transport: { type: "streamable-http", endpoint: "http://127.0.0.1:1/mcp" },
    runtime: {
      ownership: "core-managed",
      start: { command: "node", args: [] },
      endpoint: { path: "/mcp", port: 1 },
      setup: { playwright: { browsers: ["chromium"] } },
    },
    installPath: agentRoot,
    registeredAt: new Date().toISOString(),
    status: "stopped",
  };
  const result = await withExecutionEnvironment(bundled(), () => runAgentSetup(agent));
  assert.equal(result.ok, true, result.message);
  assert.deepEqual(JSON.parse(readFileSync(output, "utf8")), { node: nodePath, child: nodePath });
});

test("real npm installs a local Agent and its lifecycle uses private Node and npm", async () => {
  const hostNpmCli = resolveExecutionEnvironment().npmCliPath;
  assert.ok(hostNpmCli, "CI Node must include npm for the real lifecycle test");
  const hostNpmRoot = resolve(dirname(hostNpmCli), "..");
  cpSync(hostNpmRoot, npmRoot, { recursive: true });
  const source = join(root, "local-package");
  const destination = join(root, "local-install");
  const output = join(root, "lifecycle.json");
  mkdirSync(source);
  writeFileSync(
    join(source, "package.json"),
    JSON.stringify({
      name: "roll-private-runtime-fixture",
      version: "1.0.0",
      scripts: { postinstall: "node lifecycle.cjs" },
    }),
  );
  writeFileSync(
    join(source, "lifecycle.cjs"),
    `const {execFileSync}=require('node:child_process');require('node:fs').writeFileSync(${JSON.stringify(output)},JSON.stringify({node:process.execPath,child:execFileSync('node',['-p','process.execPath'],{encoding:'utf8'}).trim(),npm:process.env.npm_execpath}));`,
  );
  const npmrc = join(root, "empty.npmrc");
  writeFileSync(npmrc, "");
  try {
    await withExecutionEnvironment(bundled(), () =>
      runPackageManager(
        {
          command: "npm",
          args: [
            "install",
            "--prefix",
            destination,
            "--install-links",
            "--no-audit",
            "--no-fund",
            "--offline",
            source,
          ],
        },
        {
          env: {
            ...process.env,
            PATH: `${fakeBin}${process.platform === "win32" ? ";" : ":"}${process.platform === "win32" ? process.env["SystemRoot"] + "\\System32" : "/usr/bin:/bin"}`,
            npm_config_userconfig: npmrc,
            npm_config_cache: join(root, "npm-cache"),
          },
          timeout: 30_000,
        },
      ),
    );
    assert.deepEqual(JSON.parse(readFileSync(output, "utf8")), {
      node: nodePath,
      child: nodePath,
      npm: join(npmRoot, "bin/npm-cli.js"),
    });
  } finally {
    chmodSync(join(npmRoot, "bin/npm-cli.js"), 0o755);
    chmodSync(join(npmRoot, "bin/npx-cli.js"), 0o755);
    writeFileSync(join(npmRoot, "bin/npm-cli.js"), npmScript);
    writeFileSync(join(npmRoot, "bin/npx-cli.js"), npmScript);
  }
});
