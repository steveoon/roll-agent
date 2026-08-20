import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { deviceIdSchema, workspaceIdSchema } from "@roll-agent/relay-protocol";
import { FileCompanionConfigStore } from "./config-store.ts";
import { MacOsKeychainCredentialStore } from "./credentials.ts";
import {
  CompanionEnrollmentService,
  OfficialDeviceEnrollmentClient,
  readPairingCodeFromStdin,
} from "./enrollment.ts";
import { RELAY_HOST_OVERRIDE_ENV, resolveRelayEndpoint } from "./constants.ts";
import { FileCompanionLogger } from "./logger.ts";
import type { ProcessInvocation, ProcessResult, ProcessRunner } from "./process-runner.ts";
import { Readable } from "node:stream";

class RecordingRunner implements ProcessRunner {
  readonly invocations: ProcessInvocation[] = [];

  async run(invocation: ProcessInvocation): Promise<ProcessResult> {
    this.invocations.push(invocation);
    return { code: 0, stdout: "", stderr: "" };
  }
}

test("enrollment never persists or logs pairing code and device credential", async () => {
  const root = await mkdtemp(join(tmpdir(), "roll-companion-enroll-"));
  try {
    const workspace = join(root, "workspace");
    await mkdir(workspace);
    const configPath = join(root, "config.yaml");
    const logPath = join(root, "companion.log");
    const pairingCode = "pairing-code-secret";
    const deviceCredential = "device-credential-secret-value";
    const runner = new RecordingRunner();
    const service = new CompanionEnrollmentService({
      configStore: new FileCompanionConfigStore(configPath),
      credentialStore: new MacOsKeychainCredentialStore(runner),
      enrollmentClient: {
        async redeem(receivedCode) {
          assert.equal(receivedCode, pairingCode);
          return {
            deviceId: deviceIdSchema.parse("11111111-1111-4111-8111-111111111111"),
            workspaceId: workspaceIdSchema.parse("22222222-2222-4222-8222-222222222222"),
            deviceCredential,
          };
        },
      },
    });
    await service.enroll({ pairingCode, workspace });
    const logger = new FileCompanionLogger(logPath);
    logger.info("Companion enrollment completed");
    await new Promise((resolve) => setTimeout(resolve, 25));

    const config = await readFile(configPath, "utf8");
    const log = await readFile(logPath, "utf8");
    const argv = runner.invocations.flatMap((invocation) => invocation.args).join(" ");
    for (const secret of [pairingCode, deviceCredential]) {
      assert.equal(config.includes(secret), false);
      assert.equal(log.includes(secret), false);
      assert.equal(argv.includes(secret), false);
    }
    assert.equal(runner.invocations[0]?.input?.includes(`-w "${deviceCredential}"`), true);
    assert.equal((await stat(configPath)).mode & 0o777, 0o600);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("redeem targets the resolved official Relay endpoint", async () => {
  const previousOverride = process.env[RELAY_HOST_OVERRIDE_ENV];
  delete process.env[RELAY_HOST_OVERRIDE_ENV];
  try {
    const endpoint = resolveRelayEndpoint();
    assert.equal(endpoint.source, "official");
    assert.equal(endpoint.enrollmentUrl.startsWith("https://"), true);
    let requestedUrl = "";
    const client = new OfficialDeviceEnrollmentClient(async (input) => {
      requestedUrl = String(input);
      return new Response(
        JSON.stringify({
          deviceId: "11111111-1111-4111-8111-111111111111",
          workspaceId: "22222222-2222-4222-8222-222222222222",
          deviceCredential: "device-credential-secret-value",
        }),
        { status: 200 },
      );
    });
    await client.redeem("pairing-code-secret");
    assert.equal(requestedUrl, endpoint.enrollmentUrl);
  } finally {
    if (previousOverride !== undefined) {
      process.env[RELAY_HOST_OVERRIDE_ENV] = previousOverride;
    }
  }
});

test("redeem honors a loopback relay override with a plain http endpoint", async () => {
  const previousOverride = process.env[RELAY_HOST_OVERRIDE_ENV];
  process.env[RELAY_HOST_OVERRIDE_ENV] = "127.0.0.1:8787";
  try {
    let requestedUrl = "";
    const client = new OfficialDeviceEnrollmentClient(async (input) => {
      requestedUrl = String(input);
      return new Response(
        JSON.stringify({
          deviceId: "11111111-1111-4111-8111-111111111111",
          workspaceId: "22222222-2222-4222-8222-222222222222",
          deviceCredential: "device-credential-secret-value",
        }),
        { status: 200 },
      );
    });
    await client.redeem("pairing-code-secret");
    assert.equal(requestedUrl, "http://127.0.0.1:8787/v1/device-enrollments/redeem");
  } finally {
    if (previousOverride === undefined) {
      delete process.env[RELAY_HOST_OVERRIDE_ENV];
    } else {
      process.env[RELAY_HOST_OVERRIDE_ENV] = previousOverride;
    }
  }
});

test("pairing code stdin reader accepts a small piped value and rejects oversized input", async () => {
  assert.equal(
    await readPairingCodeFromStdin(Readable.from([" code-from-pipe\n"])),
    "code-from-pipe",
  );
  await assert.rejects(
    readPairingCodeFromStdin(Readable.from(["x".repeat(4 * 1024 + 1)])),
    /too large/,
  );
});
