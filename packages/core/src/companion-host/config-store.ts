import { chmod, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { companionConfigSchema, type CompanionConfig } from "./schema.ts";

export interface CompanionConfigStore {
  load(): Promise<CompanionConfig | null>;
  save(config: CompanionConfig): Promise<void>;
  remove(): Promise<void>;
}

export class FileCompanionConfigStore implements CompanionConfigStore {
  readonly configPath: string;

  constructor(configPath: string) {
    this.configPath = configPath;
  }

  async load(): Promise<CompanionConfig | null> {
    let source: string;
    try {
      source = await readFile(this.configPath, "utf8");
    } catch (error: unknown) {
      if (isFileSystemError(error, "ENOENT")) {
        return null;
      }
      throw error;
    }
    let parsed: unknown;
    try {
      parsed = parseYaml(source);
    } catch {
      throw new Error("Companion config is not valid YAML");
    }
    const result = companionConfigSchema.safeParse(parsed);
    if (!result.success) {
      throw new Error("Companion config does not match the supported schema");
    }
    return result.data;
  }

  async save(config: CompanionConfig): Promise<void> {
    const parsed = companionConfigSchema.parse(config);
    const directory = dirname(this.configPath);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(directory, 0o700);
    const temporaryPath = `${this.configPath}.${randomUUID()}.tmp`;
    const serialized = stringifyYaml(
      {
        version: parsed.version,
        deviceId: parsed.deviceId,
        workspaceId: parsed.workspaceId,
        cwd: parsed.cwd,
        enabled: parsed.enabled,
        credentialRef: parsed.credentialRef,
      },
      { lineWidth: 0 },
    );
    try {
      await writeFile(temporaryPath, serialized, { encoding: "utf8", mode: 0o600, flag: "wx" });
      await chmod(temporaryPath, 0o600);
      await rename(temporaryPath, this.configPath);
      await chmod(this.configPath, 0o600);
    } catch (error: unknown) {
      await unlink(temporaryPath).catch(() => undefined);
      throw error;
    }
  }

  async remove(): Promise<void> {
    try {
      await unlink(this.configPath);
    } catch (error: unknown) {
      if (!isFileSystemError(error, "ENOENT")) {
        throw error;
      }
    }
  }
}

function isFileSystemError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
}
