import { z } from "zod";
import { defineAgent, defineTool } from "../../../src/index.ts";

const ping = defineTool({
  name: "ping",
  description: "Return a deterministic empty message list for smoke tests",
  input: z.object({}),
  output: z.object({
    messages: z.array(z.string()),
  }),
  execute: async () => ({
    messages: [],
  }),
});

const agent = defineAgent({
  name: "smoke-test-agent",
  tools: [ping],
});

await agent.listen();
