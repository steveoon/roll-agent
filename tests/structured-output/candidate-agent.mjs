import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { defineAgent } from "../../packages/sdk/src/index.ts";

const require = createRequire(new URL("../../packages/sdk/package.json", import.meta.url));
const { z } = await import(
  new URL("./index.js", pathToFileURL(require.resolve("zod/package.json")))
);
const data = {
  candidates: [{ id: "candidate-1", name: "李明", score: 0.9, skills: ["TypeScript", "Node.js"] }],
};
const tool = {
  name: "list_candidates",
  description: "Return synthetic candidates for structured output integration testing",
  input: z.object({}),
  output: z.object({
    candidates: z.array(
      z.object({
        id: z.string(),
        name: z.string(),
        score: z.number(),
        skills: z.array(z.string()),
      }),
    ),
  }),
  appOutput: { schemaId: "example.candidates", schemaVersion: 1, remoteReadable: true },
  execute: async () => {
    const countFile = process.env.ROLL_TEST_EFFECT_COUNT;
    if (countFile) {
      const previous = existsSync(countFile) ? Number(readFileSync(countFile, "utf8")) : 0;
      writeFileSync(countFile, String(previous + 1));
    }
    return process.env.ROLL_TEST_INVALID_OUTPUT === "1" ? { candidates: "invalid" } : data;
  },
};
await defineAgent(
  { name: "structured-output-demo", tools: [tool] },
  { logLevel: "error" },
).listen();
