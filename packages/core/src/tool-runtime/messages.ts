import type { AskRuntimeIssue, AskValidationIssue } from "../types/ask.ts";

function appendIssueDescription(text: string, description?: string): string {
  return description ? `${text}（${description}）` : text;
}

export function formatValidationIssuesMessage(
  agentName: string,
  toolName: string,
  validationIssues: ReadonlyArray<AskValidationIssue>,
  runtimeIssues: ReadonlyArray<AskRuntimeIssue> = [],
): string {
  const sections = [`已路由到 ${agentName}.${toolName}`];

  if (validationIssues.length > 0) {
    const validationLines = validationIssues.map((issue) => {
      if (issue.code === "requires_explicit_input") {
        return (
          "- " +
          appendIssueDescription(
            `${issue.message}；请使用 \`roll run ${agentName} ${toolName} --input-json\` 或上游编排器显式提供`,
            issue.description,
          )
        );
      }

      return `- ${appendIssueDescription(issue.message, issue.description)}`;
    });
    sections.push(["A. 输入缺失 / 参数校验", ...validationLines].join("\n"));
  }

  if (runtimeIssues.length > 0) {
    const runtimeLines = runtimeIssues.map((issue) => {
      const guidance =
        `请在 \`roll.config.yaml\` 的 \`agents.env.${agentName}\` 中配置，` +
        "或在当前 shell 环境导出后重试";
      return `- ${appendIssueDescription(`${issue.message}；${guidance}`, issue.purpose)}`;
    });
    sections.push(["B. 运行条件缺失", ...runtimeLines].join("\n"));
  }

  return sections.join("\n");
}
