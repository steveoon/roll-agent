import { randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { z } from "zod/v4";
import {
  AgentLifecycleBusyError,
  acquireAgentLifecycleLock,
} from "../../registry/process-manager.ts";
import { registrationSchema, type ChatGptRegistration } from "./schemas.ts";

const hostSchema = z.object({
  hostId: z.string().min(1),
  currentAccountId: z.string().uuid().optional(),
});

/** Only this store reads or writes credentials. Public service methods project safe schemas. */
export class ChatGptCredentialStore {
  readonly directory: string;
  constructor(directory: string) {
    this.directory = resolve(directory);
  }

  ensure(): void {
    for (const directory of [
      this.directory,
      resolve(this.directory, "profiles"),
      resolve(this.directory, "pids"),
    ]) {
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      if (!lstatSync(directory).isDirectory()) throw new Error("ChatGPT 凭证目录必须是本地目录。");
      if (process.platform !== "win32") chmodSync(directory, 0o700);
    }
  }

  readHost(): z.infer<typeof hostSchema> | undefined {
    const value = this.readJson(resolve(this.directory, "host.json"));
    return value === undefined ? undefined : hostSchema.parse(value);
  }

  async hostId(): Promise<string> {
    return this.withLock("host", () => {
      const existing = this.readHost();
      if (existing) return existing.hostId;
      const hostId = `urn:uuid:${randomUUID()}`;
      this.writeJson(resolve(this.directory, "host.json"), { hostId });
      return hostId;
    });
  }

  async setCurrent(accountId: string): Promise<void> {
    z.string().uuid().parse(accountId);
    await this.withLock("host", () => {
      const host = this.readHost();
      if (!host) throw new Error("ChatGPT host identity 尚未初始化。");
      this.writeJson(resolve(this.directory, "host.json"), {
        ...host,
        currentAccountId: accountId,
      });
    });
  }

  read(accountId: string): ChatGptRegistration | undefined {
    const value = this.readJson(this.profilePath(accountId));
    return value === undefined ? undefined : registrationSchema.parse(value);
  }

  list(): ChatGptRegistration[] {
    if (!existsSync(resolve(this.directory, "profiles"))) return [];
    return readdirSync(resolve(this.directory, "profiles"))
      .filter(
        (name) =>
          z
            .string()
            .uuid()
            .safeParse(name.replace(/\.json$/, "")).success && name.endsWith(".json"),
      )
      .map((name) => this.read(name.slice(0, -5)))
      .filter((profile): profile is ChatGptRegistration => profile !== undefined);
  }

  save(profile: ChatGptRegistration): void {
    this.writeJson(this.profilePath(profile.id), registrationSchema.parse(profile));
  }

  async activate(
    profile: ChatGptRegistration,
    commit: () => void,
    isCancelled: () => boolean,
  ): Promise<void> {
    await this.withLock("host", () => {
      if (isCancelled()) return;
      const host = this.readHost();
      if (!host) throw new Error("ChatGPT host identity 尚未初始化。");
      // No await between writing the accepted identity and reporting its committed state.
      // A cancellation cannot interrupt this commit and leave a falsely cancelled account active.
      this.save(profile);
      this.writeJson(resolve(this.directory, "host.json"), {
        ...host,
        currentAccountId: profile.id,
      });
      commit();
    });
  }

  async withLock<T>(
    key: string,
    operation: () => T | Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    this.ensure();
    const deadline = Date.now() + 60_000;
    while (true) {
      signal?.throwIfAborted();
      let lock;
      try {
        lock = acquireAgentLifecycleLock(this.directory, `chatgpt:${key}`);
      } catch (error) {
        if (!(error instanceof AgentLifecycleBusyError)) throw error;
        if (Date.now() >= deadline) throw new Error("ChatGPT 账号正在被其他进程操作，请稍后重试。");
        await new Promise<void>((resolve, reject) => {
          const abort = () => {
            clearTimeout(timer);
            reject(signal?.reason);
          };
          const timer = setTimeout(() => {
            signal?.removeEventListener("abort", abort);
            resolve();
          }, 30);
          signal?.addEventListener("abort", abort, { once: true });
        });
        continue;
      }
      try {
        return await operation();
      } finally {
        lock.release();
      }
    }
  }

  private profilePath(accountId: string): string {
    return resolve(this.directory, "profiles", `${z.string().uuid().parse(accountId)}.json`);
  }

  private readJson(path: string): unknown {
    if (!existsSync(path)) return undefined;
    if (!lstatSync(path).isFile()) throw new Error("ChatGPT 凭证必须存储为普通文件。");
    if (process.platform !== "win32") chmodSync(path, 0o600);
    return JSON.parse(readFileSync(path, "utf8"));
  }

  private writeJson(path: string, value: unknown): void {
    this.ensure();
    const temporary = `${path}.${randomUUID()}.tmp`;
    let descriptor: number | undefined;
    try {
      descriptor = openSync(temporary, "wx", 0o600);
      writeFileSync(descriptor, `${JSON.stringify(value)}\n`, "utf8");
      fsyncSync(descriptor);
      closeSync(descriptor);
      descriptor = undefined;
      renameSync(temporary, path);
      if (process.platform !== "win32") {
        descriptor = openSync(dirname(path), "r");
        fsyncSync(descriptor);
        closeSync(descriptor);
        descriptor = undefined;
      }
    } finally {
      if (descriptor !== undefined) closeSync(descriptor);
      if (existsSync(temporary)) unlinkSync(temporary);
    }
  }
}
