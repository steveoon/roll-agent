import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { performance } from "node:perf_hooks";

const original = childProcess.spawnSync;
childProcess.spawnSync = function (command, args, options) {
  const started = performance.now();
  const result = original(command, args, options);
  if (/\\(?:powershell|pwsh)\.exe$/iu.test(command)) {
    process.stderr.write(
      `${JSON.stringify({
        diagnostic: "identity-probe",
        executable: command,
        elapsedMs: Math.round(performance.now() - started),
        timeoutMs: options?.timeout,
        status: result.status,
        signal: result.signal,
        errorCode: result.error?.code,
        stdout: String(result.stdout ?? "").slice(0, 1200),
        stderr: String(result.stderr ?? "").slice(0, 2000),
      })}\n`,
    );
  }
  return result;
};
syncBuiltinESMExports();
