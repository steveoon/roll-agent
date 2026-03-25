import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { inferAgentSourceFromInstallPath } from "./source.ts";
import {
  AGENT_STATUSES,
  AGENT_STORE_SCHEMA_VERSION,
  createDefaultRuntimeForTransport,
} from "../types/agent.ts";
import type {
  AgentEnvDeclaration,
  AgentStartCommand,
  AgentRuntime,
  AgentSkill,
  AgentSource,
  AgentStatus,
  AgentStoreFile,
  AgentTransport,
  RegisteredAgent,
} from "../types/agent.ts";

/** 持久化存储文件名 */
const STORE_FILE = "agents.json";

type JsonRecord = Record<string, unknown>;
type LegacySourceType = "git" | "local" | "installed" | "remote";

/** Agent Store — 管理已注册 Agent 的持久化存储（JSON 文件） */
export class AgentStore {
  private readonly storePath: string;

  constructor(dataDir: string) {
    this.storePath = resolve(dataDir, STORE_FILE);
  }

  /** 读取所有已注册 Agent */
  list(): ReadonlyArray<RegisteredAgent> {
    return this.load().agents;
  }

  /** 根据名称查找 Agent */
  findByName(name: string): RegisteredAgent | undefined {
    return this.list().find((agent) => agent.skill.name === name);
  }

  /** 添加一个 Agent（名称重复则抛错） */
  add(agent: RegisteredAgent): void {
    const agents = [...this.list()];
    const existing = agents.findIndex((a) => a.skill.name === agent.skill.name);

    if (existing !== -1) {
      throw new Error(`Agent "${agent.skill.name}" is already registered`);
    }

    agents.push(agent);
    this.save(agents);
  }

  /** 根据名称移除 Agent */
  remove(name: string): boolean {
    const agents = this.list();
    const filtered = agents.filter((a) => a.skill.name !== name);

    if (filtered.length === agents.length) {
      return false;
    }

    this.save([...filtered]);
    return true;
  }

  /** 原子替换指定 Agent（名称可变更） */
  replace(name: string, next: RegisteredAgent): boolean {
    const agents = [...this.list()];
    const targetIndex = agents.findIndex((a) => a.skill.name === name);
    if (targetIndex === -1) return false;

    const conflictIndex = agents.findIndex(
      (a, index) => index !== targetIndex && a.skill.name === next.skill.name,
    );
    if (conflictIndex !== -1) {
      throw new Error(`Agent "${next.skill.name}" is already registered`);
    }

    agents[targetIndex] = next;
    this.save(agents);
    return true;
  }

  /** 更新指定 Agent 的状态 */
  updateStatus(name: string, status: RegisteredAgent["status"]): void {
    const agents = this.list().map((a) => (a.skill.name === name ? { ...a, status } : a));
    this.save([...agents]);
  }

