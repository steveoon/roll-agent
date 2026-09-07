import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
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
import { dirname, join } from "node:path";
import { after, before, test } from "node:test";

const unix = process.platform === "darwin" || process.platform === "linux";
const supported = unix && process.version === "v24.18.0";
const installer = join(import.meta.dirname, "install.sh");
let fixture;
let archive;
let fakeBin;
const platform = `${process.platform}-${process.arch}`;
const version = "1.2.3";
const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;

function command(cmd, args, options = {}) {
  const result = spawnSync(cmd, args, { encoding: "utf8", ...options });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  return result;
}
function publish(bytes, sha = createHash("sha256").update(bytes).digest("hex")) {
  const file = `roll-${version}-${platform}.tar.gz`;
  writeFileSync(join(fixture, "asset"), bytes);
  writeFileSync(join(fixture, "index"), `${version}\t${sha}\t${bytes.length}\t${file}\n`);
}
function install(root, extra = [], env = {}) {
  const home = join(fixture, "smoke-parent-home");
  mkdirSync(home, { recursive: true });
  return spawnSync("/bin/sh", [installer, "--install-dir", root, "--no-modify-path", ...extra], {
    encoding: "utf8",
    env: { ...process.env, HOME: home, PATH: `${fakeBin}:/usr/bin:/bin:/usr/sbin:/sbin`, ...env },
  });
}

before(() => {
  if (!supported) return;
  fixture = mkdtempSync(join(tmpdir(), "roll-installers-"));
  const tree = join(fixture, "tree");
  fakeBin = join(fixture, "fake-bin");
  for (const dir of ["app/bin", "runtime/bin", "runtime/lib/node_modules/npm/bin"]) {
    mkdirSync(join(tree, dir), { recursive: true });
  }
  copyFileSync(process.execPath, join(tree, "runtime/bin/node"));
  chmodSync(join(tree, "runtime/bin/node"), 0o755);
  // Homebrew builds place libnode beside bin; this fixture tests installer isolation,
  // while release CI uses the official standalone Node archive on clean machines.
  if (process.platform === "darwin") {
    const libs = join(dirname(realpathSync(process.execPath)), "../lib");
    if (existsSync(libs)) {
      for (const name of readdirSync(libs).filter((name) => /^libnode.*\.dylib$/.test(name))) {
        copyFileSync(join(libs, name), join(tree, "runtime/lib", name));
      }
    }
  }
  for (const file of ["npm-cli.js", "npx-cli.js"]) {
    writeFileSync(join(tree, "runtime/lib/node_modules/npm/bin", file), "// fixture\n");
  }
  writeFileSync(
    join(tree, "distribution.json"),
    JSON.stringify({
      schemaVersion: 1,
      channel: "standalone",
      version,
      platform,
      nodeVersion: "24.18.0",
    }),
  );
  writeFileSync(
    join(tree, "app/package.json"),
    JSON.stringify({ version, rollDistribution: { schemaVersion: 1, channel: "standalone" } }),
  );
  writeFileSync(
    join(tree, "app/bin/roll.js"),
    `const fs = require('node:fs');
if (process.argv[2] === 'agent') {
  if (process.cwd() !== process.env.HOME) throw new Error('smoke must isolate cwd and HOME');
  fs.writeFileSync(process.env.HOME + '/health-fixture', 'ok');
}
console.log(${JSON.stringify(version)});
`,
  );
  command("tar", [
    "-czf",
    join(fixture, "good.tar.gz"),
    "-C",
    tree,
    "app",
    "runtime",
    "distribution.json",
  ]);
  archive = readFileSync(join(fixture, "good.tar.gz"));
  mkdirSync(fakeBin);
  // Download transport is stubbed; the installer retains its fixed production origin and HTTPS policy.
  writeFileSync(
    join(fakeBin, "curl"),
    `#!/bin/sh
set -eu
url= out=
while [ "$#" -gt 0 ]; do
 case "$1" in
  https://roll.duliday.com/*) url=$1; shift ;;
  -o) out=$2; shift 2 ;;
  *) shift ;;
 esac
done
[ -n "$url" ] && [ -n "$out" ] || exit 91
case "$url" in
 */${platform}.txt) cp ${quote(join(fixture, "index"))} "$out" ;;
 */roll-${version}-${platform}.tar.gz) cp ${quote(join(fixture, "asset"))} "$out" ;;
 *) exit 92 ;;
esac
`,
  );
  chmodSync(join(fakeBin, "curl"), 0o755);
  for (const name of ["node", "npm", "npx"]) {
    writeFileSync(join(fakeBin, name), "#!/bin/sh\necho HOST_RUNTIME_USED >&2\nexit 93\n");
    chmodSync(join(fakeBin, name), 0o755);
  }
});
after(() => {
  if (fixture) rmSync(fixture, { recursive: true, force: true });
});

