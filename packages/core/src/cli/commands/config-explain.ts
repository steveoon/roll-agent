import { getAgentEnvFromAgentsConfig, inspectAgentEnvRequirements } from "../../config/helpers.ts";
import { loadAgentsConfig } from "../../config/loader.ts";
import { normalizeUserPath } from "../../config/key-codec.ts";
import { AgentStore } from "../../registry/store.ts";
import {
  findConfigGuidance,
  flattenAgentEnvDeclarations,
  listConfigGuidanceEntries,
} from "../../config/guidance.ts";

export function explainConfig(path: string | undefined): void {
  if (path === undefined) {
    console.log("可解释的配置路径:\n");
    for (const entry of listConfigGuidanceEntries()) {
      console.log(`- ${entry.path}: ${entry.title}`);
    }
    console.log("\n示例:");
    console.log("  roll config explain install.registry");
    console.log("  roll config explain agents.env.browser-use-agent.REPLY_AUTHORITY_URL");
    return;
  }

  const agentEnvExplanation = tryExplainAgentEnv(path);
  if (agentEnvExplanation) {
    console.log(agentEnvExplanation);
    return;
  }

  const guidance = findConfigGuidance(path);
  if (!guidance) {
    console.error(`✗ 未找到配置说明: ${path}`);
    console.error("  运行 `roll config explain` 查看可用路径。");
    process.exitCode = 1;
    return;
  }

  console.log(`${guidance.title}\n`);
  console.log(`路径: ${guidance.path}`);
  console.log(`用途: ${guidance.purpose}`);
  if (guidance.defaultBehavior) {
    console.log(`默认行为: ${guidance.defaultBehavior}`);
  }
  if (guidance.example) {
    console.log(`示例:\n${guidance.example}`);
  }
  if (guidance.setupCommand) {
    console.log(`配置向导: ${guidance.setupCommand}`);
  }
}

function tryExplainAgentEnv(path: string): string | undefined {
  const parts = normalizeUserPath(path.split("."));
  if (parts[0] !== "agents" || parts[1] !== "env") {
    return undefined;
  }

  const agentName = parts[2];
  if (agentName === undefined) {
    return undefined;
  }

  const envName = parts[3];
  const { agentsConfig } = loadAgentsConfig();
  const store = new AgentStore(agentsConfig.dataDir);
  const agent = store.findByName(agentName);
  if (!agent) {
    return `Agent 环境变量\n\nAgent "${agentName}" 未注册。\n配置向导: roll config setup agent ${agentName}`;
  }

  const declarations = flattenAgentEnvDeclarations(agent.skill.env);
  if (declarations.length === 0) {
    return `Agent 环境变量\n\nAgent "${agentName}" 未声明环境变量需求。`;
  }

  if (envName === undefined) {
    const report = inspectAgentEnvRequirements(agent.skill.name, agent.skill.env, agentsConfig.env);
    const lines = [
      `Agent 环境变量`,
      ``,
      `路径: agents.env.${agentName}`,
      `用途: 注入到 Agent "${agentName}" 进程的环境变量。`,
      `配置向导: roll config setup agent ${agentName}`,
      ``,
      `变量:`,
    ];
    for (const item of report?.items ?? declarations) {
      lines.push(
        `- ${item.name}: ${item.required ? "必填" : "可选"}${"source" in item ? `，来源 ${item.source}` : ""}`,
      );
    }
    return lines.join("\n");
  }

  const declaration = declarations.find((item) => item.name === envName);
  if (!declaration) {
    return `Agent 环境变量\n\nAgent "${agentName}" 未声明环境变量 ${envName}。\n配置向导: roll config setup agent ${agentName}`;
  }

  const report = inspectAgentEnvRequirements(agent.skill.name, agent.skill.env, agentsConfig.env);
  const item = report?.items.find((candidate) => candidate.name === envName);
  const configuredEnv = getAgentEnvFromAgentsConfig(agentsConfig, agent.skill.name);
  const lines = [
    `Agent 环境变量: ${envName}`,
    ``,
    `路径: agents.env.${agentName}.${envName}`,
    `Agent: ${agentName}`,
    `类型: ${declaration.required ? "必填" : "可选"}`,
  ];
  if (declaration.purpose) {
    lines.push(`用途: ${declaration.purpose}`);
  }
  if (declaration.default) {
    lines.push(`默认值: ${declaration.default}`);
  }
  if (declaration.example) {
    lines.push(`示例: ${declaration.example}`);
  }
  if (item) {
    lines.push(`当前来源: ${item.source}`);
  }
  if (configuredEnv?.[envName]) {
    lines.push(`当前 YAML: 已配置`);
  }
  lines.push(`配置向导: roll config setup agent ${agentName}`);
  return lines.join("\n");
}
