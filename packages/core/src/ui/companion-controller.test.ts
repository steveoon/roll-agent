import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { companionConfigSchema, type CompanionHostStatus } from "../companion-host/schema.ts";
import {
  createRollUiCompanionController,
  RollUiCompanionBusyError,
  RollUiCompanionRequestError,
  type CompanionApplicationPort,
} from "./companion-controller.ts";

const PAIRING_CODE = "PAIR-8F2A-SECRET";
const WORKSPACE = "/Users/tester/projects/roll";

const CONFIG = companionConfigSchema.parse({
  version: 1,
  deviceId: "6e6d9a6f-6c1b-4a3e-9b5c-2f4d8a1e7c30",
  workspaceId: "0f0f9a6f-6c1b-4a3e-9b5c-2f4d8a1e7c31",
  cwd: WORKSPACE,
  enabled: true,
  credentialRef: "keychain:6e6d9a6f-6c1b-4a3e-9b5c-2f4d8a1e7c30",
});

const STATUS: CompanionHostStatus = {
  phase: "stopped",
  enabled: false,
  enrolled: false,
  runtimeOnline: false,
  relayProfile: "roll-cloud-v1",
};

describe("createRollUiCompanionController mutation exclusion", () => {
  it("rejects a second mutation while one is in flight and recovers afterwards", async () => {
    const application = createFakeApplication();
    const controller = createRollUiCompanionController({ application });

    const pendingStop = controller.stop();
    await assert.rejects(
      async () => controller.start(),
      (error: unknown) =>
        error instanceof RollUiCompanionBusyError && error.code === "companion_busy",
    );
    application.release();
    assert.deepEqual(await pendingStop, { ok: true });

    assert.deepEqual(await controller.start(), { ok: true });
    assert.deepEqual(application.calls, ["stop", "start"]);
  });

  it("keeps status, doctor and log reads available while a mutation is in flight", async () => {
    const application = createFakeApplication();
    const controller = createRollUiCompanionController({ application });

    const pendingRestart = controller.restart();
    assert.deepEqual(await controller.getStatus(), STATUS);
    assert.deepEqual(await controller.getDoctor(), { ok: true, checks: [] });
    assert.deepEqual(await controller.readLogs(), { text: "log line\n" });
    application.release();
    await pendingRestart;
  });
});

describe("createRollUiCompanionController request validation", () => {
  it("rejects enroll bodies without a pairing code or workspace and never echoes the body", async () => {
    const application = createFakeApplication();
    const controller = createRollUiCompanionController({ application });

    for (const body of [
      undefined,
      null,
      "not-an-object",
      {},
      { pairingCode: PAIRING_CODE },
      { pairingCode: "", workspace: WORKSPACE },
      { pairingCode: PAIRING_CODE, workspace: "" },
      { pairingCode: PAIRING_CODE, workspace: WORKSPACE, extra: true },
      { pairingCode: 42, workspace: WORKSPACE },
    ]) {
      await assert.rejects(
        async () => controller.enroll(body),
        (error: unknown) =>
          error instanceof RollUiCompanionRequestError &&
          error.code === "invalid_request" &&
          !error.message.includes(PAIRING_CODE) &&
          !JSON.stringify(error).includes(PAIRING_CODE),
      );
    }
    assert.deepEqual(application.calls, []);
  });

  it("rejects workspace bodies that are not a non-empty string", async () => {
    const application = createFakeApplication();
    const controller = createRollUiCompanionController({ application });

    for (const body of [undefined, {}, { workspace: "" }, { workspace: 7 }]) {
      await assert.rejects(
        async () => controller.setWorkspace(body),
        (error: unknown) => error instanceof RollUiCompanionRequestError,
      );
    }
    assert.deepEqual(application.calls, []);
  });

  it("does not consume the mutation slot when a request body is invalid", async () => {
    const application = createFakeApplication();
    const controller = createRollUiCompanionController({ application });

    const pendingStop = controller.stop();
    await assert.rejects(
      async () => controller.enroll({}),
      (error: unknown) => error instanceof RollUiCompanionRequestError,
    );
    application.release();
    await pendingStop;
    assert.deepEqual(await controller.enroll({ pairingCode: PAIRING_CODE, workspace: WORKSPACE }), {
      ok: true,
    });
  });
});

