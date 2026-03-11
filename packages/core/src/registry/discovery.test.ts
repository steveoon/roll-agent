import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { discoverAgent } from "./discovery.ts";

function createTmpDir(): string {
  const dir = join(tmpdir(), `roll-discover-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe("discoverAgent", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = createTmpDir();
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("should parse a valid SKILL.md with stdio transport", () => {
    const skillMd = `---
name: test-agent
description: A test agent for unit testing.
metadata:
  roll-transport: stdio
  roll-command: node src/index.ts
---

# Test Agent
`;
    writeFileSync(join(tmpDir, "SKILL.md"), skillMd);

    const result = discoverAgent(tmpDir);
    assert.equal(result.skill.name, "test-agent");
    assert.equal(result.skill.description, "A test agent for unit testing.");
    assert.equal(result.transport.type, "stdio");
    if (result.transport.type === "stdio") {
      assert.equal(result.transport.command, "node");
      assert.deepEqual(result.transport.args, ["src/index.ts"]);
    }
  });

  it("should parse a valid SKILL.md with streamable-http transport", () => {
    const skillMd = `---
name: remote-agent
description: A remote agent.
metadata:
  roll-transport: streamable-http
  roll-endpoint: http://localhost:8100/mcp
---
`;
    writeFileSync(join(tmpDir, "SKILL.md"), skillMd);

    const result = discoverAgent(tmpDir);
    assert.equal(result.transport.type, "streamable-http");
    if (result.transport.type === "streamable-http") {
      assert.equal(result.transport.endpoint, "http://localhost:8100/mcp");
    }
  });

  it("should default to stdio with standard command when no metadata", () => {
    const skillMd = `---
name: simple-agent
description: A simple agent with no metadata.
---
`;
    writeFileSync(join(tmpDir, "SKILL.md"), skillMd);

    const result = discoverAgent(tmpDir);
    assert.equal(result.transport.type, "stdio");
    if (result.transport.type === "stdio") {
      assert.equal(result.transport.command, "node");
      assert.deepEqual(result.transport.args, ["--experimental-strip-types", "src/index.ts"]);
    }
  });

  it("should throw when SKILL.md is missing", () => {
    assert.throws(
      () => discoverAgent(tmpDir),
      (err: Error) => err.message.includes("SKILL.md not found"),
    );
  });

  it("should throw when name is missing", () => {
    writeFileSync(join(tmpDir, "SKILL.md"), `---\ndescription: test\n---\n`);
    assert.throws(
      () => discoverAgent(tmpDir),
      (err: Error) => err.message.includes("missing required field"),
    );
  });

  it("should throw when description is missing", () => {
    writeFileSync(join(tmpDir, "SKILL.md"), `---\nname: test\n---\n`);
    assert.throws(
      () => discoverAgent(tmpDir),
      (err: Error) => err.message.includes("missing required field"),
    );
  });

  it("should throw when http transport has no endpoint", () => {
    const skillMd = `---
name: bad-remote
description: Missing endpoint.
metadata:
  roll-transport: streamable-http
---
`;
    writeFileSync(join(tmpDir, "SKILL.md"), skillMd);
    assert.throws(
      () => discoverAgent(tmpDir),
      (err: Error) => err.message.includes("roll-endpoint"),
    );
  });
});
