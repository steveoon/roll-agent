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
import {
  OFFICIAL_RELAY_ENDPOINT_UNDECIDED_MESSAGE,
  isOfficialRelayEndpointDecided,
  requireCompanionRelayEndpoint,
  requireOfficialRelayCompanionUrl,
  requireOfficialRelayEnrollmentUrl,
} from "./constants.ts";
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

test("redeeming a pairing code fails closed while the official Relay host is undecided", async () => {
  let fetched = false;
  const client = new OfficialDeviceEnrollmentClient(async () => {
    fetched = true;
    return new Response("{}", { status: 200 });
  });
  if (isOfficialRelayEndpointDecided()) {
    // A decided endpoint keeps TLS unless it is the loopback development override.
    const endpoint = requireCompanionRelayEndpoint();
    assert.equal(
      requireOfficialRelayEnrollmentUrl().startsWith(endpoint.loopback ? "http://" : "https://"),
      true,
    );
    return;
  }
  await assert.rejects(
    () => client.redeem("pairing-code-secret"),
    new RegExp(OFFICIAL_RELAY_ENDPOINT_UNDECIDED_MESSAGE),
  );
  assert.equal(fetched, false);
  assert.throws(() => requireOfficialRelayCompanionUrl(), /not decided yet/u);
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
