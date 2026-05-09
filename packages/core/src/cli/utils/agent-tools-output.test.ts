import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { formatAgentToolsTextOutput } from "./agent-tools-output.ts";

describe("cli/utils/agent-tools-output", () => {
  it("renders a compact summary table and separate schema details", () => {
    const previousColumns = process.env.COLUMNS;
    process.env.COLUMNS = "80";

    try {
      const output = stripAnsi(
        formatAgentToolsTextOutput("browser-use-agent", [
          {
            name: "browser_status",
            description: "查询浏览器运行状态和活跃 session 信息",
            inputSchema: {
              type: "object",
              properties: {},
              additionalProperties: false,
            },
          },
          {
            name: "open_page",
            description: "打开页面",
            inputSchema: {
              type: "object",
              properties: {
                url: { type: "string" },
              },
              required: ["url"],
              additionalProperties: false,
            },
          },
        ]),
      );

      assert.match(output, /browser-use-agent tools \(2\)/);
      assert.match(output, /Tool/);
      assert.match(output, /Description/);
      assert.match(output, /Input/);
      assert.match(output, /Input Schemas/);
      assert.match(output, /1\. browser_status/);
      assert.match(output, /"additionalProperties": false/);
      assert.match(output, /object: 1 field, req/);
      assert.ok(output.split("\n").every((line) => line.length <= 80));
    } finally {
      if (previousColumns === undefined) {
        delete process.env.COLUMNS;
      } else {
        process.env.COLUMNS = previousColumns;
      }
    }
  });
});

function stripAnsi(value: string): string {
  const ansiPattern = new RegExp(`${String.fromCharCode(27)}\\[[0-?]*[ -/]*[@-~]`, "g");
  return value.replace(ansiPattern, "");
}