test(
  "POSIX installer parses as portable shell and keeps the download origin fixed",
  { skip: !unix },
  () => {
    command("/bin/sh", ["-n", installer]);
    const source = readFileSync(installer, "utf8");
    assert.match(source, /ORIGIN='https:\/\/roll\.duliday\.com'/);
    assert.match(source, /--proto '=https'/);
    assert.match(source, /--max-redirs 0/);
    assert.doesNotMatch(source, /curl[^\n]* --location/);
  },
);

test(
  "installs and repeats with hostile PATH, spaces, quotes and Unicode without touching parent home",
  { skip: !supported },
  () => {
    publish(archive);
    const root = join(fixture, "Roll 用户's install");
    const first = install(root);
    assert.equal(first.status, 0, first.stderr);
    assert.equal(readFileSync(join(root, "current.txt"), "utf8"), `${version}\n`);
    assert.equal(existsSync(join(fixture, "smoke-parent-home/health-fixture")), false);
    const result = command(join(root, "bin/roll"), ["--version"], {
      env: { ...process.env, PATH: fakeBin },
    });
    assert.equal(result.stdout.trim(), version);
    const repeated = install(root);
    assert.equal(repeated.status, 0, repeated.stderr);
    assert.equal(existsSync(join(root, ".install-lock")), false);
    writeFileSync(join(root, "versions", version, "app/bin/roll.js"), "modified\n");
    const modified = install(root);
    assert.notEqual(modified.status, 0);
    assert.match(modified.stderr, /differs from the verified release/);
    assert.equal(readFileSync(join(root, "current.txt"), "utf8"), `${version}\n`);
  },
);

test(
  "rejects corruption and preexisting locks without activating or removing the owner's lock",
  { skip: !supported },
  () => {
    publish(archive, "0".repeat(64));
    const root = join(fixture, "corrupt");
    const corrupt = install(root);
    assert.notEqual(corrupt.status, 0);
    assert.match(corrupt.stderr, /checksum mismatch/);
    assert.equal(existsSync(join(root, "current.txt")), false);
    assert.equal(existsSync(join(root, ".install-lock")), false);
    writeFileSync(join(root, "installation.json"), '{"schemaVersion":1,"channel":"standalone"}');
    mkdirSync(join(root, ".install-lock"));
    const locked = install(root);
    assert.notEqual(locked.status, 0);
    assert.match(locked.stderr, /Another install or update/);
    assert.equal(existsSync(join(root, ".install-lock")), true);
  },
);

test(
  "rejects archive links before extraction and rejects malformed release records",
  { skip: !supported },
  () => {
    const links = join(fixture, "links");
    mkdirSync(links);
    symlinkSync("../../escape", join(links, "escape"));
    command("tar", ["-czf", join(fixture, "links.tar.gz"), "-C", links, "escape"]);
    publish(readFileSync(join(fixture, "links.tar.gz")));
    const badLink = install(join(fixture, "unsafe"));
    assert.notEqual(badLink.status, 0);
    assert.match(badLink.stderr, /links or special files/);
    publish(archive);
    writeFileSync(join(fixture, "index"), readFileSync(join(fixture, "index"), "utf8") + "extra\n");
    const index = install(join(fixture, "bad-index"));
    assert.notEqual(index.status, 0);
    assert.match(index.stderr, /Invalid release index/);
  },
);

test("PowerShell installer validates ZIP paths, private runtime, and atomic activation", () => {
  const source = readFileSync(join(import.meta.dirname, "install.ps1"), "utf8");
  assert.match(source, /\$Origin = 'https:\/\/roll\.duliday\.com'/);
  assert.match(source, /-MaximumRedirection 0/);
  assert.match(source, /Archive contains links or special files/);
  assert.match(source, /\[IO\.File\]::Replace/);
  assert.match(source, /DisableDelayedExpansion/);
  assert.match(source, /runtime\\node_modules\\npm\\bin\\npm-cli\.js/);
});