  /** 写入存储文件 */
  private save(agents: ReadonlyArray<RegisteredAgent>): void {
    const dir = dirname(this.storePath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    const next: AgentStoreFile = {
      schemaVersion: AGENT_STORE_SCHEMA_VERSION,
      agents,
    };
    writeFileSync(this.storePath, JSON.stringify(next, null, 2), "utf-8");
  }

  private load(): AgentStoreFile {
    if (!existsSync(this.storePath)) {
      return emptyStoreFile();
    }

    let parsed: unknown;
    try {
      const raw = readFileSync(this.storePath, "utf-8");
      parsed = JSON.parse(raw);
    } catch {
      return emptyStoreFile();
    }

    return normalizeStoreFile(parsed);
  }
}

function emptyStoreFile(): AgentStoreFile {
  return {
    schemaVersion: AGENT_STORE_SCHEMA_VERSION,
    agents: [],
  };
}

function normalizeStoreFile(value: unknown): AgentStoreFile {
  if (Array.isArray(value)) {
    return {
      schemaVersion: AGENT_STORE_SCHEMA_VERSION,
      agents: value.flatMap((agent) => {
        const normalized = normalizeStoredAgent(agent);
        return normalized ? [normalized] : [];
      }),
    };
  }

  if (!isJsonRecord(value)) {
    return emptyStoreFile();
  }

  const rawAgents = value["agents"];
  if (!Array.isArray(rawAgents)) {
    return emptyStoreFile();
  }

  return {
    schemaVersion:
      value["schemaVersion"] === AGENT_STORE_SCHEMA_VERSION ? AGENT_STORE_SCHEMA_VERSION : 2,
    agents: rawAgents.flatMap((agent) => {
      const normalized = normalizeStoredAgent(agent);
      return normalized ? [normalized] : [];
    }),
  };
}

function normalizeStoredAgent(value: unknown): RegisteredAgent | undefined {
  if (!isJsonRecord(value)) {
    return undefined;
  }

  const skill = normalizeSkill(value["skill"]);
  const transport = normalizeTransport(value["transport"]);
  const installPath = readString(value["installPath"]);
  if (!skill || !transport || !installPath) {
    return undefined;
  }

  const runtime = normalizeRuntime(value["runtime"], transport);
  const source = normalizeSource(value["source"], installPath, transport);
  const registeredAt = readString(value["registeredAt"]) ?? new Date(0).toISOString();
  const status = normalizeStatus(value["status"]);
  const skillBody = readString(value["skillBody"]);

  return {
    skill,
    transport,
    runtime,
    installPath,
    registeredAt,
    status,
    ...(source ? { source } : {}),
    ...(skillBody ? { skillBody } : {}),
  };
}

function normalizeSkill(value: unknown): AgentSkill | undefined {
  if (!isJsonRecord(value)) {
    return undefined;
  }

  const name = readString(value["name"]);
  const description = readString(value["description"]);
  if (!name || !description) {
    return undefined;
  }

  const license = readString(value["license"]);
  const compatibility = readString(value["compatibility"]);
  const env = normalizeSkillEnv(value["env"]);

  return {
    name,
    description,
    ...(license ? { license } : {}),
    ...(compatibility ? { compatibility } : {}),
    metadata: normalizeMetadata(value["metadata"]),
    ...(env ? { env } : {}),
  };
}

function normalizeMetadata(value: unknown): Readonly<Record<string, string>> {
  if (!isJsonRecord(value)) {
    return {};
  }

  const metadata: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    metadata[key] = String(entry);
  }
  return metadata;
}

function normalizeSkillEnv(value: unknown): AgentSkill["env"] | undefined {
  if (!isJsonRecord(value)) {
    return undefined;
  }

  const required = normalizeEnvDeclarations(value["required"]);
  const optional = normalizeEnvDeclarations(value["optional"]);
  if (!required && !optional) {
    return undefined;
  }

  return {
    ...(required ? { required } : {}),
    ...(optional ? { optional } : {}),
  };
}

function normalizeEnvDeclarations(value: unknown): readonly AgentEnvDeclaration[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const declarations = value.flatMap((entry) => {
    if (!isJsonRecord(entry)) {
      return [];
    }

    const name = readString(entry["name"]);
    if (!name) {
      return [];
    }

    const purpose = readString(entry["purpose"]);
    const example = readString(entry["example"]);
    const defaultValue = readString(entry["default"]);

    return [
      {
        name,
        ...(purpose ? { purpose } : {}),
        ...(example ? { example } : {}),
        ...(defaultValue ? { default: defaultValue } : {}),
      },
    ];
  });

  return declarations.length > 0 ? declarations : undefined;
}

function normalizeTransport(value: unknown): AgentTransport | undefined {
  if (!isJsonRecord(value)) {
    return undefined;
  }

  const type = readString(value["type"]);
  if (type === "stdio") {
    const command = readString(value["command"]);
    if (!command) {
      return undefined;
    }

    const args = normalizeStringArray(value["args"]);
    return args ? { type, command, args } : { type, command };
  }

  if (type === "streamable-http") {
    const endpoint = readString(value["endpoint"]);
    if (!endpoint) {
      return undefined;
    }

    return { type, endpoint };
  }

  return undefined;
}

function normalizeRuntime(value: unknown, transport: AgentTransport): AgentRuntime {
  if (!isJsonRecord(value)) {
    return createDefaultRuntimeForTransport(transport);
  }

  const ownership = readString(value["ownership"]);
  if (ownership === "on-demand") {
    return { ownership };
  }

  if (ownership === "external-managed") {
    return { ownership };
  }

  if (ownership === "core-managed" && transport.type === "streamable-http") {
    const start = normalizeStartCommand(value["start"]);
    const endpoint = normalizeRuntimeEndpoint(value["endpoint"]);
    if (start && endpoint) {
      const setup = normalizeRuntimeSetup(value["setup"]);
      return setup ? { ownership, start, endpoint, setup } : { ownership, start, endpoint };
    }
  }

  return createDefaultRuntimeForTransport(transport);
}

