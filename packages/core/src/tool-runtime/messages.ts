import type { AskValidationIssue } from "../types/ask.ts";

function formatIssueLabel(issue: AskValidationIssue): string {
  return issue.description ? `${issue.path}（${issue.description}）` : issue.path;
}

export function formatValidationIssuesMessage(
  agentName: string,
  toolName: string,
  validationIssues: ReadonlyArray<AskValidationIssue>,
): string {
  const missingRequired = validationIssues
    .filter((issue) => issue.code === "missing_required")
    .map(formatIssueLabel);
  const requiresExplicitInput = validationIssues
    .filter((issue) => issue.code === "requires_explicit_input")
    .map(formatIssueLabel);
  const otherIssues = validationIssues
    .filter(
      (issue) => issue.code !== "missing_required" && issue.code !== "requires_explicit_input",
    )
    .map(formatIssueLabel);

  const segments = [`已路由到 ${agentName}.${toolName}`];
  if (missingRequired.length > 0) {
    segments.push(`还缺少必填信息：${missingRequired.join("、")}`);
  }
  if (requiresExplicitInput.length > 0) {
    segments.push(
      `以下字段无法从自然语言可靠提取，需要使用 \`roll run ${agentName} ${toolName} --input-json\` 或上游编排器显式提供：${requiresExplicitInput.join("、")}`,
    );
  }
  if (otherIssues.length > 0) {
    segments.push(`参数校验未通过：${otherIssues.join("、")}`);
  }

  return segments.join("；");
}
