import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { performance } from "node:perf_hooks";

const original = childProcess.spawnSync;
const originalSpawn = childProcess.spawn;
childProcess.spawn = function (command, args, options) {
  const child = originalSpawn(command, args, options);
  if (/\\(?:powershell|pwsh)\.exe$/iu.test(command)) {
    process.stderr.write(
      `${JSON.stringify({ diagnostic: "async-powershell-start", command, script: String(args?.at(-1)).slice(0, 2000) })}\n`,
    );
    child.once("close", (code) =>
      process.stderr.write(`${JSON.stringify({ diagnostic: "async-powershell-close", code })}\n`),
    );
  }
  return child;
};
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
