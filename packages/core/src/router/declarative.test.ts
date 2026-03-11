import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { resolveAgent } from "./declarative.ts";
import type { RegisteredAgent } from "../types/agent.ts";

function makeAgent(name: string): RegisteredAgent {
  return {
    skill: { name, description: `${name} desc`, metadata: {} },
    transport: { type: "stdio", command: "node" },
    installPath: `/tmp/${name}`,
    registeredAt: new Date().toISOString(),
    status: "idle",
  };
}

describe("resolveAgent (declarative)", () => {
  const agents = [makeAgent("agent-a"), makeAgent("agent-b")];

  it("should find an agent by name", () => {
    const result = resolveAgent("agent-b", agents);
    assert.equal(result?.skill.name, "agent-b");
  });

  it("should return undefined for unknown name", () => {
    const result = resolveAgent("nonexistent", agents);
    assert.equal(result, undefined);
  });

  it("should return undefined for empty list", () => {
    const result = resolveAgent("agent-a", []);
    assert.equal(result, undefined);
  });
});
