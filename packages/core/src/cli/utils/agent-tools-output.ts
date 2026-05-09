import chalk from "chalk";
import Table from "cli-table3";
import type { AgentTool } from "../../types/agent.ts";
import { indentBlock, resolveTerminalColumns } from "./terminal.ts";

type ToolSummaryColumnWidths = readonly [number, number, number];

const SUMMARY_TABLE_BORDER_WIDTH = 4;

export function formatAgentToolsTextOutput(agentName: string, tools: readonly AgentTool[]): string {
  const terminalColumns = resolveTerminalColumns();
  const summaryTable = createToolsSummaryTable(tools, terminalColumns);
  const detailBlocks = tools.map((tool, index) => formatToolDetailBlock(tool, index + 1));

  return [
    `${chalk.cyan(agentName)} tools (${tools.length})`,
    summaryTable.toString(),
    "",
    chalk.bold("Input Schemas"),
    ...detailBlocks,
    "",
    chalk.dim(`提示: 使用 roll agent tools ${agentName} --json 获取机器可读完整结构。`),
  ].join("\n");
}

function createToolsSummaryTable(tools: readonly AgentTool[], terminalColumns: number) {
  const columnWidths = getToolSummaryColumnWidths(terminalColumns);
  const table = new Table({
    head: ["Tool", "Description", "Input"],
    colWidths: [...columnWidths],
    truncate: "…",
    style: { head: ["cyan"] },
  });

  for (const tool of tools) {
    table.push([
      tool.name,
      tool.description ?? chalk.dim("(no description)"),
      summarizeInputSchema(tool.inputSchema),
    ]);
  }

  return table;
}

function getToolSummaryColumnWidths(terminalColumns: number): ToolSummaryColumnWidths {
  const tableBudget = terminalColumns - SUMMARY_TABLE_BORDER_WIDTH;
  const toolWidth = tableBudget >= 110 ? 30 : 22;
  const inputWidth = tableBudget >= 110 ? 36 : 26;
  const descriptionWidth = Math.max(24, tableBudget - toolWidth - inputWidth);

  return [toolWidth, descriptionWidth, inputWidth];
}

function summarizeInputSchema(schema: AgentTool["inputSchema"]): string {
  const propertyNames = Object.keys(schema.properties ?? {});

  if (propertyNames.length === 0) {
    return `${schema.type}: no fields`;
  }

  const fieldText = propertyNames.length === 1 ? "1 field" : `${propertyNames.length} fields`;
  const requiredNames = schema.required ?? [];

  if (requiredNames.length === 0) {
    return `${schema.type}: ${fieldText}`;
  }

  if (requiredNames.length === 1) {
    return `${schema.type}: ${fieldText}, req`;
  }

  return `${schema.type}: ${fieldText}, req ${requiredNames.length}`;
}

function formatToolDetailBlock(tool: AgentTool, index: number): string {
  const lines = [
    "",
    `${chalk.dim(`${index}.`)} ${chalk.cyan(tool.name)}`,
    `  ${chalk.dim("Description")}`,
    indentBlock(tool.description ?? "(no description)", 4),
    `  ${chalk.dim("Input Schema")}`,
    indentBlock(JSON.stringify(tool.inputSchema, null, 2), 4),
  ];

  return lines.join("\n");
}
