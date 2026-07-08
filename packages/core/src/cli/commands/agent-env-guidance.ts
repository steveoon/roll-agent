import { log } from "../utils/output.ts";
import type { AgentEnvCheckReport } from "../../config/helpers.ts";

export function reportAgentEnvGuidance(
  agentName: string,
  envReport: AgentEnvCheckReport | undefined,
): void {
  if (!envReport) {
    return;
  }

  if (envReport.missingRequired.length > 0) {
    log.warn(
      `Agent "${agentName}" 仍缺少必填环境变量: ${envReport.missingRequired.map((item) => item.name).join(", ")}`,
    );
    log.info(`运行 \`roll config setup agent ${agentName}\` 交互式配置。`);
    log.info(`运行 \`roll config explain agents.env.${agentName}\` 查看配置说明。`);
    return;
  }

  if (envReport.processEnvOnlyRequired.length > 0) {
    log.warn(
      `Agent "${agentName}" 当前依赖 shell 环境变量: ${envReport.processEnvOnlyRequired.map((item) => item.name).join(", ")}`,
    );
    log.info(`建议运行 \`roll config setup agent ${agentName}\` 持久写入 roll.config.yaml。`);
  }
}
