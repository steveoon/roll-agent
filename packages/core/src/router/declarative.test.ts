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

describe("resolveAgent", () => {
  const agents = [makeAgent("alpha"), makeAgent("beta"), makeAgent("gamma")];

  it("should find an agent by exact name", () => {
    const result = resolveAgent("beta", agents);
    assert.ok(result);
    assert.equal(result.skill.name, "beta");
  });

  it("should return undefined for unknown name", () => {
    const result = resolveAgent("nonexistent", agents);
    assert.equal(result, undefined);
  });

  it("should return undefined for empty agent list", () => {
    const result = resolveAgent("alpha", []);
    assert.equal(result, undefined);
  });

  it("should match first agent when multiple exist", () => {
    const result = resolveAgent("alpha", agents);
    assert.ok(result);
    assert.equal(result.skill.name, "alpha");
  });
});
