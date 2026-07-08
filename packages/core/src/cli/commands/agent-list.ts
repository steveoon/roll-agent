import { defineCommand } from "citty";
import chalk from "chalk";
import Table from "cli-table3";
import { loadAgentsConfig, loadInstallConfig } from "../../config/loader.ts";
import { resolveAgentCatalog } from "../../registry/catalog-discovery.ts";
import {
  formatAgentSourceType,
  getAgentLocation,
  inferAgentSourceType,
} from "../../registry/source.ts";
import { AgentStore } from "../../registry/store.ts";
import { inspectCatalogAvailability } from "../utils/catalog-status.ts";
import { formatLocationForDisplay, resolveTerminalColumns } from "../utils/terminal.ts";
import type { CatalogAvailabilityItem, CatalogInstallState } from "../utils/catalog-status.ts";
import type { RegisteredAgent } from "../../types/agent.ts";

type AgentListColumnWidths = readonly [number, number, number, number, number];

const AGENT_LIST_TABLE_BORDER_WIDTH = 6;
const TABLE_CELL_HORIZONTAL_PADDING = 2;

export default defineCommand({
  meta: { description: "列出所有已注册 Agent" },
  args: {
    json: { type: "boolean", description: "JSON 格式输出", default: false },
    available: {
      type: "boolean",
      description: "列出官方 catalog 中可安装的 Agent 及安装状态",
      default: false,
    },
  },
  async run({ args }) {
    const { agentsConfig } = loadAgentsConfig();
    const store = new AgentStore(agentsConfig.dataDir);
    const agents = store.list();

    if (args.available) {
      await listAvailableAgents(agents, args.json);
      return;
    }

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

const AVAILABLE_STATE_BADGES: Record<CatalogInstallState, (item: CatalogAvailabilityItem) => string> = {
  "not-installed": (item) =>
    chalk.yellow("未安装") +
    (item.latestVersion ? chalk.dim(` · 最新 v${item.latestVersion}`) : ""),
  installed: (item) => {
    const version =
      item.installedAgent?.source?.type === "installed-package"
        ? item.installedAgent.source.installedVersion
        : undefined;
    const base = chalk.green(`已安装${version ? ` v${version}` : ""}`);
    return item.update?.status === "update-available" && item.latestVersion
      ? `${base} ${chalk.yellow(`⬆ 可更新到 v${item.latestVersion}`)}`
      : base;
  },
  "installed-other-source": (item) => {
    const sourceLabel = item.installedAgent
      ? formatAgentSourceType(inferAgentSourceType(item.installedAgent))
      : "unknown";
    return (
      chalk.green("已注册") +
      chalk.dim(`（${sourceLabel} 来源）`) +
      (item.latestVersion ? chalk.dim(` · npm 最新 v${item.latestVersion}`) : "")
    );
  },
};

async function listAvailableAgents(agents: readonly RegisteredAgent[], json: boolean): Promise<void> {
  let registry: string | undefined;
  try {
    registry = loadInstallConfig().installConfig.registry;
  } catch {
    registry = undefined;
  }

  const catalog = await resolveAgentCatalog(undefined, {
    ...(registry ? { registry } : {}),
  });
  const items = await inspectCatalogAvailability(catalog, agents, {
    ...(registry ? { registry } : {}),
  });

  if (json) {
    console.log(JSON.stringify(items, null, 2));
    return;
  }

  const lines: string[] = [];
  for (const item of items) {
    lines.push(
      `${chalk.cyan.bold(item.entry.shortName)}  ${chalk.dim(item.entry.packageName)}  ${AVAILABLE_STATE_BADGES[item.state](item)}`,
    );
    lines.push(`  ${item.entry.description}`);
    lines.push(
      `  ${chalk.dim("必需环境变量:")} ${
        item.entry.requiredEnv.length > 0
          ? item.entry.requiredEnv.join(", ")
          : chalk.dim("安装后由 SKILL.md 声明")
      }`,
    );
    lines.push("");
  }
  lines.push("使用 `roll agent install <name>` 安装官方 Agent。");
  console.log(lines.join("\n"));
}

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
