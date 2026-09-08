import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { assetFilename, NODE_VERSION, sha256 } from "./metadata.mjs";

const psQuote = (value) => `'${value.replaceAll("'", "''")}'`;
const download =
  "Invoke-WebRequest -Uri $Url -OutFile $Destination -UseBasicParsing -MaximumRedirection 0 -TimeoutSec 900";

// Only the test's copy substitutes transport. Production still requires its fixed HTTPS origin.
function localInstallerSource(source, index, archive) {
  assert.equal(source.split(download).length, 2, "installer download seam must match exactly once");
  return `\uFEFF${source.replace(
    download,
    `if ($Url.EndsWith('.txt')) { [IO.File]::Copy(${psQuote(index)}, $Destination, $true) } else { [IO.File]::Copy(${psQuote(archive)}, $Destination, $true) }`,
  )}`;
}

async function run(command, args, options) {
  const child = spawn(command, args, { ...options, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  let childError;
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  child.on("error", (error) => {
    childError = error;
  });
  return await new Promise((resolve, reject) =>
    child.on("close", (status) => {
      if (childError) reject(childError);
      else resolve({ status, stdout, stderr });
    }),
  );
}

function success(result) {
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  return result.stdout;
}

async function longestFile(root) {
  let longest = "";
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    const file = entry.isDirectory() ? await longestFile(path) : path;
    if (file.length > longest.length) longest = file;
  }
  return longest;
}

test(
  "complete Windows ZIP installs using PowerShell 5.1 with long paths disabled",
  {
    skip: process.platform !== "win32" || !process.env.ROLL_TEST_DISTRIBUTION_ARCHIVE,
    timeout: 900_000,
  },
  async (t) => {
    const archive = resolve(process.env.ROLL_TEST_DISTRIBUTION_ARCHIVE);
    const platform = `win32-${process.arch}`;
    const name = archive.split(/[\\/]/).at(-1);
    const version = name.match(/^roll-(\d+\.\d+\.\d+)-win32-(?:x64|arm64)\.zip$/)?.[1];
    assert.ok(version, `Unexpected archive name: ${name}`);
    assert.equal(name, assetFilename(version, platform));
    const home = await mkdtemp(join(tmpdir(), "Roll Windows 用户's installation "));
    let handedOff = false;
    const phase = (label) => console.log(`[Windows installation] ${label}`);
    const heartbeat = setInterval(() => phase("acceptance test still running"), 30_000);
    t.after(async () => {
      clearInterval(heartbeat);
      if (!handedOff) await rm(home, { recursive: true, force: true });
    });
    const powershell = join(
      process.env.SystemRoot,
      "System32/WindowsPowerShell/v1.0/powershell.exe",
    );
    const localAppData = join(home, "AppData/Local");
    const root = join(localAppData, "Roll");
    const bait = join(home, "bait");
    await mkdir(bait);
    await mkdir(localAppData, { recursive: true });
    await writeFile(join(home, "roll.config.yaml"), "{}\n");
    for (const tool of ["node", "npm", "npx"]) {
      await writeFile(join(bait, `${tool}.cmd`), "@echo HOST_RUNTIME_USED 1>&2\r\n@exit /b 99\r\n");
    }
    // Avoid inheriting a runner's duplicate Path/PATH key or configured user data directories.
    const env = Object.fromEntries(
      Object.entries(process.env).filter(
        ([name]) =>
          !/^(path|node_options|node_path|roll_config|roll_config_path|home|userprofile|localappdata|appdata|xdg_.*)$/i.test(
            name,
          ),
      ),
    );
    Object.assign(env, {
      PATH: `${bait};${process.env.SystemRoot}\\System32;${process.env.SystemRoot}`,
      HOME: home,
      USERPROFILE: home,
      LOCALAPPDATA: localAppData,
      APPDATA: join(home, "AppData/Roaming"),
      XDG_CONFIG_HOME: home,
      XDG_DATA_HOME: home,
      XDG_CACHE_HOME: home,
    });
    const index = join(home, "index.txt");
    const hash = await sha256(archive);
    const size = (await stat(archive)).size;
    const publish = (digest = hash) =>
      writeFile(index, `${version}\t${digest}\t${size}\t${name}\n`);
    await publish();
    const installer = join(home, "install.ps1");
    await writeFile(
      installer,
      localInstallerSource(
        await readFile(join(import.meta.dirname, "install.ps1"), "utf8"),
        index,
        archive,
      ),
    );
    const ps = async (script) => {
      const file = join(home, "invoke.ps1");
      await writeFile(
        file,
        `\uFEFF$ErrorActionPreference = 'Stop'\nif ($PSVersionTable.PSVersion.Major -ne 5 -or $PSVersionTable.PSVersion.Minor -ne 1) { throw 'Expected Windows PowerShell 5.1' }\n${script}\n`,
      );
      return run(powershell, ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", file], {
        cwd: home,
        env,
        signal: t.signal,
        timeout: 300_000,
      });
    };
    phase("asserting system policy and legacy failure boundary");
    success(
      await ps(`
$Policy = Get-ItemPropertyValue -LiteralPath 'HKLM:\\SYSTEM\\CurrentControlSet\\Control\\FileSystem' -Name LongPathsEnabled -ErrorAction SilentlyContinue
if ($Policy -eq 1) { throw 'Acceptance requires LongPathsEnabled disabled; configure the dedicated CI step first' }
`),
    );
    phase("installing full archive at the default LOCALAPPDATA path");
    const install = `& ${psQuote(installer)} -NoModifyPath`;
    success(await ps(install));
    assert.equal(await readFile(join(root, "current.txt"), "utf8"), `${version}\n`);
    const versionRoot = join(root, "versions", version);
    const longest = await longestFile(versionRoot);
    assert.ok(
      longest.length > 260,
      `Fixture must exercise a path beyond MAX_PATH: ${longest.length}`,
    );
    await access(longest);
    assert.ok(dirname(longest).length >= 248, "fixture must exceed the legacy directory limit");
    // Reproduce the old System.IO API's failure on this package without creating any directory.
    success(
      await ps(`
$Failed = $false
try { [IO.Directory]::CreateDirectory(${psQuote(dirname(longest))}) | Out-Null }
catch [IO.PathTooLongException] { $Failed = $true }
if (!$Failed) { throw 'Legacy MAX_PATH counterexample did not reproduce in this process' }
`),
    );
    phase("checking stable launcher, SQLite, UI, ripgrep, npm and actual interpreter");
    const launcher = join(root, "bin/roll.cmd");
    assert.ok(
      success(
        await ps(
          `& ${psQuote(launcher)} --version\nif ($LASTEXITCODE -ne 0) { throw 'launcher failed' }`,
        ),
      ).includes(version),
    );
    const privateNode = join(versionRoot, "runtime/node.exe");
    assert.equal(
      success(await run(privateNode, ["--version"], { env, cwd: home, signal: t.signal })).trim(),
      `v${NODE_VERSION}`,
    );
    await access(join(versionRoot, "app/dist/ui-assets/index.html"));
    const probe = join(home, "probe.mjs");
    await writeFile(
      probe,
      `
import { DatabaseSync } from 'node:sqlite';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
const db = new DatabaseSync(':memory:');
if (db.prepare('select 42 as value').get().value !== 42) throw Error('SQLite failure');
db.close();
const require = createRequire(${JSON.stringify(join(versionRoot, "app/package.json"))});
const runtimeRequire = createRequire(require.resolve('@roll-agent/runtime'));
await import(pathToFileURL(require.resolve('@roll-agent/runtime')).href);
const { rgPath } = await import(pathToFileURL(runtimeRequire.resolve('@vscode/ripgrep')).href);
if (spawnSync(rgPath, ['--version']).status !== 0) throw Error('ripgrep failure');
console.log(process.execPath);
`,
    );
    assert.equal(
      success(await run(privateNode, [probe], { env, cwd: home, signal: t.signal })).trim(),
      privateNode,
    );
    success(
      await run(
        privateNode,
        [join(versionRoot, "runtime/node_modules/npm/bin/npm-cli.js"), "--version"],
        { env, cwd: home, signal: t.signal },
      ),
    );
    phase("repeating installation without modifying immutable files");
    success(await ps(install));
    phase("rejecting corruption without changing the active version");
    await publish("0".repeat(64));
    const corrupt = await ps(install);
    assert.notEqual(corrupt.status, 0);
    assert.match(corrupt.stderr + corrupt.stdout, /checksum mismatch/i);
    await publish();
    assert.equal(await readFile(join(root, "current.txt"), "utf8"), `${version}\n`);
    phase("preserving another installer's lock");
    const lock = join(root, ".install-lock");
    await mkdir(lock);
    const locked = await ps(install);
    assert.notEqual(locked.status, 0);
    await access(lock);
    await rm(lock, { recursive: true });
    phase("rejecting unsafe launcher version pointers");
    for (const pointer of ["..", "abc", "1.2.3%PATH%", "1.2.3!BANG!"]) {
      await writeFile(join(root, "current.txt"), `${pointer}\n`);
      const rejected = await ps(`& ${psQuote(launcher)} --version\nexit $LASTEXITCODE`);
      assert.notEqual(rejected.status, 0);
    }
    await writeFile(join(root, "current.txt"), `${version}\n`);
    const resultPath = process.env.ROLL_TEST_WINDOWS_INSTALLATION_RESULT;
    if (resultPath) {
      await writeFile(resultPath, JSON.stringify({ root, home, version, archive, sha256: hash }), {
        flag: "wx",
      });
      handedOff = true;
      phase("handing installed version A to native upgrade acceptance");
    }
  },
);
