import assert from "node:assert/strict";
import { mkdtemp, mkdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { deviceIdSchema, workspaceIdSchema } from "@roll-agent/relay-protocol";
import {
  CompanionApplication,
  type CompanionApplicationOptions,
  type CompanionControlClient,
} from "./application.ts";
import type { CompanionConfigStore } from "./config-store.ts";
import type { CompanionCredentialStore } from "./credentials.ts";
import type { CompanionSessionFactory } from "./host-session.ts";
import { createBundledRollInvocation } from "./invocation.ts";
import type { CompanionLogger } from "./logger.ts";
import { createCompanionPaths } from "./paths.ts";
import type { CompanionServiceController, CompanionServiceStatus } from "./service.ts";
import {
  companionConfigSchema,
  credentialReferenceSchema,
  type CompanionConfig,
  type CompanionControlResponse,
} from "./schema.ts";

const initialConfig: CompanionConfig = {
  version: 1,
  deviceId: deviceIdSchema.parse("11111111-1111-4111-8111-111111111111"),
  workspaceId: workspaceIdSchema.parse("22222222-2222-4222-8222-222222222222"),
  cwd: "/workspace",
  enabled: true,
  credentialRef: credentialReferenceSchema.parse("keychain:test-device"),
};

test("persisted config rejects a user-supplied Relay endpoint", () => {
  assert.equal(
    companionConfigSchema.safeParse({
      ...initialConfig,
      relayUrl: "wss://attacker.example/companion",
    }).success,
    false,
  );
});

class MemoryConfigStore implements CompanionConfigStore {
  config: CompanionConfig | null;
  readonly events: string[];

  constructor(config: CompanionConfig | null, events: string[] = []) {
    this.config = config;
    this.events = events;
  }

  async load(): Promise<CompanionConfig | null> {
    this.events.push("config.load");
    return this.config;
  }

  async save(config: CompanionConfig): Promise<void> {
    this.events.push("config.save");
    this.config = config;
  }

  async remove(): Promise<void> {
    this.events.push("config.remove");
    this.config = null;
  }
}

class FakeCredentialStore implements CompanionCredentialStore {
  deletes = 0;
  async put(): Promise<never> {
    throw new Error("not used");
  }
  async get(): Promise<string> {
    return "device-credential-at-least-sixteen";
  }
  async delete(): Promise<void> {
    this.deletes += 1;
  }
}

class FakeServiceController implements CompanionServiceController {
  readonly events: string[];
  state: CompanionServiceStatus = { installed: true, running: true };
  stopError: Error | undefined;

  constructor(events: string[]) {
    this.events = events;
  }

  async install(): Promise<void> {
    this.events.push("service.install");
  }
  async uninstall(): Promise<void> {
    this.events.push("service.uninstall");
  }
  async start(): Promise<void> {
    this.events.push("service.start");
  }
  async stop(): Promise<void> {
    this.events.push("service.stop");
    if (this.stopError !== undefined) {
      throw this.stopError;
    }
    this.state = { ...this.state, running: false };
  }
  async status(): Promise<CompanionServiceStatus> {
    this.events.push("service.status");
    return this.state;
  }
}

class RecordingLogger implements CompanionLogger {
  readonly entries: string[] = [];
  info(message: string): void {
    this.entries.push(message);
  }
  error(message: string): void {
    this.entries.push(message);
  }
}

test("disable fails closed when the live service cannot stop", async () => {
  const events: string[] = [];
  const configStore = new MemoryConfigStore(initialConfig, events);
  const service = new FakeServiceController(events);
  service.stopError = new Error("service stop failed");
  const app = createTestApplication({
    configStore,
    service,
    control: missingControlClient,
  });
  await assert.rejects(app.disable(), /service stop failed/);
  assert.equal(configStore.config?.enabled, true);
  assert.equal(events.includes("config.save"), false);
});

test("unenroll does not delete credential or config when service stop fails", async () => {
  const events: string[] = [];
  const configStore = new MemoryConfigStore(initialConfig, events);
  const service = new FakeServiceController(events);
  service.stopError = new Error("service stop failed");
  const credentials = new FakeCredentialStore();
  const app = createTestApplication({
    configStore,
    service,
    control: missingControlClient,
    credentials,
  });
  await assert.rejects(app.unenroll(), /service stop failed/);
  assert.notEqual(configStore.config, null);
  assert.equal(credentials.deletes, 0);
  assert.equal(events.includes("config.remove"), false);
});

test("workspace change stops old service before save and restarts enabled installed service", async () => {
  const root = await mkdtemp(join(tmpdir(), "roll-companion-workspace-"));
  try {
    const workspace = join(root, "next-workspace");
    await mkdir(workspace);
    const events: string[] = [];
    const configStore = new MemoryConfigStore(initialConfig, events);
    const service = new FakeServiceController(events);
    const app = createTestApplication({
      configStore,
      service,
      control: missingControlClient,
    });
    const updated = await app.setWorkspace(workspace);
    assert.equal(updated.cwd, await realpath(workspace));
    assert.ok(events.indexOf("service.stop") < events.indexOf("config.save"));
    assert.ok(events.indexOf("config.save") < events.indexOf("service.start"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("graceful stop waits beyond Runtime shutdown budget before service termination", async () => {
  const events: string[] = [];
  const service = new FakeServiceController(events);
  let observedTimeout = 0;
  const control: CompanionControlClient = async (_endpoint, request, options) => {
    events.push(`control.${request.type}`);
    observedTimeout = options?.timeoutMs ?? 0;
    return successControlResponse();
  };
  const app = createTestApplication({
    configStore: new MemoryConfigStore(initialConfig, events),
    service,
    control,
  });
  await app.stop();
  assert.ok(observedTimeout > 45_000);
  assert.deepEqual(events.slice(0, 2), ["control.stop", "service.stop"]);
});

test("disabled foreground invocation exits cleanly without creating Runtime or control IPC", async () => {
  const logger = new RecordingLogger();
  let sessionCreates = 0;
  const disabledConfig: CompanionConfig = { ...initialConfig, enabled: false };
  const app = createTestApplication({
    configStore: new MemoryConfigStore(disabledConfig),
    service: new FakeServiceController([]),
    control: missingControlClient,
    logger,
    sessionFactory: {
      async create() {
        sessionCreates += 1;
        throw new Error("must not create");
      },
    },
  });
  await app.runForeground();
  assert.equal(sessionCreates, 0);
  assert.deepEqual(logger.entries, ["Companion Host is disabled; exiting cleanly"]);
});

test("unenrolled installed service exits cleanly instead of entering a launchd restart loop", async () => {
  const logger = new RecordingLogger();
  const app = createTestApplication({
    configStore: new MemoryConfigStore(null),
    service: new FakeServiceController([]),
    control: missingControlClient,
    logger,
  });
  await app.runForeground();
  assert.deepEqual(logger.entries, ["Companion Host is not enrolled; exiting cleanly"]);
});

test("foreground Companion refuses an elevated OS identity before starting Runtime", async () => {
  let sessionCreates = 0;
  const app = createTestApplication({
    configStore: new MemoryConfigStore(initialConfig),
    service: new FakeServiceController([]),
    control: missingControlClient,
    sessionFactory: {
      async create() {
        sessionCreates += 1;
        throw new Error("must not create");
      },
    },
    assertUserIdentity: async () => {
      throw new Error("Roll Companion must not run as root");
    },
  });
  await assert.rejects(app.runForeground(), /must not run as root/u);
  assert.equal(sessionCreates, 0);
});

function createTestApplication(input: {
  readonly configStore: CompanionConfigStore;
  readonly service: CompanionServiceController;
  readonly control: CompanionControlClient;
  readonly logger?: CompanionLogger;
  readonly sessionFactory?: CompanionSessionFactory;
  readonly credentials?: CompanionCredentialStore;
  readonly assertUserIdentity?: () => Promise<void>;
}): CompanionApplication {
  const logger = input.logger ?? new RecordingLogger();
  const options: CompanionApplicationOptions = {
    paths: createCompanionPaths("/tmp/roll-companion-test-home", "darwin"),
    platform: "darwin",
    configStore: input.configStore,
    credentialStore: input.credentials ?? new FakeCredentialStore(),
    enrollmentClient: {
      async redeem() {
        throw new Error("not used");
      },
    },
    serviceController: input.service,
    invocation: createBundledRollInvocation({
      command: "/bundle/node",
      cliEntrypoint: "/bundle/roll.js",
      execArgv: [],
    }),
    logger,
    sessionFactory:
      input.sessionFactory ??
      ({
        async create() {
          throw new Error("not used");
        },
      } satisfies CompanionSessionFactory),
    sendControlRequest: input.control,
    assertUserIdentity: input.assertUserIdentity ?? (async () => {}),
  };
  return new CompanionApplication(options);
}

const missingControlClient: CompanionControlClient = async () => {
  const error = Object.assign(new Error("missing control socket"), { code: "ENOENT" });
  throw error;
};

function successControlResponse(): CompanionControlResponse {
  return {
    version: 1,
    ok: true,
    status: {
      phase: "stopped",
      enabled: true,
      enrolled: true,
      runtimeOnline: false,
      relayProfile: "roll-cloud-v1",
    },
  };
}
