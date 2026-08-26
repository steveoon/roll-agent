import assert from "node:assert/strict";
import test from "node:test";
import { createCompanionUserIdentityCheck, parseWindowsUserSid } from "./identity.ts";
import type { ProcessInvocation, ProcessResult, ProcessRunner } from "./process-runner.ts";

test("macOS Companion identity rejects root", async () => {
  await assert.rejects(
    createCompanionUserIdentityCheck({ platform: "darwin", uid: 0 })(),
    /must not run as root/u,
  );
  await createCompanionUserIdentityCheck({ platform: "darwin", uid: 501 })();
});

test("Windows Companion identity uses absolute whoami and rejects service accounts", async () => {
  const runner = new IdentityRunner('"NT AUTHORITY\\SYSTEM","S-1-5-18"');
  await assert.rejects(
    createCompanionUserIdentityCheck({
      platform: "win32",
      runner,
      windowsDirectory: "D:\\Windows",
    })(),
    /must not run as a Windows service account/u,
  );
  assert.equal(runner.invocations[0]?.command, "D:\\Windows\\System32\\whoami.exe");
});

test("Windows Companion identity accepts a regular current-user SID", async () => {
  const runner = new IdentityRunner('"ACME\\tester","S-1-5-21-1-2-3-1001"');
  await createCompanionUserIdentityCheck({
    platform: "win32",
    runner,
    windowsDirectory: "D:\\Windows",
  })();
});

class IdentityRunner implements ProcessRunner {
  readonly invocations: ProcessInvocation[] = [];
  private readonly stdout: string;

  constructor(stdout: string) {
    this.stdout = stdout;
  }

  async run(invocation: ProcessInvocation): Promise<ProcessResult> {
    this.invocations.push(invocation);
    return { code: 0, stdout: this.stdout, stderr: "" };
  }
}

test("parseWindowsUserSid 从 whoami csv 输出提取并大写 SID", () => {
  assert.equal(
    parseWindowsUserSid('"DESKTOP\\tester","s-1-5-21-1111-2222-3333-1001"\r\n'),
    "S-1-5-21-1111-2222-3333-1001",
  );
  assert.equal(parseWindowsUserSid("garbage"), undefined);
  assert.equal(parseWindowsUserSid(""), undefined);
});
