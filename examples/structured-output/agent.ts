import { defineAgent, defineTool } from "@roll-agent/sdk";
import { z } from "zod";

const output = z.object({
  candidates: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      score: z.number().min(0).max(1),
      skills: z.array(z.string()),
    }),
  ),
});

await defineAgent({
  name: "structured-output-demo",
  tools: [
    defineTool({
      name: "list_candidates",
      description:
        "Return three synthetic candidates for testing custom application UI. No real personal data.",
      input: z.object({}),
      output,
      appOutput: { schemaId: "example.candidates", schemaVersion: 1, remoteReadable: true },
      annotations: { readOnlyHint: true, destructiveHint: false },
      execute: async () => ({
        candidates: [
          { id: "demo-1", name: "Alex Chen (demo)", score: 0.94, skills: ["TypeScript", "React"] },
          { id: "demo-2", name: "林晓 (演示)", score: 0.88, skills: ["Python", "Data analysis"] },
          {
            id: "demo-3",
            name: "Sam Patel (demo)",
            score: 0.81,
            skills: ["Rust", "Distributed systems"],
          },
        ],
      }),
    }),
  ],
}).listen();
