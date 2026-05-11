import { defineCommand } from "citty";
import Table from "cli-table3";
import { loadAgentsConfig } from "../../config/loader.ts";
import { AgentStore } from "../../registry/store.ts";
import { formatLocationForDisplay, resolveTerminalColumns } from "../utils/terminal.ts";
import { listAgentSkills } from "./skills-utils.ts";

type SkillsListColumnWidths = readonly [number, number, number, number];

const TABLE_BORDER_WIDTH = 6;
const TABLE_CELL_HORIZONTAL_PADDING = 2;

export default defineCommand({
  meta: { description: "列出已注册 Agent 的 skill 文档来源" },
  args: {
    json: { type: "boolean", description: "JSON 格式输出", default: false },
  },
  run({ args }) {
    const { agentsConfig } = loadAgentsConfig();
    const store = new AgentStore(agentsConfig.dataDir);
    const skills = listAgentSkills(store.list());

    if (args.json) {
      console.log(JSON.stringify(skills, null, 2));
      return;
    }

    if (skills.length === 0) {
      console.log("暂无已注册 Agent skill。可先运行 `roll agent add <path|git-url>`。");
      return;
    }

    const columnWidths = getSkillsListColumnWidths(resolveTerminalColumns());
    const table = new Table({
      head: ["Name", "Source", "Path", "Description"],
      colWidths: [...columnWidths],
      truncate: "…",
      style: { head: ["cyan"] },
    });

    for (const skill of skills) {
      table.push([
        skill.name,
        skill.source,
        formatLocationForDisplay(
          skill.path ?? "(registry snapshot)",
          getCellContentWidth(columnWidths[2]),
        ),
        formatLocationForDisplay(skill.description, getCellContentWidth(columnWidths[3])),
      ]);
    }

    console.log(table.toString());
  },
});

function getSkillsListColumnWidths(terminalColumns: number): SkillsListColumnWidths {
  const tableBudget = terminalColumns - TABLE_BORDER_WIDTH;
  const nameWidth = 24;
  const sourceWidth = 12;
  const descriptionWidth = 34;
  const pathWidth = Math.max(24, tableBudget - nameWidth - sourceWidth - descriptionWidth);
  return [nameWidth, sourceWidth, pathWidth, descriptionWidth];
}

function getCellContentWidth(columnWidth: number): number {
  return Math.max(1, columnWidth - TABLE_CELL_HORIZONTAL_PADDING);
}