function normalizeStartCommand(value: unknown): AgentStartCommand | undefined {
  if (!isJsonRecord(value)) {
    return undefined;
  }

  const command = readString(value["command"]);
  if (!command) {
    return undefined;
  }

  const args = normalizeStringArray(value["args"]);
  return args ? { command, args } : { command };
}

function normalizeRuntimeEndpoint(value: unknown): Extract<
  AgentRuntime,
  { ownership: "core-managed" }
>["endpoint"] | undefined {
  if (!isJsonRecord(value)) {
    return undefined;
  }

  const path = readString(value["path"]);
  const port = typeof value["port"] === "number" ? value["port"] : undefined;
  if (!path || port === undefined || !Number.isInteger(port)) {
    return undefined;
  }

  return { path, port };
}

function normalizeRuntimeSetup(value: unknown): Extract<
  AgentRuntime,
  { ownership: "core-managed" }
>["setup"] | undefined {
  if (!isJsonRecord(value)) {
    return undefined;
  }

  const playwright = value["playwright"];
  if (!isJsonRecord(playwright)) {
    return undefined;
  }

  const browsers = normalizeStringArray(playwright["browsers"]);
  if (!browsers || browsers.length === 0) {
    return undefined;
  }

  return { playwright: { browsers } };
}

function normalizeSource(
  value: unknown,
  installPath: string,
  transport: AgentTransport,
): AgentSource | undefined {
  if (!isJsonRecord(value)) {
    return inferAgentSourceFromInstallPath(installPath, transport);
  }

  const type = readString(value["type"]);
  if (!type) {
    return inferAgentSourceFromInstallPath(installPath, transport);
  }

  switch (type) {
    case "git":
      return normalizeGitSource(readString(value["url"]));
    case "local-path":
      return { type, path: readString(value["path"]) ?? installPath };
    case "installed-package": {
      const packageName = readString(value["packageName"]);
      const packageSpec = readString(value["packageSpec"]);
      const installDir = readString(value["installDir"]);
      if (!packageName || !packageSpec || !installDir) {
        return undefined;
      }

      return { type, packageName, packageSpec, installDir };
    }
    case "remote-manifest": {
      const endpoint =
        readString(value["endpoint"]) ??
        (transport.type === "streamable-http" ? transport.endpoint : undefined);
      return endpoint ? { type, endpoint } : undefined;
    }
    default:
      return normalizeLegacySource(type as LegacySourceType, value, installPath, transport);
  }
}

function normalizeLegacySource(
  type: LegacySourceType,
  value: JsonRecord,
  installPath: string,
  transport: AgentTransport,
): AgentSource | undefined {
  switch (type) {
    case "git":
      return normalizeGitSource(readString(value["url"]));
    case "local":
      return { type: "local-path", path: readString(value["path"]) ?? installPath };
    case "installed": {
      const packageName = readString(value["packageName"]);
      const packageSpec = readString(value["packageSpec"]);
      const installDir = readString(value["installDir"]);
      if (!packageName || !packageSpec || !installDir) {
        return undefined;
      }

      return { type: "installed-package", packageName, packageSpec, installDir };
    }
    case "remote": {
      const localSource = inferAgentSourceFromInstallPath(installPath, transport);
      if (localSource && localSource.type !== "remote-manifest") {
        return localSource;
      }

      const endpoint =
        readString(value["endpoint"]) ??
        (transport.type === "streamable-http" ? transport.endpoint : undefined);
      return endpoint ? { type: "remote-manifest", endpoint } : undefined;
    }
  }
}

function normalizeStatus(value: unknown): AgentStatus {
  return typeof value === "string" && AGENT_STATUSES.includes(value as AgentStatus)
    ? (value as AgentStatus)
    : "idle";
}

function normalizeStringArray(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const next = value.filter((entry): entry is string => typeof entry === "string");
  return next;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function isJsonRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null;
}

function normalizeGitSource(url: string | undefined): AgentSource {
  return url ? { type: "git", url } : { type: "git" };
}
