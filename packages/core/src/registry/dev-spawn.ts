import { existsSync } from "node:fs";
import { basename, resolve } from "node:path";
import { inferAgentSourceType } from "./source.ts";
import type { AgentSourceType, AgentTransport, RegisteredAgent } from "../types/agent.ts";

export interface AgentSpawnSpec {
  readonly command: string;
  readonly args?: readonly string[];
}

export function resolveDevSpawnSpec(
  command: string,
  args: readonly string[] | undefined,
  installPath: string,
  sourceType: AgentSourceType,
): AgentSpawnSpec | undefined {
  if (
    !isNodeCommand(command) ||
    !args ||
    args.length !== 1 ||
    sourceType === "installed-package" ||
    sourceType === "remote-manifest"
  ) {
    return undefined;
  }

  const [entryArg] = args;
  if (!entryArg?.startsWith("dist/") || !entryArg.endsWith(".js")) {
    return undefined;
  }

  const sourceEntry = entryArg.replace(/^dist\//, "src/").replace(/\.js$/, ".ts");
  if (!existsSync(resolve(installPath, sourceEntry))) {
    return undefined;
  }

  return {
    command,
    args: ["--experimental-strip-types", sourceEntry],
  };
}

export function resolveTransportWithDevSpawnSpec(agent: RegisteredAgent): AgentTransport {
  if (agent.transport.type !== "stdio") {
    return agent.transport;
  }

  const fallbackSpec = resolveDevSpawnSpec(
    agent.transport.command,
    agent.transport.args,
    agent.installPath,
    inferAgentSourceType(agent),
  );

  if (!fallbackSpec) {
    return agent.transport;
  }

  const { maxBufferSize } = agent.transport;
  return {
    type: "stdio",
    command: fallbackSpec.command,
    ...(fallbackSpec.args ? { args: fallbackSpec.args } : {}),
    ...(maxBufferSize !== undefined ? { maxBufferSize } : {}),
  };
}

function isNodeCommand(command: string): boolean {
  const normalized = basename(command).toLowerCase();
  return command === "node" || normalized === "node" || normalized === "node.exe";
}
