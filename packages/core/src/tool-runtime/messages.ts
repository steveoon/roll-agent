import type { AskValidationIssue } from "../types/ask.ts";

export function formatValidationIssuesMessage(
  agentName: string,
  toolName: string,
  validationIssues: ReadonlyArray<AskValidationIssue>,
): string {
  const issueSummary = validationIssues
    .map((issue) => (issue.description ? `${issue.path}（${issue.description}）` : issue.path))
    .join("、");
  return `已路由到 ${agentName}.${toolName}，但参数校验未通过：${issueSummary}`;
}
