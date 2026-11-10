// Real packaged production Main/preload/renderer/Runtime; controlled loopback model only.
// Usage: node scripts/validate-packaged-current-cli.mjs <packaged executable> <new owned root>
import assert from "node:assert/strict";
import { createServer } from "node:http";
import {
  mkdirSync,
  lstatSync,
  writeFileSync,
  readFileSync,
  realpathSync,
  readdirSync,
} from "node:fs";
import { resolve, dirname } from "node:path";
import { spawn } from "node:child_process";
import {
  isProcessAlive,
  operatePackagedWindow,
  readWindowsProcessTree,
  waitUntil,
} from "./current-cli-windows-processes.mjs";

const [executable, rootArgument, mode = "normal"] = process.argv.slice(2);
assert.ok(["normal", "cancel", "close"].includes(mode));
assert.ok(executable && rootArgument);
const root = resolve(rootArgument);
assert.equal(lstatSync(root, { throwIfNoEntry: false }), undefined, "Require a new isolated root");
for (let parent = root; ; parent = dirname(parent)) {
  for (const name of ["roll.config.yaml", "roll.config.yml"]) {
    assert.equal(lstatSync(resolve(parent, name), { throwIfNoEntry: false }), undefined);
  }
  if (dirname(parent) === parent) break;
}
mkdirSync(root, { recursive: true });
const home = resolve(root, "home");
const workspace = resolve(root, "workspace");
const profile = resolve(root, "desktop-data");
const library = resolve(root, "history");
for (const path of [home, workspace, profile]) mkdirSync(path, { mode: 0o700 });
for (const name of ["Roaming", "Local"]) {
  mkdirSync(resolve(home, "AppData", name), { recursive: true });
}
writeFileSync(
  resolve(profile, "locale-preference.json"),
  JSON.stringify({ version: 1, preference: "en" }),
);
const marker = "NESTED_CURRENT_ROLL_AGENT_LIST_OK";
const windows = process.platform === "win32";
assert.ok(mode === "normal" || windows, "Lifecycle modes currently target Windows production apps");
const command =
  mode !== "normal"
    ? "roll chat --json 'hold-cli-lifecycle'"
    : windows
      ? `$ErrorActionPreference='Stop'; $found=Get-Command roll -ErrorAction Stop; $json=roll agent list --json; if($LASTEXITCODE -ne 0){throw 'nested roll failed'}; $items=@(ConvertFrom-Json -InputObject ($json -join [Environment]::NewLine)); if($items.Count -ne 0){throw 'expected isolated empty registry'}; Write-Output ('${marker} '+$found.Source+' '+$env:ROLL_CURRENT_CLI)`
      : `set -e; resolved=$(command -v roll); result=$(roll agent list --json); test "$result" = '[]'; printf '%s %s %s\\n' '${marker}' "$resolved" "$ROLL_CURRENT_CLI"`;
