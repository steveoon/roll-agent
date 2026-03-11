import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { discoverAgent } from "./discovery.ts";

function makeTmpDir(): string {
  const dir = resolve(tmpdir(), `roll-test-${randomUUID()}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe("discoverAgent", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("should parse a valid SKILL.md with stdio transport", () => {
    const skillMd = `---
name: test-agent
description: A test agent
metadata:
  roll-transport: stdio
  roll-command: node src/index.ts
---

This agent does testing.
`;
    writeFileSync(resolve(tmpDir, "SKILL.md"), skillMd);

    const result = discoverAgent(tmpDir);
    assert.equal(result.skill.name, "test-agent");
    assert.equal(result.skill.description, "A test agent");
    assert.equal(result.transport.type, "stdio");
    if (result.transport.type === "stdio") {
      assert.equal(result.transport.command, "node");
      assert.deepEqual(result.transport.args, ["src/index.ts"]);
    }
    assert.equal(result.skillBody, "This agent does testing.");
  });

  it("should parse streamable-http transport", () => {
    const skillMd = `---
name: remote-agent
description: A remote agent
metadata:
  roll-transport: streamable-http
  roll-endpoint: http://localhost:8100/mcp
---
`;
    writeFileSync(resolve(tmpDir, "SKILL.md"), skillMd);

    const result = discoverAgent(tmpDir);
    assert.equal(result.transport.type, "streamable-http");
    if (result.transport.type === "streamable-http") {
      assert.equal(result.transport.endpoint, "http://localhost:8100/mcp");
    }
  });

  it("should default to stdio when no transport specified", () => {
    const skillMd = `---
name: default-agent
description: Agent with default transport
metadata: {}
---
`;
    writeFileSync(resolve(tmpDir, "SKILL.md"), skillMd);

    const result = discoverAgent(tmpDir);
    assert.equal(result.transport.type, "stdio");
  });

  it("should throw when SKILL.md is missing", () => {
    assert.throws(
      () => discoverAgent(tmpDir),
      (err: Error) => err.message.includes("SKILL.md not found"),
    );
  });

  it("should throw when name is missing", () => {
    const skillMd = `---
description: No name agent
metadata: {}
---
`;
    writeFileSync(resolve(tmpDir, "SKILL.md"), skillMd);

    assert.throws(
      () => discoverAgent(tmpDir),
      (err: Error) => err.message.includes("name"),
    );
  });

  it("should throw when description is missing", () => {
    const skillMd = `---
name: no-desc
metadata: {}
---
`;
    writeFileSync(resolve(tmpDir, "SKILL.md"), skillMd);

    assert.throws(
      () => discoverAgent(tmpDir),
      (err: Error) => err.message.includes("description"),
    );
  });

  it("should throw when streamable-http has no endpoint", () => {
    const skillMd = `---
name: broken-remote
description: Missing endpoint
metadata:
  roll-transport: streamable-http
---
`;
    writeFileSync(resolve(tmpDir, "SKILL.md"), skillMd);

    assert.throws(
      () => discoverAgent(tmpDir),
      (err: Error) => err.message.includes("roll-endpoint"),
    );
  });

  it("should extract optional license and compatibility", () => {
    const skillMd = `---
name: full-agent
description: Full metadata
license: MIT
compatibility: ">=22.6.0"
metadata: {}
---
`;
    writeFileSync(resolve(tmpDir, "SKILL.md"), skillMd);

    const result = discoverAgent(tmpDir);
    assert.equal(result.skill.license, "MIT");
    assert.equal(result.skill.compatibility, ">=22.6.0");
  });
});
