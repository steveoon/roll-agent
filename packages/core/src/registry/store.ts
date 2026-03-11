import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import type { RegisteredAgent } from "../types/agent.ts";

/** 持久化存储文件名 */
const STORE_FILE = "agents.json";

/** Agent Store — 管理已注册 Agent 的持久化存储（JSON 文件） */
export class AgentStore {
  private readonly storePath: string;

  constructor(dataDir: string) {
    this.storePath = resolve(dataDir, STORE_FILE);
  }

  /** 读取所有已注册 Agent */
  list(): ReadonlyArray<RegisteredAgent> {
    if (!existsSync(this.storePath)) {
      return [];
    }
    const raw = readFileSync(this.storePath, "utf-8");
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed as ReadonlyArray<RegisteredAgent>;
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

  /** 更新指定 Agent 的状态 */
  updateStatus(name: string, status: RegisteredAgent["status"]): void {
    const agents = this.list().map((a) =>
      a.skill.name === name ? { ...a, status } : a,
    );
    this.save([...agents]);
  }

  /** 写入存储文件 */
  private save(agents: ReadonlyArray<RegisteredAgent>): void {
    const dir = dirname(this.storePath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    writeFileSync(this.storePath, JSON.stringify(agents, null, 2), "utf-8");
  }
}
