import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import {
  McpClientManager,
  buildStdioChildEnv,
  shouldSuppressStdioChildStderrLine,
} from "./client-manager.ts";

const ORIGINAL_NODE_OPTIONS = process.env["NODE_OPTIONS"];
const ORIGINAL_ROLL_AGENT_LOG_LEVEL = process.env["ROLL_AGENT_LOG_LEVEL"];
const ORIGINAL_ROLL_TEST_INHERITED = process.env["ROLL_TEST_INHERITED"];

describe("buildStdioChildEnv", () => {
  afterEach(() => {
    restoreEnv("NODE_OPTIONS", ORIGINAL_NODE_OPTIONS);
    restoreEnv("ROLL_AGENT_LOG_LEVEL", ORIGINAL_ROLL_AGENT_LOG_LEVEL);
    restoreEnv("ROLL_TEST_INHERITED", ORIGINAL_ROLL_TEST_INHERITED);
  });

  it("sets quiet defaults without inheriting arbitrary parent env when agent env is absent", () => {
    process.env["ROLL_TEST_INHERITED"] = "secret";
    delete process.env["NODE_OPTIONS"];
    delete process.env["ROLL_AGENT_LOG_LEVEL"];

    const env = buildStdioChildEnv();

    assert.equal(env["NODE_OPTIONS"], "--disable-warning=ExperimentalWarning");
    assert.equal(env["ROLL_AGENT_LOG_LEVEL"], "warn");
    assert.equal(env["ROLL_TEST_INHERITED"], undefined);
  });

  it("preserves explicit agent env and appends experimental warning suppression", () => {
    process.env["ROLL_TEST_INHERITED"] = "from-parent";

    const env = buildStdioChildEnv({
      NODE_OPTIONS: "--max-old-space-size=4096",
      ROLL_AGENT_LOG_LEVEL: "debug",
      AGENT_TOKEN: "configured",
    });

    assert.equal(
      env["NODE_OPTIONS"],
      "--max-old-space-size=4096 --disable-warning=ExperimentalWarning",
    );
    assert.equal(env["ROLL_AGENT_LOG_LEVEL"], "debug");
    assert.equal(env["AGENT_TOKEN"], "configured");
    assert.equal(env["ROLL_TEST_INHERITED"], "from-parent");
  });

  it("does not duplicate existing warning suppression", () => {
    const env = buildStdioChildEnv({
      NODE_OPTIONS: "--disable-warning=ExperimentalWarning",
    });

    assert.equal(env["NODE_OPTIONS"], "--disable-warning=ExperimentalWarning");
  });
});

describe("shouldSuppressStdioChildStderrLine", () => {
  it("suppresses Node experimental warnings and stdio startup info logs", () => {
    assert.equal(
      shouldSuppressStdioChildStderrLine(
        "(node:79713) ExperimentalWarning: Type Stripping is an experimental feature",
      ),
      true,
    );
    assert.equal(
      shouldSuppressStdioChildStderrLine(
        "(Use `node --trace-warnings ...` to show where the warning was created)",
      ),
      true,
    );
    assert.equal(
      shouldSuppressStdioChildStderrLine(
        "2026-06-18T07:08:38.099Z [INFO ] [reply-policy-tuner-agent] MCP Server running on stdio",
      ),
      true,
    );
  });

  it("keeps non-startup child stderr visible", () => {
    assert.equal(
      shouldSuppressStdioChildStderrLine(
        "2026-06-18T07:08:38.099Z [WARN ] [reply-policy-tuner-agent] missing optional config",
      ),
      false,
    );
    assert.equal(shouldSuppressStdioChildStderrLine("Error: failed to start"), false);
  });
});

describe("McpClientManager stdio stderr filtering", () => {
  it("suppresses startup noise while keeping real child stderr visible", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "roll-mcp-stderr-"));
    const scriptPath = join(tempDir, "fixture-agent.mjs");
    writeFileSync(scriptPath, buildFixtureAgentScript());

    const manager = new McpClientManager();
    const stderrLines: string[] = [];
    const originalWrite: typeof process.stderr.write = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array, ...args: unknown[]): boolean => {
      stderrLines.push(chunk.toString());
      const callback = args.find((arg): arg is (error?: Error | null) => void => {
        return typeof arg === "function";
      });
      callback?.();
      return true;
    }) as typeof process.stderr.write;

    try {
      const client = await manager.connect(
        "fixture-agent",
        { type: "stdio", command: process.execPath, args: [scriptPath] },
        process.cwd(),
      );

      const listed = await client.listTools();

      assert.deepEqual(listed.tools, []);
      const stderr = stderrLines.join("");
      assert.doesNotMatch(stderr, /ExperimentalWarning/);
      assert.doesNotMatch(stderr, /MCP Server running on stdio/);
      assert.match(stderr, /REAL_CHILD_ERROR visible/);
    } finally {
      process.stderr.write = originalWrite;
      await manager.disconnectAll();
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key];
    return;
  }
  process.env[key] = value;
}

function buildFixtureAgentScript(): string {
  return `
process.stderr.write("(node:12345) ExperimentalWarning: Type Stripping is an experimental feature\\n");
process.stderr.write("(Use \`node --trace-warnings ...\` to show where the warning was created)\\n");
process.stderr.write("2026-06-18T07:08:38.099Z [INFO ] [fixture-agent] MCP Server running on stdio\\n");
process.stderr.write("REAL_CHILD_ERROR visible\\n");

process.stdin.setEncoding("utf8");
let buffer = "";

process.stdin.on("data", (chunk) => {
  buffer += chunk;
  const lines = buffer.split(/\\r?\\n/);
  buffer = lines.pop() ?? "";
  for (const line of lines) {
    if (line.length === 0) continue;
    handleMessage(JSON.parse(line));
  }
});

function handleMessage(message) {
  if (message.method === "initialize") {
    writeResult(message.id, {
      protocolVersion: message.params.protocolVersion,
      capabilities: { tools: {} },
      serverInfo: { name: "fixture-agent", version: "0.0.0" },
    });
    return;
  }
  if (message.method === "tools/list") {
    writeResult(message.id, { tools: [] });
  }
}

function writeResult(id, result) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\\n");
}
`;
}
