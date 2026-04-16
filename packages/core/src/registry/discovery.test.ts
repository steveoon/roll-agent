import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdirSync, rmSync, symlinkSync } from "node:fs";
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
    assert.equal(result.runtime.ownership, "on-demand");
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
    assert.equal(result.runtime.ownership, "external-managed");
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
    assert.equal(result.runtime.ownership, "on-demand");
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

  it("should parse structured env declarations from roll-env-file", () => {
    const skillMd = `---
name: env-agent
description: Agent with env requirements
metadata:
  roll-env-file: references/env.yaml
---
`;
    writeFileSync(resolve(tmpDir, "SKILL.md"), skillMd);
    mkdirSync(resolve(tmpDir, "references"), { recursive: true });
    writeFileSync(
      resolve(tmpDir, "references/env.yaml"),
      `required:
  - name: API_TOKEN
    purpose: Access upstream API
    example: \${API_TOKEN}
optional:
  - name: MODEL_ID
    purpose: Override model selection
    default: provider/default-model
`,
    );

    const result = discoverAgent(tmpDir);
    assert.deepEqual(result.skill.env, {
      required: [
        {
          name: "API_TOKEN",
          purpose: "Access upstream API",
          example: "$" + "{API_TOKEN}",
        },
      ],
      optional: [
        {
          name: "MODEL_ID",
          purpose: "Override model selection",
          default: "provider/default-model",
        },
      ],
    });
  });

  it("should throw when roll-env-file is missing", () => {
    const skillMd = `---
name: missing-env-agent
description: Missing env file
metadata:
  roll-env-file: references/env.yaml
---
`;
    writeFileSync(resolve(tmpDir, "SKILL.md"), skillMd);

    assert.throws(
      () => discoverAgent(tmpDir),
      (err: Error) => err.message.includes("roll-env-file not found"),
    );
  });

  it("should reject roll-env-file that escapes agent directory", () => {
    const skillMd = `---
name: escaped-env-agent
description: Escaped env file
metadata:
  roll-env-file: ../env.yaml
---
`;
    writeFileSync(resolve(tmpDir, "SKILL.md"), skillMd);
    writeFileSync(resolve(tmpDir, "..", "env.yaml"), "required: []\n", "utf-8");

    assert.throws(
      () => discoverAgent(tmpDir),
      (err: Error) => err.message.includes("must stay within agent directory"),
    );
  });

  it("should reject roll-env-file symlinks that escape agent directory", () => {
    const externalEnvPath = resolve(tmpDir, "..", `external-env-${randomUUID()}.yaml`);
    const skillMd = `---
name: escaped-env-agent
description: Escaped env file
metadata:
  roll-env-file: references/env.yaml
---
`;

    writeFileSync(resolve(tmpDir, "SKILL.md"), skillMd);
    mkdirSync(resolve(tmpDir, "references"), { recursive: true });
    writeFileSync(externalEnvPath, "required:\n  - name: API_TOKEN\n", "utf-8");
    symlinkSync(externalEnvPath, resolve(tmpDir, "references", "env.yaml"));

    assert.throws(
      () => discoverAgent(tmpDir),
      (err: Error) => err.message.includes("must stay within agent directory"),
    );
  });

  it("should prefer package.json#rollAgent for core-managed http agents", () => {
    const skillMd = `---
name: browser-use-agent
description: Browser use agent
---

Tools list
`;
    const packageJson = JSON.stringify({
      name: "@roll-agent/browser-use-agent",
      version: "0.1.0",
      rollAgent: {
        runtime: {
          ownership: "core-managed",
          transport: "streamable-http",
        },
        start: {
          command: "node",
          args: ["dist/index.js"],
        },
        endpoint: {
          path: "/mcp",
          port: 3100,
        },
        setup: {
          playwright: {
            browsers: ["chromium"],
          },
        },
      },
    });

    writeFileSync(resolve(tmpDir, "SKILL.md"), skillMd);
    writeFileSync(resolve(tmpDir, "package.json"), packageJson, "utf-8");

    const result = discoverAgent(tmpDir);
    assert.equal(result.transport.type, "streamable-http");
    assert.equal(result.transport.endpoint, "http://127.0.0.1:3100/mcp");
    assert.equal(result.runtime.ownership, "core-managed");
    if (result.runtime.ownership === "core-managed") {
      assert.equal(result.runtime.start.command, "node");
      assert.deepEqual(result.runtime.start.args, ["dist/index.js"]);
      assert.deepEqual(result.runtime.endpoint, { path: "/mcp", port: 3100 });
      assert.deepEqual(result.runtime.setup, { playwright: { browsers: ["chromium"] } });
    }
  });

  it("browser-use-agent should default to no browser setup", () => {
    const result = discoverAgent(resolve(import.meta.dirname, "../../../../agents/browser-use"));

    assert.equal(result.skill.name, "browser-use-agent");
    assert.equal(result.runtime.ownership, "core-managed");
    if (result.runtime.ownership === "core-managed") {
      assert.equal(result.runtime.setup, undefined);
    }
  });

  it("smart-reply-agent should expose env declarations", () => {
    const result = discoverAgent(resolve(import.meta.dirname, "../../../../agents/smart-reply"));

    assert.equal(result.skill.name, "smart-reply-agent");
    assert.ok(result.skill.env);
    assert.deepEqual(
      result.skill.env?.required?.map((item) => item.name),
      ["REPLY_AUTHORITY_URL", "REPLY_AUTHORITY_BEARER_TOKEN"],
    );
    assert.equal(result.skill.env?.optional, undefined);
  });

  it("should prefer package.json#rollAgent for stdio on-demand agents", () => {
    const skillMd = `---
name: installable-stdio
description: Installable stdio agent
---
`;
    const packageJson = JSON.stringify({
      name: "@roll-agent/installable-stdio",
      version: "0.1.0",
      rollAgent: {
        runtime: {
          ownership: "on-demand",
          transport: "stdio",
        },
        start: {
          command: "node",
          args: ["dist/index.js"],
        },
      },
    });

    writeFileSync(resolve(tmpDir, "SKILL.md"), skillMd);
    writeFileSync(resolve(tmpDir, "package.json"), packageJson, "utf-8");

    const result = discoverAgent(tmpDir);
    assert.equal(result.transport.type, "stdio");
    assert.equal(result.runtime.ownership, "on-demand");
    if (result.transport.type === "stdio") {
      assert.equal(result.transport.command, "node");
      assert.deepEqual(result.transport.args, ["dist/index.js"]);
    }
  });

  it("should support package.json#rollAgent for external-managed streamable-http agents", () => {
    const skillMd = `---
name: external-http-agent
description: External managed HTTP agent
---
`;
    const packageJson = JSON.stringify({
      name: "@roll-agent/external-http-agent",
      version: "0.1.0",
      rollAgent: {
        runtime: {
          ownership: "external-managed",
          transport: "streamable-http",
        },
        endpoint: {
          url: "https://api.example.com/mcp",
        },
      },
    });

    writeFileSync(resolve(tmpDir, "SKILL.md"), skillMd);
    writeFileSync(resolve(tmpDir, "package.json"), packageJson, "utf-8");

    const result = discoverAgent(tmpDir);
    assert.equal(result.transport.type, "streamable-http");
    assert.equal(result.transport.endpoint, "https://api.example.com/mcp");
    assert.equal(result.runtime.ownership, "external-managed");
  });

  it("should throw when rollAgent conflicts with legacy runtime metadata", () => {
    const skillMd = `---
name: conflict-agent
description: conflicting runtime config
metadata:
  roll-transport: streamable-http
  roll-endpoint: http://localhost:9999/mcp
---
`;
    const packageJson = JSON.stringify({
      name: "@roll-agent/conflict-agent",
      version: "0.1.0",
      rollAgent: {
        runtime: {
          ownership: "core-managed",
          transport: "streamable-http",
        },
        start: {
          command: "node",
          args: ["dist/index.js"],
        },
        endpoint: {
          path: "/mcp",
          port: 3100,
        },
      },
    });

    writeFileSync(resolve(tmpDir, "SKILL.md"), skillMd);
    writeFileSync(resolve(tmpDir, "package.json"), packageJson, "utf-8");

    assert.throws(
      () => discoverAgent(tmpDir),
      (err: Error) => err.message.includes("Conflicting runtime metadata"),
    );
  });
});
