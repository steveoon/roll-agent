import assert from "node:assert/strict";
import test from "node:test";
import { RUNTIME_PROTOCOL_VERSION } from "@roll-agent/protocol";
import { assertBundledRuntimeProtocolVersion } from "./host-session.ts";

test("bundled runtime must negotiate the current runtime protocol version", () => {
  assertBundledRuntimeProtocolVersion(RUNTIME_PROTOCOL_VERSION);
  assert.throws(
    () => assertBundledRuntimeProtocolVersion("0.9"),
    /must negotiate Runtime Protocol/u,
  );
  assert.throws(
    () => assertBundledRuntimeProtocolVersion("1.3"),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.ok(error.message.includes(RUNTIME_PROTOCOL_VERSION));
      assert.ok(error.message.includes("1.3"));
      return true;
    },
  );
});

test("real Runtime startup recovers after a missing service variable is supplied", async () => {
  const { mkdtemp, mkdir, writeFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join, resolve } = await import("node:path");
  const { DefaultCompanionSessionFactory } = await import("./host-session.ts");
  const { createBundledRollInvocation } = await import("./invocation.ts");
  const { companionConfigSchema } = await import("./schema.ts");
  const root = await mkdtemp(join(tmpdir(), "roll-runtime-env-recovery-"));
  const before = {
    HOME: process.env["HOME"],
    USERPROFILE: process.env["USERPROFILE"],
    KEY: process.env["ROLL_COMPANION_RECOVERY_KEY"],
  };
  const config = companionConfigSchema.parse({
    version: 1,
    deviceId: "11111111-1111-4111-8111-111111111111",
    workspaceId: "22222222-2222-4222-8222-222222222222",
    cwd: root,
    enabled: true,
    credentialRef: "keychain:fixture",
  });
  let relayAttempts = 0;
  const factory = new DefaultCompanionSessionFactory({
    invocation: createBundledRollInvocation({
      command: process.execPath,
      cliEntrypoint: resolve(import.meta.dirname, "../cli/index.ts"),
      execArgv: ["--experimental-strip-types", "--experimental-sqlite"],
    }),
    configPath: join(root, "companion.yaml"),
    createWebSocket: () => {
      relayAttempts++;
      throw new Error("No network in fixture");
    },
  });
  try {
    process.env["HOME"] = root;
    process.env["USERPROFILE"] = root;
    delete process.env["ROLL_COMPANION_RECOVERY_KEY"];
    await writeFile(
      join(root, "roll.config.yaml"),
      `llm:\n  default-provider: openai\n  default-model: test-model\n  providers:\n    openai:\n      api-key: \${ROLL_COMPANION_RECOVERY_KEY}\n      base-url: https://example.invalid/v1\nchat:\n  instructions: off\n`,
    );
    await assert.rejects(
      factory.create(config, "test-device-credential"),
      /ROLL_COMPANION_RECOVERY_KEY/,
    );
    assert.equal(relayAttempts, 0);
    await mkdir(join(root, ".roll-agent"));
    await writeFile(
      join(root, ".roll-agent", "secrets.env"),
      "ROLL_COMPANION_RECOVERY_KEY=synthetic-not-a-real-key\n",
      { mode: 0o600 },
    );
    const session = await factory.create(config, "test-device-credential");
    try {
      assert.ok(relayAttempts > 0);
    } finally {
      await session.stop();
    }
  } finally {
    for (const [key, value] of Object.entries({
      HOME: before.HOME,
      USERPROFILE: before.USERPROFILE,
      ROLL_COMPANION_RECOVERY_KEY: before.KEY,
    })) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(root, { recursive: true, force: true });
  }
});

test("unknown child failure preserves exit code without exposing raw stderr or inventing an env cause", async () => {
  const { mkdtemp, writeFile, rm } = await import("node:fs/promises");
  const { join } = await import("node:path");
  const { DefaultCompanionSessionFactory } = await import("./host-session.ts");
  const { companionConfigSchema } = await import("./schema.ts");
  const { tmpdir } = await import("node:os");
  const root = await mkdtemp(join(tmpdir(), "roll-runtime-stderr-"));
  const previousHome = process.env["HOME"];
  const previousProfile = process.env["USERPROFILE"];
  try {
    process.env["HOME"] = root;
    process.env["USERPROFILE"] = root;
    await writeFile(
      join(root, "roll.config.yaml"),
      "llm:\n  providers:\n    openai:\n      api-key: synthetic\n  default-provider: openai\n",
    );
    const childPath = join(root, "fail.cjs");
    await writeFile(
      childPath,
      "process.stderr.write('credential-value-must-never-appear\\n'); process.exitCode = 7;",
    );
    const factory = new DefaultCompanionSessionFactory({
      invocation: {
        command: process.execPath,
        cliEntrypoint: childPath,
        runtimeArgs: [childPath],
        companionArgs: [],
        execArgv: [],
      },
    });
    const config = companionConfigSchema.parse({
      version: 1,
      deviceId: "11111111-1111-4111-8111-111111111111",
      workspaceId: "22222222-2222-4222-8222-222222222222",
      cwd: root,
      enabled: true,
      credentialRef: "keychain:fixture",
    });
    await assert.rejects(
      factory.create(config, "synthetic-device-credential"),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /退出码 7/);
        assert.doesNotMatch(error.message, /credential-value-must-never-appear|环境变量缺失/);
        return true;
      },
    );
    const missingCommand = join(root, "private-missing-command");
    const missingFactory = new DefaultCompanionSessionFactory({
      invocation: {
        command: missingCommand,
        cliEntrypoint: childPath,
        runtimeArgs: [childPath],
        companionArgs: [],
        execArgv: [],
      },
    });
    await assert.rejects(
      missingFactory.create(config, "synthetic-device-credential"),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /ENOENT/);
        assert.doesNotMatch(error.message, /private-missing-command/);
        return true;
      },
    );
  } finally {
    if (previousHome === undefined) delete process.env["HOME"];
    else process.env["HOME"] = previousHome;
    if (previousProfile === undefined) delete process.env["USERPROFILE"];
    else process.env["USERPROFILE"] = previousProfile;
    await rm(root, { recursive: true, force: true });
  }
});

test("startup classification retains only trusted error categories, never arbitrary name/code/message", async () => {
  const { describeRuntimeStartupFailure } = await import("./host-session.ts");
  const { RollProtocolViolationError, RollRequestTimeoutError, RollRpcError } =
    await import("@roll-agent/client-node");
  assert.match(
    describeRuntimeStartupFailure(Object.assign(new Error("secret path"), { code: "ENOENT" })),
    /ENOENT/,
  );
  assert.match(
    describeRuntimeStartupFailure(Object.assign(new Error("secret"), { code: "EACCES" })),
    /EACCES/,
  );
  assert.match(
    describeRuntimeStartupFailure(new RollProtocolViolationError("secret payload")),
    /RollProtocolViolationError/,
  );
  assert.match(
    describeRuntimeStartupFailure(new RollRequestTimeoutError("initialize", 100)),
    /RollRequestTimeoutError/,
  );
  assert.match(
    describeRuntimeStartupFailure(
      new RollRpcError({ code: -32602, message: "secret rpc payload" }),
    ),
    /-32602/,
  );
  const unknown = Object.assign(new Error("secret message"), {
    name: "secret name",
    code: "secret code",
  });
  assert.equal(describeRuntimeStartupFailure(unknown), "");
});