let calls = 0;
let toolName;
let verified = false;
let providerError;
let held = false;
let nativeBridgeObserved = false;
function observeNativeBridge() {
  nativeBridgeObserved = readdirSync(root).some(
    (name) =>
      name.startsWith("roll-current-cli-") &&
      lstatSync(resolve(root, name, "launch.ps1"), { throwIfNoEntry: false })?.isFile(),
  );
  if (windows && /[^\u0020-\u007e]/u.test(executable)) {
    assert.equal(
      nativeBridgeObserved,
      true,
      "Unicode packaged launch must exercise the actual native bridge",
    );
  }
}
const server = createServer((request, response) => {
  const chunks = [];
  let bytes = 0;
  request.on("data", (chunk) => {
    bytes += chunk.length;
    if (bytes > 2 * 1024 * 1024) request.destroy();
    else chunks.push(chunk);
  });
  request.on("end", () => {
    try {
      calls++;
      assert.equal(request.url, "/v1/chat/completions");
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      writeFileSync(
        resolve(root, `provider-request-${calls}.json`),
        JSON.stringify(
          {
            user: body.messages.filter((message) => message.role === "user"),
            tools: body.tools?.map((tool) => tool.function?.name),
          },
          null,
          2,
        ),
      );
      if (
        mode !== "normal" &&
        body.messages.some(
          (message) =>
            message.role === "user" &&
            JSON.stringify(message.content ?? "").includes("hold-cli-lifecycle"),
        )
      ) {
        assert.equal(calls, 2, "Nested real CLI must reach the controlled model");
        held = true;
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.write(": controlled inference held for cancellation\n\n");
        return;
      }
      let delta;
      let finish;
      if (calls === 1) {
        const suffix = windows ? "__powershell" : "__bash";
        toolName = body.tools.find((tool) => tool.function?.name.endsWith(suffix))?.function.name;
        assert.ok(toolName, "Production shell tool must be advertised");
        delta = {
          tool_calls: [
            {
              index: 0,
              id: "nested-roll-proof",
              type: "function",
              function: {
                name: toolName,
                arguments: JSON.stringify({ command, workdir: workspace, timeout_ms: 30000 }),
              },
            },
          ],
        };
        finish = "tool_calls";
      } else {
        assert.equal(calls, 2);
        const tool = body.messages.findLast((message) => message.role === "tool");
        assert.equal(typeof tool?.content, "string");
        writeFileSync(resolve(root, "actual-tool-result.json"), tool.content);
        assert.ok(tool.content.includes(marker), tool.content);
        assert.ok(
          tool.content.includes("roll-current-cli-"),
          "Actual private shim must be resolved",
        );
        assert.ok(!tool.content.includes("The system cannot find the path specified"));
        verified = true;
        observeNativeBridge();
        delta = { content: "ROLL_PROTOCOL_V1_OK" };
        finish = "stop";
      }
      response.writeHead(200, { "content-type": "text/event-stream" });
      const row = {
        id: "isolated",
        object: "chat.completion.chunk",
        created: 1,
        model: "qwen3.7-plus",
        choices: [{ index: 0, delta, finish_reason: null }],
      };
      response.end(
        `data: ${JSON.stringify(row)}\n\ndata: ${JSON.stringify({ ...row, choices: [{ index: 0, delta: {}, finish_reason: finish }] })}\n\ndata: [DONE]\n\n`,
      );
    } catch (error) {
      providerError ??= error;
      response.writeHead(500);
      response.end("Bounded fixture assertion failed");
      console.error("NESTED_ROLL_PROVIDER_ASSERTION", String(error.message).slice(0, 2000));
    }
  });
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
writeFileSync(
  resolve(workspace, "roll.config.yaml"),
  `llm:
  default-provider: qwen
  default-model: qwen3.7-plus
  providers:
    qwen:
      api-key: isolated-local-fixture
      base-url: http://127.0.0.1:${server.address().port}/v1
agents:
  data-dir: ${JSON.stringify(resolve(home, "agents"))}
runtime:
  threads-dir: ${JSON.stringify(library)}
  approval:
    default: auto
    overrides:
      roll.bash: auto
      roll.powershell: auto
  shell:
    enabled: true
    auto-approve-safe: false
`,
);
const system = process.env.SystemRoot ?? "C:\\Windows";
const env = {
  HOME: home,
  USERPROFILE: home,
  PATH: windows ? `${system}\\System32` : "/usr/bin:/bin",
  SystemRoot: system,
  WINDIR: system,
  ...(windows
    ? {
        PATHEXT: process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD",
        ComSpec: `${system}\\System32\\cmd.exe`,
      }
    : {}),
  ...(windows
    ? Object.fromEntries(
        Object.entries(process.env).filter(([key]) =>
          /^ProgramFiles(?:\(.*\))?$|^ProgramW6432$/iu.test(key),
        ),
      )
    : {}),
  ...(windows && process.env.ROLL_VALIDATION_PWSH_ROOT
    ? {
        ProgramFiles: process.env.ROLL_VALIDATION_PWSH_ROOT,
        ProgramW6432: process.env.ROLL_VALIDATION_PWSH_ROOT,
      }
    : {}),
  APPDATA: resolve(home, "AppData/Roaming"),
  LOCALAPPDATA: resolve(home, "AppData/Local"),
  TEMP: root,
  TMP: root,
  NO_PROXY: "127.0.0.1",
  no_proxy: "127.0.0.1",
  NO_COLOR: "1",
};
let debugPort;
if (mode !== "normal") {
  const reservation = createServer();
  await new Promise((resolve) => reservation.listen(0, "127.0.0.1", resolve));
  debugPort = reservation.address().port;
  await new Promise((resolve) => reservation.close(resolve));
}
const child = spawn(
  resolve(executable),
  [
    "--workspace",
    workspace,
    ...(mode === "normal" ? ["--smoke"] : []),
    `--user-data-dir=${profile}`,
    ...(debugPort
      ? [`--remote-debugging-port=${debugPort}`, "--remote-debugging-address=127.0.0.1"]
      : []),
  ],
  {
    cwd: workspace,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  },
);
let stdout = "";
let stderr = "";
child.stdout.on("data", (chunk) => {
  stdout += chunk;
});
child.stderr.on("data", (chunk) => {
  stderr += chunk;
});
const timer = setTimeout(() => child.kill("SIGTERM"), 150000);
const sentinel =
  mode === "normal"
    ? undefined
    : spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: "ignore" });
