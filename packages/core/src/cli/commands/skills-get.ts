import { defineCommand } from "citty";
import { loadAgentsConfig } from "../../config/loader.ts";
import { AgentStore } from "../../registry/store.ts";
import { resolveAgentSkillDocument } from "./skills-utils.ts";

export default defineCommand({
  meta: { description: "输出指定 Agent 的 skill 文档内容" },
  args: {
    name: { type: "positional", description: "Agent 名称", required: true },
    json: { type: "boolean", description: "JSON 格式输出", default: false },
    "include-references": {
      type: "boolean",
      description: "同时输出 SKILL.md 中引用的 references/* 文档",
      default: false,
    },
  },
  run({ args }) {
    const { agentsConfig } = loadAgentsConfig();
    const store = new AgentStore(agentsConfig.dataDir);
    const agent = store.findByName(args.name);

    if (!agent) {
      console.error(`✗ Agent "${args.name}" 未找到`);
      process.exitCode = 1;
      return;
    }

    const document = resolveAgentSkillDocument(agent, {
      includeReferences: args["include-references"] === true,
    });
    if (args.json) {
      console.log(JSON.stringify(document, null, 2));
      return;
    }

    console.log(document.content.trimEnd());
    if (document.references && document.references.length > 0) {
      for (const reference of document.references) {
        console.log(`\n--- ${reference.relativePath} ---\n`);
        console.log(reference.content.trimEnd());
      }
    }
  },
});
