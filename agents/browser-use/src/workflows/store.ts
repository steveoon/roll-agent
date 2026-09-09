import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, rename, rm, rmdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import { canonicalJson, validateParameterSchema } from "./parameters.ts";

const idSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/);
const hashSchema = z.string().regex(/^[a-f0-9]{64}$/);
const originSchema = z
  .string()
  .max(2048)
  .refine((value) => {
    try {
      const url = new URL(value);
      return ["https:", "http:"].includes(url.protocol) && url.origin === value;
    } catch {
      return false;
    }
  }, "Expected canonical HTTP(S) origin");
const parameterSchema = z.record(z.unknown()).superRefine((value, ctx) => {
  try {
    validateParameterSchema(value);
  } catch (error) {
    ctx.addIssue({
      code: "custom",
      message: error instanceof Error ? error.message : "Invalid parameter schema",
    });
  }
});
export const workflowDraftSchema = z
  .object({
    id: idSchema,
    name: z.string().min(1).max(120),
    description: z.string().max(2000),
    appliesTo: z
      .object({
        origins: z.array(originSchema).min(1).max(20),
        pathPrefix: z.string().max(2048).startsWith("/").optional(),
      })
      .strict(),
    source: z.string().min(1).max(65_536),
    parameterSchema,
    capabilities: z
      .array(z.enum(["read", "interact", "navigate", "capture"]))
      .min(1)
      .max(4),
    allowedOrigins: z.array(originSchema).min(1).max(20),
    preconditions: z.array(z.record(z.unknown())).max(30).default([]),
    postconditions: z.array(z.record(z.unknown())).min(1).max(30),
    notes: z.string().max(8000).default(""),
    locatorExplanations: z.array(z.string().max(1000)).max(30).default([]),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.appliesTo.origins.some((origin) => !value.allowedOrigins.includes(origin))) {
      ctx.addIssue({ code: "custom", message: "Applicable origins must be allowed" });
    }
  });
export type WorkflowDraftInput = z.input<typeof workflowDraftSchema>;
export type WorkflowDraft = z.output<typeof workflowDraftSchema>;
export const workflowStatusSchema = z.enum(["draft", "active", "disabled", "suspended"]);
const receiptSchema = z
  .object({
    compiled: z.literal(true),
    success: z.literal(true),
    verifiedAssertions: z.number().int().min(1).max(100),
    executionDigest: hashSchema,
  })
  .strict();
export type WorkflowValidationReceipt = z.infer<typeof receiptSchema>;
const validationSchema = receiptSchema.extend({ version: hashSchema, at: z.string().datetime() });
const stateSchema = z
  .object({
    status: workflowStatusSchema,
    validations: z.array(validationSchema).max(10),
    updatedAt: z.string().datetime(),
  })
  .strict();
export type WorkflowState = z.infer<typeof stateSchema>;
const versionSchema = z
  .object({ version: hashSchema, createdAt: z.string().datetime(), draft: workflowDraftSchema })
  .strict();
export type WorkflowVersion = z.infer<typeof versionSchema>;
export type StoredWorkflow = WorkflowVersion & { state: WorkflowState };

function digest(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}
function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
function isExists(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "EEXIST";
}

/** Host-owned store. Never expose recordValidation directly as an MCP operation. */
export class WorkflowStore {
  readonly root: string;
  private readonly managedBase: string;
  constructor(options: { root?: string } = {}) {
    this.managedBase =
      options.root === undefined ? join(homedir(), ".roll-agent") : resolve(options.root);
    this.root = resolve(options.root ?? join(homedir(), ".roll-agent", "browser", "workflows"));
  }

  private async directory(path: string): Promise<void> {
    if (path !== this.managedBase) await this.directory(dirname(path));
    try {
      const stat = await lstat(path);
      if (stat.isSymbolicLink() || !stat.isDirectory()) {
        throw new Error("Workflow directory must not be a symlink or file");
      }
    } catch (error) {
      if (!isMissing(error)) throw error;
      // Parent may be a normal platform alias (e.g. /tmp); managed descendants may not be links.
      if (path === this.managedBase) await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      try {
        await mkdir(path, { mode: 0o700 });
      } catch (mkdirError) {
        if (!isExists(mkdirError)) throw mkdirError;
      }
      const stat = await lstat(path);
      if (stat.isSymbolicLink() || !stat.isDirectory()) {
        throw new Error("Unsafe workflow directory");
      }
    }
  }

