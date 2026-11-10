import { basename, dirname, isAbsolute, resolve } from "node:path";
import { existsSync, realpathSync } from "node:fs";
import { z } from "zod";
import type { SessionOwnershipHost } from "@roll-agent/runtime/host-contracts";
import {
  isProcessStartToken,
  readProcessStartToken,
  verifyProcessStartToken,
} from "../registry/process-identity.ts";
import type { RuntimeModule } from "./engine-factory.ts";
import { log } from "../cli/utils/output.ts";

/** Capability attests the public host factory, not an unconfigured embedded Runtime. */
export const ROLL_SESSION_OCCUPANCY_CAPABILITY = {
  version: 1,
  hostInjection: "all-roll-writable-thread-stores",
  protocol: "THREAD_BUSY/session_occupied",
  expectedLibraryEnvironment: "ROLL_EXPECTED_SESSION_LIBRARY",
  primarySchemaVersion: 12,
  legacyWriters: "unverified-sequential-only",
} as const;

export function createSessionOwnershipHost(kind = "cli"): SessionOwnershipHost {
  const token = readProcessStartToken(process.pid);
  if (token === undefined) {
    throw new Error("无法核验当前进程身份，不能安全取得会话占用；请稍后重试。");
  }
  return {
    identity: JSON.stringify({ pid: process.pid, token }),
    owner: { kind, label: kind === "cli" ? "roll chat" : "Roll Runtime", workspace: process.cwd() },
    probe(identity) {
      try {
        const value: unknown = JSON.parse(identity);
        if (
          typeof value !== "object" ||
          value === null ||
          !("pid" in value) ||
          !("token" in value) ||
          typeof value.pid !== "number" ||
          !isProcessStartToken(value.token)
        ) {
          return "unknown";
        }
        const result = verifyProcessStartToken(value.pid, value.token);
        if (result.status === "match") return "alive";
        if (result.status === "mismatch") return "dead";
        return "unknown";
      } catch {
        return "unknown";
      }
    },
  };
}

export function createOwnedThreadStore(runtime: RuntimeModule, dir: string, kind = "cli") {
  assertExpectedSessionLibrary(runtime, dir);
  try {
    const store = new runtime.ThreadStore(resolve(runtime.expandTilde(dir)), {
      ownership: createSessionOwnershipHost(kind),
      migrateOnOpen: true,
    });
    if (store.migrationBackupPath !== null) {
      log.info(`会话库已自动升级；升级前备份：${store.migrationBackupPath}`);
    }
    if (launchBinding?.expected?.state === "missing") {
      launchBinding = { expected: inspectSessionLibraryBinding(runtime, dir) };
    }
    return store;
  } catch (error) {
    if (
      error instanceof runtime.ThreadLibraryMigrationRequiredError &&
      error.preflight.status === "needs_migration"
    ) {
      error.message +=
        " 请在相同工作目录和配置下运行 `roll runtime migrate` 查看迁移步骤，或用 --threads-dir 指定会话库目录。";
    }
    throw error;
  }
}

/** Explicit user-approved backend operation; callers must explain old CLI sequential access. */
export function migrateOwnedThreadLibrary(
  runtime: RuntimeModule,
  dir: string,
  confirmStoppedLegacyClients: true,
) {
  assertExpectedSessionLibrary(runtime, dir);
  return runtime.migrateThreadLibrary({
    dir,
    ownership: createSessionOwnershipHost("migration"),
    confirmStoppedLegacyClients,
  });
}

export const EXPECTED_SESSION_LIBRARY_ENV = "ROLL_EXPECTED_SESSION_LIBRARY";
const bindingCommon = {
  version: z.literal(1),
  databasePath: z.string().max(4096).refine(isAbsolute),
};
const sessionLibraryBindingSchema = z.discriminatedUnion("state", [
  z.object({ ...bindingCommon, state: z.literal("missing") }).strict(),
  z
    .object({
      ...bindingCommon,
      state: z.literal("present"),
      physicalIdentity: z
        .string()
        .max(128)
        .regex(/^inode:\d+:\d+:\d+$/u),
    })
    .strict(),
]);
type SessionLibraryBinding = z.infer<typeof sessionLibraryBindingSchema>;
let launchBinding: { readonly expected: SessionLibraryBinding | undefined } | undefined;

function parseSessionLibraryBinding(value: string): SessionLibraryBinding {
  try {
    if (Buffer.byteLength(value, "utf8") > 8192) throw new SessionLibraryBindingError();
    return sessionLibraryBindingSchema.parse(JSON.parse(value));
  } catch {
    throw new SessionLibraryBindingError();
  }
}

/** Explicit startup action: bind this host, then prevent launch-only state reaching tools. */
export function captureSessionLibraryBinding(): void {
  if (launchBinding !== undefined) return;
  const value = process.env[EXPECTED_SESSION_LIBRARY_ENV];
  launchBinding = { expected: value === undefined ? undefined : parseSessionLibraryBinding(value) };
  delete process.env[EXPECTED_SESSION_LIBRARY_ENV];
}

export class SessionLibraryBindingError extends Error {
  readonly code = "SESSION_LIBRARY_MISMATCH";
  constructor() {
    super(
      "会话库绑定校验失败：预检信息无效或实际配置/物理会话库已变化。请重新检测后再打开；未打开可写会话库。",
    );
    this.name = "SessionLibraryBindingError";
  }
}

function canonicalFuturePath(path: string): string {
  const suffix: string[] = [];
  let ancestor = path;
  while (!existsSync(ancestor)) {
    const parent = dirname(ancestor);
    if (parent === ancestor) throw new SessionLibraryBindingError();
    suffix.unshift(basename(ancestor));
    ancestor = parent;
  }
  return resolve(realpathSync(ancestor), ...suffix);
}

function inspectSessionLibraryBinding(runtime: RuntimeModule, dir: string): SessionLibraryBinding {
  const preflight = runtime.inspectThreadLibrary(dir);
  return sessionLibraryBindingSchema.parse(
    preflight.schemaVersion === null
      ? { version: 1, state: "missing", databasePath: canonicalFuturePath(preflight.databasePath) }
      : {
          version: 1,
          state: "present",
          databasePath: preflight.databasePath,
          physicalIdentity: preflight.physicalIdentity,
        },
  );
}

/** Read-only opaque launch token. Pass unchanged through EXPECTED_SESSION_LIBRARY_ENV. */
export function createSessionLibraryBinding(runtime: RuntimeModule, dir: string): string {
  return JSON.stringify(inspectSessionLibraryBinding(runtime, dir));
}

/** Validate before any mkdir, sidecar, writable SQLite open, or schema initialization. */
function assertExpectedSessionLibrary(runtime: RuntimeModule, dir: string): void {
  const value = process.env[EXPECTED_SESSION_LIBRARY_ENV];
  const expected =
    launchBinding === undefined
      ? value === undefined
        ? undefined
        : parseSessionLibraryBinding(value)
      : launchBinding.expected;
  if (expected === undefined) return;
  try {
    const actual = inspectSessionLibraryBinding(runtime, dir);
    if (
      expected.databasePath !== actual.databasePath ||
      expected.state !== actual.state ||
      (expected.state === "present" &&
        actual.state === "present" &&
        expected.physicalIdentity !== actual.physicalIdentity)
    ) {
      throw new SessionLibraryBindingError();
    }
  } catch {
    throw new SessionLibraryBindingError();
  }
}