test(
  "Windows installs, launches Unicode paths, repeats and rejects a corrupted release",
  { skip: process.platform !== "win32" || process.version !== "v24.18.0" },
  () => {
    const temporary = mkdtempSync(join(tmpdir(), "roll-installer-win-"));
    const psQuote = (value) => `'${value.replaceAll("'", "''")}'`;
    const powershell = join(
      process.env.SystemRoot,
      "System32/WindowsPowerShell/v1.0/powershell.exe",
    );
    const run = (script) => {
      const scriptPath = join(temporary, "test.ps1");
      // BOM lets Windows PowerShell 5.1 decode Unicode test paths correctly.
      writeFileSync(scriptPath, `\uFEFF$ErrorActionPreference = 'Stop'\n${script}`);
      return spawnSync(
        powershell,
        ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", scriptPath],
        {
          encoding: "utf8",
        },
      );
    };
    try {
      const tree = join(temporary, "tree");
      for (const dir of ["app/bin", "runtime/node_modules/npm/bin"]) {
        mkdirSync(join(tree, dir), { recursive: true });
      }
      copyFileSync(process.execPath, join(tree, "runtime/node.exe"));
      for (const cli of ["npm", "npx"]) {
        writeFileSync(join(tree, `runtime/node_modules/npm/bin/${cli}-cli.js`), "// fixture\n");
      }
      writeFileSync(
        join(tree, "distribution.json"),
        JSON.stringify({
          schemaVersion: 1,
          channel: "standalone",
          version,
          platform,
          nodeVersion: "24.18.0",
        }),
      );
      writeFileSync(
        join(tree, "app/package.json"),
        JSON.stringify({ version, rollDistribution: { schemaVersion: 1, channel: "standalone" } }),
      );
      writeFileSync(join(tree, "app/bin/roll.js"), `console.log(${JSON.stringify(version)});`);
      const zipPath = join(temporary, "archive.zip");
      const zipped = run(
        `Compress-Archive -Path ${psQuote(join(tree, "*"))} -DestinationPath ${psQuote(zipPath)}`,
      );
      assert.equal(zipped.status, 0, zipped.stderr);
      const bytes = readFileSync(zipPath);
      const sha = createHash("sha256").update(bytes).digest("hex");
      const indexPath = join(temporary, "index");
      writeFileSync(
        indexPath,
        `${version}\t${sha}\t${bytes.length}\troll-${version}-${platform}.zip\n`,
      );
      const source = readFileSync(join(import.meta.dirname, "install.ps1"), "utf8");
      const localInstaller = join(temporary, "install.ps1");
      writeFileSync(
        localInstaller,
        `\uFEFF${source.replace(
          "Invoke-WebRequest -Uri $Url -OutFile $Destination -UseBasicParsing -MaximumRedirection 0 -TimeoutSec 900",
          `if ($Url.EndsWith('.txt')) { Copy-Item -LiteralPath ${psQuote(indexPath)} -Destination $Destination } else { Copy-Item -LiteralPath ${psQuote(zipPath)} -Destination $Destination }`,
        )}`,
      );
      const root = join(temporary, "Roll 用户's install");
      const installScript = `& ${psQuote(localInstaller)} -InstallDir ${psQuote(root)} -NoModifyPath`;
      for (let repeat = 0; repeat < 2; repeat++) {
        const result = run(
          `${installScript}\n& ${psQuote(join(root, "bin/roll.cmd"))} --version\nif ($LASTEXITCODE -ne 0) { throw 'launcher failed' }`,
        );
        assert.equal(result.status, 0, result.stderr);
        assert.equal(readFileSync(join(root, "current.txt"), "utf8"), `${version}\n`);
      }
      writeFileSync(
        indexPath,
        `${version}\t${"0".repeat(64)}\t${bytes.length}\troll-${version}-${platform}.zip\n`,
      );
      const corrupt = run(installScript);
      assert.notEqual(corrupt.status, 0);
      assert.match(corrupt.stderr, /checksum mismatch/);
      assert.equal(readFileSync(join(root, "current.txt"), "utf8"), `${version}\n`);
    } finally {
      rmSync(temporary, { recursive: true, force: true });
    }
  },
);