let owned = [];
const lifecycle =
  mode === "normal"
    ? Promise.resolve()
    : (async () => {
        await operatePackagedWindow(debugPort, "start");
        await waitUntil(
          () => {
            assert.ifError(providerError);
            return held;
          },
          "nested CLI entered model inference",
          60000,
        );
        owned = readWindowsProcessTree(child.pid);
        observeNativeBridge();
        assert.ok(
          owned.filter((row) => row.Name === "node.exe").length >= 2,
          "Observe both host Core and nested Roll process",
        );
        assert.ok(!owned.some((row) => row.ProcessId === sentinel.pid));
        writeFileSync(resolve(root, "owned-before-action.json"), JSON.stringify(owned, null, 2));
        await operatePackagedWindow(debugPort, mode);
        if (mode === "cancel") {
          const parentById = new Map(owned.map((row) => [row.ProcessId, row.ParentProcessId]));
          const depth = (row) => {
            let result = 0;
            for (let pid = row.ProcessId; parentById.has(pid); pid = parentById.get(pid)) result++;
            return result;
          };
          const hostCore = owned
            .filter((row) => row.Name === "node.exe")
            .sort((a, b) => depth(a) - depth(b))[0];
          const shellRoots = owned.filter(
            (row) => row.ParentProcessId === hostCore.ProcessId && row.Name === "pwsh.exe",
          );
          assert.equal(shellRoots.length, 1, "Observe the admitted PowerShell tool root");
          // The host Runtime can own its own conhost.exe. Stop must preserve it;
          // the admitted tool's subtree is the cancellation boundary.
          const toolIds = new Set([shellRoots[0].ProcessId]);
          for (let changed = true; changed; ) {
            changed = false;
            for (const row of owned) {
              if (toolIds.has(row.ParentProcessId) && !toolIds.has(row.ProcessId)) {
                toolIds.add(row.ProcessId);
                changed = true;
              }
            }
          }
          assert.ok(toolIds.size >= 2);
          await waitUntil(
            () => [...toolIds].every((pid) => !isProcessAlive(pid)),
            "Stop settled the nested CLI tool tree",
          );
          assert.equal(isProcessAlive(hostCore.ProcessId), true, "Stop preserves the host Runtime");
          assert.equal(isProcessAlive(child.pid), true, "Stop preserves the app");
          assert.equal(isProcessAlive(sentinel.pid), true);
          await operatePackagedWindow(debugPort, "close");
        }
      })();
lifecycle.catch((error) => {
  writeFileSync(
    resolve(root, "lifecycle-error.json"),
    JSON.stringify(
      {
        error: String(error),
        processes: owned.map((row) => ({ ...row, alive: isProcessAlive(row.ProcessId) })),
      },
      null,
      2,
    ),
  );
  child.kill("SIGTERM");
});
try {
  const code = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", resolve);
  });
  await lifecycle;
  writeFileSync(
    resolve(root, "packaged-output.json"),
    JSON.stringify({ code, calls, stdout, stderr }, null, 2),
  );
  assert.ifError(providerError);
  if (mode !== "normal") {
    assert.equal(code, 0, "Normal production shutdown after Stop/close");
    await waitUntil(
      () => owned.every((row) => !isProcessAlive(row.ProcessId)),
      "all fixture-owned app/CLI descendants exited",
    );
    assert.equal(isProcessAlive(sentinel.pid), true, "Unrelated process must survive");
    console.log(
      "PACKAGED_NESTED_ROLL_LIFECYCLE_OK " +
        JSON.stringify({
          mode,
          executable,
          hostArch: process.arch,
          calls,
          ownedProcesses: owned.length,
          sentinelSurvived: true,
          nativeBridgeObserved,
          root,
        }),
    );
    process.exitCode = 0;
  } else {
    assert.equal(code, 0, stderr.slice(-6000));
    assert.match(stdout, /ROLL_MVP_SMOKE_OK/);
    assert.equal(calls, 2);
    assert.equal(verified, true);
    const metadata = JSON.parse(readFileSync(resolve(profile, "desktop-projects.json"), "utf8"));
    assert.ok(metadata.projects.some((project) => project.path === realpathSync.native(workspace)));
    console.log(
      "PACKAGED_NESTED_CURRENT_ROLL_OK " +
        JSON.stringify({
          platform: process.platform,
          hostArch: process.arch,
          executable,
          toolName,
          nativeBridgeObserved,
          calls,
          root,
        }),
    );
  }
} finally {
  clearTimeout(timer);
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  sentinel?.kill();
}
