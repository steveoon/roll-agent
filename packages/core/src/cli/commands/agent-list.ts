import { defineCommand } from "citty";
import Table from "cli-table3";
import { loadAgentsConfig } from "../../config/loader.ts";
import {
  formatAgentSourceType,
  getAgentLocation,
  inferAgentSourceType,
} from "../../registry/source.ts";
import { AgentStore } from "../../registry/store.ts";
import { formatLocationForDisplay, resolveTerminalColumns } from "../utils/terminal.ts";

type AgentListColumnWidths = readonly [number, number, number, number, number];

const AGENT_LIST_TABLE_BORDER_WIDTH = 6;
const TABLE_CELL_HORIZONTAL_PADDING = 2;

export default defineCommand({
  meta: { description: "列出所有已注册 Agent" },
  args: {
    json: { type: "boolean", description: "JSON 格式输出", default: false },
  },
  run({ args }) {
    const { agentsConfig } = loadAgentsConfig();
    const store = new AgentStore(agentsConfig.dataDir);
    const agents = store.list();

    if (args.json) {
      console.log(JSON.stringify(agents, null, 2));
      return;
    }

    if (agents.length === 0) {
      console.log(
        "暂无已注册的 Agent。可使用 `roll agent add <path>`、`roll agent install <package>` 或 `roll agent add --remote <endpoint>`。",
      );
      return;
    }

    const columnWidths = getAgentListColumnWidths(resolveTerminalColumns());
    const table = new Table({
      head: ["Name", "Status", "Source", "Transport", "Location"],
      colWidths: [...columnWidths],
      truncate: "…",
      style: { head: ["cyan"] },
    });

    for (const agent of agents) {
      table.push([
        agent.skill.name,
        agent.status,
        formatAgentSourceType(inferAgentSourceType(agent)),
        agent.transport.type,
        formatLocationForDisplay(getAgentLocation(agent), getCellContentWidth(columnWidths[4])),
      ]);
    }

    console.log(table.toString());
  },
});

function getAgentListColumnWidths(terminalColumns: number): AgentListColumnWidths {
  const tableBudget = terminalColumns - AGENT_LIST_TABLE_BORDER_WIDTH;
  const statusWidth = 10;
  const sourceWidth = 14;
  const transportWidth = 19;
  const preferredNameWidth = 24;
  const minimumNameWidth = 16;
  const minimumLocationWidth = 15;
  const fixedWidth = statusWidth + sourceWidth + transportWidth;
  const preferredLocationWidth = tableBudget - fixedWidth - preferredNameWidth;

  if (preferredLocationWidth >= minimumLocationWidth) {
    return [preferredNameWidth, statusWidth, sourceWidth, transportWidth, preferredLocationWidth];
  }

  const nameWidth = Math.max(minimumNameWidth, tableBudget - fixedWidth - minimumLocationWidth);
  const locationWidth = tableBudget - fixedWidth - nameWidth;

  return [nameWidth, statusWidth, sourceWidth, transportWidth, locationWidth];
}

function getCellContentWidth(columnWidth: number): number {
  return Math.max(1, columnWidth - TABLE_CELL_HORIZONTAL_PADDING);
}