describe("createRollUiCompanionController forwarding", () => {
  it("forwards every management operation to the companion application", async () => {
    const application = createFakeApplication({ autoRelease: true });
    const controller = createRollUiCompanionController({ application });

    await controller.enroll({ pairingCode: PAIRING_CODE, workspace: WORKSPACE });
    await controller.setWorkspace({ workspace: WORKSPACE });
    await controller.enable();
    await controller.disable();
    await controller.installService();
    await controller.uninstallService();
    await controller.start();
    await controller.stop();
    await controller.restart();
    await controller.unenroll();

    assert.deepEqual(application.calls, [
      "enroll",
      "setWorkspace",
      "enable",
      "disable",
      "installService",
      "uninstallService",
      "start",
      "stop",
      "restart",
      "unenroll",
    ]);
    assert.deepEqual(application.enrollments, [
      { pairingCode: PAIRING_CODE, workspace: WORKSPACE },
    ]);
    assert.deepEqual(application.workspaces, [WORKSPACE]);
  });

  it("surfaces application failures unchanged and releases the mutation slot", async () => {
    const application = createFakeApplication({ autoRelease: true });
    application.failure = new Error("Roll Companion is not enrolled");
    const controller = createRollUiCompanionController({ application });

    await assert.rejects(
      async () => controller.start(),
      (error: unknown) =>
        error instanceof Error && error.message === "Roll Companion is not enrolled",
    );

    application.failure = undefined;
    assert.deepEqual(await controller.start(), { ok: true });
  });

  it("wraps the raw log text and forwards follow subscriptions with the abort signal", async () => {
    const application = createFakeApplication({ autoRelease: true });
    const controller = createRollUiCompanionController({ application });
    const received: string[] = [];
    const aborter = new AbortController();

    assert.deepEqual(await controller.readLogs(), { text: "log line\n" });
    const following = controller.followLogs((text) => received.push(text), aborter.signal);
    application.emitLog("streamed line\n");
    aborter.abort();
    await following;

    assert.deepEqual(received, ["streamed line\n"]);
  });
});

interface FakeCompanionApplication extends CompanionApplicationPort {
  readonly calls: string[];
  readonly enrollments: Array<{ readonly pairingCode: string; readonly workspace: string }>;
  readonly workspaces: string[];
  failure: Error | undefined;
  release: () => void;
  emitLog: (text: string) => void;
}

function createFakeApplication(
  options: { readonly autoRelease?: boolean } = {},
): FakeCompanionApplication {
  const calls: string[] = [];
  const enrollments: Array<{ readonly pairingCode: string; readonly workspace: string }> = [];
  const workspaces: string[] = [];
  const gate = Promise.withResolvers<void>();
  let released = options.autoRelease === true;
  let logListener: ((text: string) => void) | undefined;

  const record = async (name: string): Promise<void> => {
    calls.push(name);
    if (!released) await gate.promise;
    if (fake.failure !== undefined) throw fake.failure;
  };

  const fake: FakeCompanionApplication = {
    calls,
    enrollments,
    workspaces,
    failure: undefined,
    release: () => {
      released = true;
      gate.resolve();
    },
    emitLog: (text) => logListener?.(text),
    getStatus: async () => STATUS,
    doctor: async () => ({ ok: true, checks: [] }),
    readLogs: async () => "log line\n",
    followLogs: async (onText, signal) => {
      logListener = onText;
      if (signal.aborted) return;
      await new Promise<void>((resolve) => {
        signal.addEventListener("abort", () => resolve(), { once: true });
      });
    },
    enroll: async (input) => {
      enrollments.push({ pairingCode: input.pairingCode, workspace: input.workspace });
      await record("enroll");
      return CONFIG;
    },
    unenroll: async () => {
      await record("unenroll");
      return true;
    },
    enable: async () => {
      await record("enable");
      return CONFIG;
    },
    disable: async () => {
      await record("disable");
      return CONFIG;
    },
    setWorkspace: async (workspace) => {
      workspaces.push(workspace);
      await record("setWorkspace");
      return CONFIG;
    },
    installService: () => record("installService"),
    uninstallService: () => record("uninstallService"),
    start: () => record("start"),
    stop: () => record("stop"),
    restart: () => record("restart"),
  };
  return fake;
}
