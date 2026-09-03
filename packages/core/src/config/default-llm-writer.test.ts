import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeDefaultLlm } from "./default-llm-writer.ts";

describe("writeDefaultLlm", () => {
  it("rewrites llm.default-provider / default-model and keeps the rest", () => {
    const dir = mkdtempSync(join(tmpdir(), "roll-default-llm-"));
    const configPath = join(dir, "roll.config.yaml");
    writeFileSync(
      configPath,
      [
        "llm:",
        "  default-provider: qwen",
        "  default-model: qwen3.8-max",
        "  providers:",
        "    qwen:",
        "      api-key: $" + "{DASHSCOPE_API_KEY}",
        "    google:",
        "      api-key: $" + "{GOOGLE_GENERATIVE_AI_API_KEY}",
        "agents:",
        "  data-dir: ~/.roll-agent/agents",
        "",
      ].join("\n"),
    );
    try {
      const result = writeDefaultLlm(
        { provider: "google", model: "gemini-3.8-flash" },
        { configPath },
      );
      assert.equal(result.configPath, configPath);
      const written = readFileSync(configPath, "utf8");
      assert.match(written, /default-provider: google/u);
      assert.match(written, /default-model: gemini-3\.8-flash/u);
      assert.match(written, /api-key: \$\{DASHSCOPE_API_KEY\}/u);
      assert.doesNotMatch(written, /qwen3\.8-max/u);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
