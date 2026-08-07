import { spawn } from "node:child_process";

const MAX_PROCESS_OUTPUT_BYTES = 1024 * 1024;

export interface ProcessInvocation {
  readonly command: string;
  readonly args: readonly string[];
  readonly input?: string;
}

export interface ProcessResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface ProcessRunner {
  run(invocation: ProcessInvocation): Promise<ProcessResult>;
}

export class SpawnProcessRunner implements ProcessRunner {
  async run(invocation: ProcessInvocation): Promise<ProcessResult> {
    return new Promise<ProcessResult>((resolve, reject) => {
      const child = spawn(invocation.command, [...invocation.args], {
        shell: false,
        stdio: "pipe",
        windowsHide: true,
      });
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let stdoutBytes = 0;
      let stderrBytes = 0;
      child.stdout.on("data", (chunk: Buffer) => {
        stdoutBytes += chunk.length;
        if (stdoutBytes <= MAX_PROCESS_OUTPUT_BYTES) {
          stdout.push(chunk);
        }
      });
      child.stderr.on("data", (chunk: Buffer) => {
        stderrBytes += chunk.length;
        if (stderrBytes <= MAX_PROCESS_OUTPUT_BYTES) {
          stderr.push(chunk);
        }
      });
      child.once("error", reject);
      child.once("close", (code) => {
        resolve({
          code: code ?? 1,
          stdout: Buffer.concat(stdout).toString("utf8"),
          stderr: Buffer.concat(stderr).toString("utf8"),
        });
      });
      if (invocation.input !== undefined) {
        child.stdin.end(invocation.input);
      } else {
        child.stdin.end();
      }
    });
  }
}

export async function runChecked(
  runner: ProcessRunner,
  invocation: ProcessInvocation,
  failureMessage: string,
): Promise<ProcessResult> {
  const result = await runner.run(invocation);
  if (result.code !== 0) {
    throw new Error(failureMessage);
  }
  return result;
}
