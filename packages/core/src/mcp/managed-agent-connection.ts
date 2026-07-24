import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  acquireAgentUsageLease,
  type AgentUsageHolderKind,
  type AgentUsageLease,
} from "../registry/agent-usage-lease.ts";
import { resolveTransportWithDevSpawnSpec } from "../registry/dev-spawn.ts";
import type { RegisteredAgent } from "../types/agent.ts";
import { McpClientManager, type ConnectOptions } from "./client-manager.ts";

/**
 * Binds short-lived MCP connections to cross-process Agent usage leases.
 *
 * Runtime readiness probes deliberately keep using McpClientManager directly so lifecycle code
 * can probe while it already owns the Agent lock.
 */
export class ManagedAgentConnectionScope {
  private readonly leases = new Map<string, AgentUsageLease>();
  private readonly pendingConnections = new Map<string, Promise<Client>>();
  private readonly dataDir: string;
  private readonly holderKind: AgentUsageHolderKind;
  private readonly clientManager: McpClientManager;
  private readonly acquireUsageLease: typeof acquireAgentUsageLease;
  private closing = false;

  constructor(
    dataDir: string,
    holderKind: AgentUsageHolderKind,
    clientManager: McpClientManager = new McpClientManager(),
    acquireUsageLease: typeof acquireAgentUsageLease = acquireAgentUsageLease,
  ) {
    this.dataDir = dataDir;
    this.holderKind = holderKind;
    this.clientManager = clientManager;
    this.acquireUsageLease = acquireUsageLease;
  }

  async connect(agent: RegisteredAgent, options: ConnectOptions = {}): Promise<Client> {
    if (this.closing) {
      throw new Error("Managed Agent connection scope is closing.");
    }
    const pending = this.pendingConnections.get(agent.skill.name);
    if (pending !== undefined) return pending;

    const connection = this.connectOnce(agent, options);
    this.pendingConnections.set(agent.skill.name, connection);
    try {
      return await connection;
    } finally {
      if (this.pendingConnections.get(agent.skill.name) === connection) {
        this.pendingConnections.delete(agent.skill.name);
      }
    }
  }

  private async connectOnce(agent: RegisteredAgent, options: ConnectOptions): Promise<Client> {
    const existingLease = this.leases.get(agent.skill.name);
    const acquiredLease =
      existingLease === undefined
        ? await this.acquireUsageLease(agent, this.dataDir, options.env, {
            holderKind: this.holderKind,
            startIfStopped: false,
            waitUntilReady: false,
          })
        : undefined;

    try {
      const client = await this.clientManager.connect(
        agent.skill.name,
        resolveTransportWithDevSpawnSpec(agent),
        agent.installPath,
        options,
      );
      if (acquiredLease !== undefined) {
        this.leases.set(agent.skill.name, acquiredLease);
      }
      return client;
    } catch (error) {
      await acquiredLease?.release().catch(() => {});
      throw error;
    }
  }

  async disconnectAll(): Promise<void> {
    this.closing = true;
    await Promise.allSettled([...this.pendingConnections.values()]);

    let disconnectFailure:
      | { readonly failed: false }
      | { readonly failed: true; readonly error: unknown } = { failed: false };
    try {
      await this.clientManager.disconnectAll();
    } catch (error) {
      disconnectFailure = { failed: true, error };
    }
    const leases = [...this.leases.values()];
    this.leases.clear();
    const results = await Promise.allSettled(leases.map((lease) => lease.release()));
    const failure = results.find(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    if (failure !== undefined) throw failure.reason;
    if (disconnectFailure.failed) throw disconnectFailure.error;
  }
}
