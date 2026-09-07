import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, mkdir, readFile, writeFile, rm, cp, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import { assetFilename, NODE_VERSION, sha256 } from "./metadata.mjs";

// Native artifact acceptance, enabled by the distribution workflow after building the archive.
// The fetch redirect exists only in this fixture entrypoint, never in shipped Roll code.
test(
  "native standalone A to B update preserves data and uses B for npm Agent execution",
  {
    skip: !process.env.ROLL_TEST_DISTRIBUTION_ARCHIVE,
    timeout: 300_000,
  },
  async (t) => {
    const archive = resolve(process.env.ROLL_TEST_DISTRIBUTION_ARCHIVE);
    const home = await mkdtemp(join(tmpdir(), "roll native upgrade 中文 "));
    t.after(() => rm(home, { recursive: true, force: true }));
    const source = join(home, "source");
    await mkdir(source);
    const extract =
      process.platform === "win32"
        ? spawnSync(
            "powershell.exe",
            [
              "-NoProfile",
              "-NonInteractive",
              "-Command",
              "Expand-Archive -LiteralPath $env:TEST_ARCHIVE -DestinationPath $env:TEST_SOURCE",
            ],
            {
              env: { ...process.env, TEST_ARCHIVE: archive, TEST_SOURCE: source },
              encoding: "utf8",
            },
          )
        : spawnSync("tar", ["-xzf", archive, "-C", source], { encoding: "utf8" });
    assert.equal(extract.status, 0, extract.stderr);
    const platform = `${process.platform}-${process.arch}`;
    const pkg = JSON.parse(await readFile(join(source, "app/package.json"), "utf8"));
    const a = pkg.version;
    const parts = a.split(".").map(Number);
    const b = `${parts[0]}.${parts[1]}.${parts[2] + 1}`;
    const root = join(home, "installation");
    const aRoot = join(root, "versions", a);
    await mkdir(join(root, "versions"), { recursive: true });
    await cp(source, aRoot, { recursive: true });
    await writeFile(
      join(root, "installation.json"),
      '{"schemaVersion":1,"channel":"standalone"}\n',
    );
    await writeFile(join(root, "current.txt"), `${a}\n`);
    pkg.version = b;
    await writeFile(join(source, "app/package.json"), JSON.stringify(pkg));
    const metadata = JSON.parse(await readFile(join(source, "distribution.json"), "utf8"));
    metadata.version = b;
    await writeFile(join(source, "distribution.json"), JSON.stringify(metadata));
    const bArchive = join(home, assetFilename(b, platform));
    const archived = spawnSync(
      process.platform === "win32" ? "python" : "python3",
      [join(import.meta.dirname, "archive.py"), source, bArchive],
      { encoding: "utf8" },
    );
    assert.equal(archived.status, 0, archived.stderr);
    const bBytes = await readFile(bArchive);
    const manifest = {
      schemaVersion: 1,
      version: b,
      nodeVersion: NODE_VERSION,
      assets: [
        {
          platform,
          filename: assetFilename(b, platform),
          sha256: await sha256(bArchive),
          size: (await stat(bArchive)).size,
        },
      ],
    };

    const packageName = "@roll-agent/standalone-probe";
    const agent = join(home, "agent-package/package");
    await mkdir(agent, { recursive: true });
    await writeFile(
      join(agent, "package.json"),
      JSON.stringify({
        name: packageName,
        version: "1.0.0",
        type: "module",
        scripts: { postinstall: "node lifecycle.cjs" },
        rollAgent: {
          runtime: { ownership: "on-demand", transport: "stdio" },
          start: { command: "node", args: ["index.mjs"] },
        },
      }),
    );
    await writeFile(
      join(agent, "SKILL.md"),
      "---\nname: standalone-probe\ndescription: Test private Node execution\n---\nReports its interpreter.\n",
    );
    await writeFile(
      join(agent, "lifecycle.cjs"),
      'require("node:fs").writeFileSync("lifecycle.json",JSON.stringify({node:process.execPath,child:require("node:child_process").execFileSync("node",["-p","process.execPath"],{encoding:"utf8"}).trim()}));',
    );
    await writeFile(
      join(agent, "index.mjs"),
      `
import {createInterface} from 'node:readline';
import {execFileSync} from 'node:child_process';
createInterface({input:process.stdin}).on('line',line=>{
 const m=JSON.parse(line); if(m.id===undefined)return;
 let result={};
 if(m.method==='initialize')result={protocolVersion:'2024-11-05',capabilities:{tools:{}},serverInfo:{name:'probe',version:'1'}};
 if(m.method==='tools/list')result={tools:[{name:'interpreter',description:'Report Node',inputSchema:{type:'object',properties:{}}}]};
 if(m.method==='tools/call')result={content:[{type:'text',text:JSON.stringify({node:process.execPath,child:execFileSync('node',['-p','process.execPath'],{encoding:'utf8'}).trim()})}]};
 process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result})+'\\n');
});
`,
    );
    const agentTar = join(home, "agent.tgz");
    const agentPacked = spawnSync(
      "tar",
      ["-czf", agentTar, "-C", join(home, "agent-package"), "package"],
      { encoding: "utf8" },
    );
    assert.equal(agentPacked.status, 0, agentPacked.stderr);
    const agentBytes = await readFile(agentTar);
    const requests = [];
    const server = createServer((request, response) => {
      const pathname = decodeURIComponent(new URL(request.url, origin).pathname);
      requests.push(pathname);
      if (pathname.startsWith("/releases/") && pathname.endsWith("/manifest.json")) {
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify(manifest));
      } else if (pathname === `/releases/${b}/${assetFilename(b, platform)}`) {
        response.end(bBytes);
      } else if (pathname === "/agent.tgz") {
        response.end(agentBytes);
      } else if (pathname === `/${packageName}`) {
        const record = {
          name: packageName,
          version: "1.0.0",
          scripts: { postinstall: "node lifecycle.cjs" },
          hasInstallScript: true,
          dist: { tarball: `${origin}/agent.tgz` },
        };
        response.setHeader("content-type", "application/json");
        response.end(
          JSON.stringify({
            name: packageName,
            "dist-tags": { latest: "1.0.0" },
            versions: { "1.0.0": record },
          }),
        );
      } else {
        response.writeHead(404);
        response.end("missing fixture");
      }
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    t.after(() => {
      server.closeAllConnections();
      server.close();
    });
    const origin = `http://127.0.0.1:${server.address().port}`;
    await writeFile(
      join(home, "roll.config.yaml"),
      `install:\n  registry: ${origin}\nagents:\n  data-dir: ${JSON.stringify(join(home, "agents"))}\n`,
    );
    await writeFile(join(home, "npmrc"), "");
    await writeFile(join(home, "global-npmrc"), "");
    const bait = join(home, "bait");
    await mkdir(bait);
    for (const tool of ["node", "npm", "npx"]) {
      await writeFile(
        join(bait, process.platform === "win32" ? `${tool}.cmd` : tool),
        process.platform === "win32" ? "@exit /b 99\r\n" : "#!/bin/sh\nexit 99\n",
        { mode: 0o755 },
      );
    }
    const env = {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      LOCALAPPDATA: home,
      APPDATA: home,
      NODE_OPTIONS: "",
      NODE_PATH: "",
      npm_config_userconfig: join(home, "npmrc"),
      npm_config_globalconfig: join(home, "global-npmrc"),
      npm_config_cache: join(home, "npm-cache"),
      PATH: `${bait}${process.platform === "win32" ? ";" : ":"}${process.env.PATH ?? ""}`,
    };
    async function run(version, args) {
      const versionRoot = join(root, "versions", version);
      const cli = join(versionRoot, "app/dist/cli/index.js");
      const wrapper = join(home, `entry-${version}.mjs`);
      await writeFile(
        wrapper,
        `
const originalFetch=globalThis.fetch;
globalThis.fetch=(input,options)=>{const url=new URL(String(input));if(url.origin==='https://roll.duliday.com')return originalFetch(${JSON.stringify(origin)}+url.pathname,options);return originalFetch(input,options);};
process.argv[1]=${JSON.stringify(join(versionRoot, "app/bin/roll.js"))};
await import(${JSON.stringify(pathToFileURL(cli).href)});
`,
      );
      const node = join(
        versionRoot,
        process.platform === "win32" ? "runtime/node.exe" : "runtime/bin/node",
      );
      return await new Promise((resolve, reject) => {
        const child = spawn(node, [wrapper, ...args], {
          cwd: home,
          env,
          stdio: ["ignore", "pipe", "pipe"],
          timeout: 180_000,
        });
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (bytes) => {
          stdout += bytes;
        });
        child.stderr.on("data", (bytes) => {
          stderr += bytes;
        });
        child.on("error", reject);
        child.on("close", (status) => resolve({ status, stdout, stderr }));
      });
    }
    const install = await run(a, ["agent", "install", packageName]);
    assert.equal(install.status, 0, install.stderr);
    const registry = JSON.parse(await readFile(join(home, "agents/agents.json"), "utf8"));
    const installedAgent = registry.agents.find((item) => item.skill.name === "standalone-probe");
    assert.ok(installedAgent);
    const lifecycleBefore = JSON.parse(
      await readFile(join(installedAgent.installPath, "lifecycle.json"), "utf8"),
    );
    assert.equal(lifecycleBefore.node, lifecycleBefore.child);
    assert.ok(lifecycleBefore.node.includes(a));
    await writeFile(join(home, "user-data-marker"), "keep");
    const update = await run(a, ["update"]);
    assert.equal(update.status, 0, update.stderr);
    assert.equal((await readFile(join(root, "current.txt"), "utf8")).trim(), b);
    assert.equal(await readFile(join(home, "user-data-marker"), "utf8"), "keep");
    const lifecycleAfter = JSON.parse(
      await readFile(join(installedAgent.installPath, "lifecycle.json"), "utf8"),
    );
    assert.equal(lifecycleAfter.node, lifecycleAfter.child);
    assert.ok(lifecycleAfter.node.includes(b));
    const invoke = await run(b, ["run", "standalone-probe", "interpreter"]);
    assert.equal(invoke.status, 0, invoke.stderr);
    assert.ok((invoke.stdout + invoke.stderr).includes(b), invoke.stdout + invoke.stderr);
    assert.ok(requests.includes(`/releases/${b}/${assetFilename(b, platform)}`));
    const check = await run(b, ["update", "--check"]);
    assert.equal(check.status, 0, check.stderr);
  },
);
