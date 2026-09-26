import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, win32 } from "node:path";
import { performance } from "node:perf_hooks";

const legacy = win32.join(process.env.SystemRoot, "System32/WindowsPowerShell/v1.0/powershell.exe");
const modern = win32.join(process.env.ProgramFiles, "PowerShell/7/pwsh.exe");
const tickCommand = `$p = Get-Process -Id ${process.pid} -ErrorAction Stop; $p.StartTime.ToUniversalTime().Ticks`;
const directCommand = `[System.Diagnostics.Process]::GetProcessById(${process.pid}).StartTime.ToUniversalTime().Ticks`;
const probes = [
  { label: "legacy-startup", executable: legacy, script: "'started'" },
  { label: "legacy-get-process", executable: legacy, script: tickCommand },
  { label: "legacy-direct-dotnet", executable: legacy, script: directCommand },
  {
    label: "legacy-clean-module-path",
    executable: legacy,
    script: tickCommand,
    cleanModulePath: true,
  },
  { label: "modern-get-process", executable: modern, script: tickCommand },
];
for (const probe of probes) {
  if (!existsSync(probe.executable)) {
    console.log(JSON.stringify({ label: probe.label, missing: true }));
    continue;
  }
  const fixtureHome = mkdtempSync(join(tmpdir(), "roll-identity-diagnostic-"));
  try {
    const env = {
      ...process.env,
      HOME: fixtureHome,
      USERPROFILE: fixtureHome,
      LC_ALL: "C",
      LANG: "C",
      TZ: "UTC",
    };
    if (probe.cleanModulePath) {
      for (const key of Object.keys(env)) if (key.toLowerCase() === "psmodulepath") delete env[key];
    }
    const started = performance.now();
    const result = spawnSync(
      probe.executable,
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `[Console]::Error.WriteLine('script-started'); ${probe.script}`,
      ],
      {
        encoding: "utf8",
        env,
        cwd: fixtureHome,
        timeout: 20_000,
        windowsHide: true,
      },
    );
    console.log(
      JSON.stringify({
        label: probe.label,
        elapsedMs: Math.round(performance.now() - started),
        status: result.status,
        signal: result.signal,
        errorCode: result.error?.code,
        stdout: String(result.stdout ?? "").slice(0, 1000),
        stderr: String(result.stderr ?? "").slice(0, 2000),
      }),
    );
  } finally {
    rmSync(fixtureHome, { recursive: true, force: true });
  }
}