  private async read(path: string): Promise<unknown> {
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.size > 160_000) throw new Error("Invalid workflow file");
      return JSON.parse(await file.readFile("utf8")) as unknown;
    } finally {
      await file.close();
    }
  }

  private async write(path: string, value: unknown): Promise<void> {
    const temp = `${path}.${randomUUID()}.tmp`;
    const file = await open(
      temp,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
      0o600,
    );
    try {
      await file.writeFile(canonicalJson(value));
      await file.sync();
    } finally {
      await file.close();
    }
    try {
      await rename(temp, path);
    } finally {
      await rm(temp, { force: true });
    }
  }

  private async locked<T>(id: string, work: (directory: string) => Promise<T>): Promise<T> {
    idSchema.parse(id);
    await this.directory(this.root);
    const directory = join(this.root, id);
    await this.directory(directory);
    const lock = join(directory, ".lock");
    const deadline = Date.now() + 5000;
    for (;;) {
      try {
        await mkdir(lock, { mode: 0o700 });
        break;
      } catch (error) {
        if (!isExists(error)) throw error;
        if (Date.now() >= deadline) {
          throw new Error("Workflow store busy; stale locks require explicit recovery");
        }
        await delay(20);
      }
    }
    try {
      return await work(directory);
    } finally {
      await rmdir(lock);
    }
  }

  private async load(directory: string, id: string, version: string): Promise<StoredWorkflow> {
    hashSchema.parse(version);
    const stored = versionSchema.parse(await this.read(join(directory, `${version}.json`)));
    if (stored.version !== version || stored.draft.id !== id || digest(stored.draft) !== version) {
      throw new Error("Workflow content hash mismatch");
    }
    let state: WorkflowState;
    try {
      state = stateSchema.parse(await this.read(join(directory, `${version}.state.json`)));
    } catch (error) {
      if (!isMissing(error)) throw error;
      state = { status: "draft", validations: [], updatedAt: stored.createdAt };
    }
    if (
      state.validations.some((record) => record.version !== version) ||
      (state.status === "active" && state.validations.length === 0)
    ) {
      throw new Error("Invalid workflow validation state");
    }
    return { ...stored, state };
  }

  async saveDraft(input: WorkflowDraftInput): Promise<StoredWorkflow> {
    const draft = workflowDraftSchema.parse(input);
    if (Buffer.byteLength(canonicalJson(draft)) > 128_000) {
      throw new Error("Workflow draft too large");
    }
    const version = digest(draft);
    return await this.locked(draft.id, async (directory) => {
      try {
        return await this.load(directory, draft.id, version);
      } catch (error) {
        if (!isMissing(error)) throw error;
      }
      const createdAt = new Date().toISOString();
      await this.write(join(directory, `${version}.json`), { version, createdAt, draft });
      return await this.load(directory, draft.id, version);
    });
  }

  async getVersion(id: string, version: string): Promise<StoredWorkflow> {
    return await this.locked(id, async (directory) => await this.load(directory, id, version));
  }

  async recordValidation(
    id: string,
    version: string,
    receipt: WorkflowValidationReceipt,
  ): Promise<WorkflowState> {
    const parsed = receiptSchema.parse(receipt);
    return await this.locked(id, async (directory) => {
      const stored = await this.load(directory, id, version);
      const at = new Date().toISOString();
      const state: WorkflowState = {
        ...stored.state,
        updatedAt: at,
        validations: [...stored.state.validations, { ...parsed, version, at }].slice(-10),
      };
      await this.write(join(directory, `${version}.state.json`), state);
      return state;
    });
  }

  async setStatus(
    id: string,
    version: string,
    status: "active" | "disabled" | "suspended",
  ): Promise<WorkflowState> {
    if (!z.enum(["active", "disabled", "suspended"]).safeParse(status).success) {
      throw new Error("Invalid workflow status");
    }
    return await this.locked(id, async (directory) => {
      const stored = await this.load(directory, id, version);
      if (status === "active" && stored.state.validations.length === 0) {
        throw new Error(
          "Activation requires compilation and verified successful execution for this version",
        );
      }
      const state: WorkflowState = { ...stored.state, status, updatedAt: new Date().toISOString() };
      await this.write(join(directory, `${version}.state.json`), state);
      return state;
    });
  }

  async listApplicableActive(url: string): Promise<
    Array<{
      id: string;
      version: string;
      name: string;
      description: string;
      appliesTo: WorkflowDraft["appliesTo"];
      parameterSchema: WorkflowDraft["parameterSchema"];
    }>
  > {
    const location = new URL(url);
    if (!["http:", "https:"].includes(location.protocol)) return [];
    await this.directory(this.root);
    const results: Array<
      Pick<WorkflowDraft, "id" | "name" | "description" | "appliesTo" | "parameterSchema"> & {
        version: string;
      }
    > = [];
    for (const id of (await readdir(this.root))
      .filter((name) => idSchema.safeParse(name).success)
      .sort()) {
      await this.locked(id, async (directory) => {
        for (const file of (await readdir(directory))
          .filter((name) => /^[a-f0-9]{64}\.json$/.test(name))
          .sort()) {
          const stored = await this.load(directory, id, file.slice(0, -5));
          const { draft, version, state } = stored;
          if (
            state.status !== "active" ||
            !draft.appliesTo.origins.includes(location.origin) ||
            (draft.appliesTo.pathPrefix &&
              !location.pathname.startsWith(draft.appliesTo.pathPrefix))
          ) {
            continue;
          }
          results.push({
            id,
            version,
            name: draft.name,
            description: draft.description,
            appliesTo: draft.appliesTo,
            parameterSchema: draft.parameterSchema,
          });
        }
      });
    }
    return results;
  }
}
