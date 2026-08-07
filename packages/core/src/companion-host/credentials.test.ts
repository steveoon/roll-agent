import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { deviceIdSchema } from "@roll-agent/relay-protocol";
import { MacOsKeychainCredentialStore, WindowsDpapiCredentialStore } from "./credentials.ts";
import type { ProcessInvocation, ProcessResult, ProcessRunner } from "./process-runner.ts";

class RecordingRunner implements ProcessRunner {
  readonly invocations: ProcessInvocation[] = [];
  private readonly stdout: string;

  constructor(stdout = "") {
    this.stdout = stdout;
  }

  async run(invocation: ProcessInvocation): Promise<ProcessResult> {
    this.invocations.push(invocation);
    return { code: 0, stdout: this.stdout, stderr: "" };
  }
}

const DEVICE_ID = "11111111-1111-4111-8111-111111111111";

test("macOS Keychain writer keeps device credential out of process argv", async () => {
  const secret = "device-credential-never-in-argv";
  const runner = new RecordingRunner();
  const store = new MacOsKeychainCredentialStore(runner);
  const reference = await store.put(deviceIdSchema.parse(DEVICE_ID), secret);
  assert.equal(reference, `keychain:${DEVICE_ID}`);
  assert.equal(runner.invocations.length, 1);
  const invocation = runner.invocations[0];
  if (invocation === undefined) {
    throw new Error("Expected a Keychain process invocation");
  }
  assert.equal(invocation.command, "/usr/bin/security");
  assert.deepEqual(invocation.args, ["-i"]);
  assert.equal(invocation.args.join(" ").includes(secret), false);
  assert.equal(
    invocation.input,
    `add-generic-password -U -a "${DEVICE_ID}" -s "dev.roll-agent.companion.device" -w "${secret}"\n`,
  );
});

test("macOS Keychain writer escapes quotes and backslashes in the command stream", async () => {
  const secret = String.raw`a b"c\d$e'f`;
  const runner = new RecordingRunner();
  const store = new MacOsKeychainCredentialStore(runner);
  await store.put(deviceIdSchema.parse(DEVICE_ID), secret);
  const invocation = runner.invocations[0];
  if (invocation === undefined) {
    throw new Error("Expected a Keychain process invocation");
  }
  assert.equal(
    invocation.input,
    `add-generic-password -U -a "${DEVICE_ID}" -s "dev.roll-agent.companion.device" -w "a b\\"c\\\\d$e'f"\n`,
  );
});

test("macOS Keychain writer rejects credentials that cannot round-trip through security", async () => {
  const runner = new RecordingRunner();
  const store = new MacOsKeychainCredentialStore(runner);
  const deviceId = deviceIdSchema.parse(DEVICE_ID);
  for (const secret of [
    'a"\ndelete-generic-password -a "x',
    "a\rb",
    "unicode-花卷-Ω",
    "café",
    "a\u0000b",
    "a\u007Fb",
    "a\tb",
  ]) {
    await assert.rejects(
      () => store.put(deviceId, secret),
      /must contain printable ASCII characters only/u,
    );
  }
  assert.equal(runner.invocations.length, 0);
});

test("macOS Keychain writer rejects an empty credential", async () => {
  const runner = new RecordingRunner();
  const store = new MacOsKeychainCredentialStore(runner);
  await assert.rejects(() => store.put(deviceIdSchema.parse(DEVICE_ID), ""), /must not be empty/u);
  assert.equal(runner.invocations.length, 0);
});

test("macOS Keychain writer surfaces a non-zero security exit code", async () => {
  const runner: ProcessRunner = {
    async run(): Promise<ProcessResult> {
      return { code: 44, stdout: "", stderr: "security: item could not be found" };
    },
  };
  const store = new MacOsKeychainCredentialStore(runner);
  await assert.rejects(
    () => store.put(deviceIdSchema.parse(DEVICE_ID), "secret"),
    /Unable to save the Companion device credential in macOS Keychain/u,
  );
});

test("Windows DPAPI uses an absolute System32 PowerShell and keeps credentials off argv", async () => {
  const root = await mkdtemp(join(tmpdir(), "roll-companion-dpapi-"));
  try {
    const secret = "device-credential-never-in-argv";
    const runner = new RecordingRunner();
    const store = new WindowsDpapiCredentialStore(root, runner, "D:\\Windows");
    const reference = await store.put(
      deviceIdSchema.parse("11111111-1111-4111-8111-111111111111"),
      secret,
    );
    const invocation = runner.invocations[0];
    assert.ok(invocation);
    assert.equal(
      invocation.command,
      "D:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
    );
    assert.equal(invocation.args.join(" ").includes(secret), false);
    assert.doesNotMatch(invocation.args.join(" "), /\$args\[0\]/u);
    assert.equal(invocation.input, secret);

    const deviceId = "11111111-1111-4111-8111-111111111111";
    await writeFile(join(root, `${deviceId}.dpapi`), "encrypted");
    const readRunner = new RecordingRunner("restored-device-credential");
    const readStore = new WindowsDpapiCredentialStore(root, readRunner, "D:\\Windows");
    assert.equal(await readStore.get(reference), "restored-device-credential");
    assert.doesNotMatch(readRunner.invocations[0]?.args.join(" ") ?? "", /\$args\[0\]/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
