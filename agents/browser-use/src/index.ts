import { defineAgent } from "@roll-agent/sdk";
import { BrowserRuntimeConfigSchema } from "@roll-agent/browser";
import { browserStatus } from "./tools/browser-status.ts";
import { openPlatform } from "./tools/open-platform.ts";
import { zhipinReadMessages } from "./tools/zhipin-read-messages.ts";
import { zhipinSendReply } from "./tools/zhipin-send-reply.ts";
import { zhipinGetCandidateInfo } from "./tools/zhipin-get-candidate-info.ts";
import { yupaoReadMessages } from "./tools/yupao-read-messages.ts";
import { yupaoSendReply } from "./tools/yupao-send-reply.ts";
import { initRuntime, shutdownRuntime } from "./runtime-holder.ts";

function parseBooleanEnv(value: string | undefined): boolean | undefined {
  if (value === undefined) return undefined;
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error(`Expected boolean env value "true" or "false", received "${value}".`);
}

function parseIntegerEnv(value: string | undefined, label: string): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed)) {
    throw new Error(`${label} must be an integer, received "${value}".`);
  }
  return parsed;
}

function parseArgsJson(value: string | undefined): string[] | undefined {
  if (value === undefined) return undefined;
  const parsed: unknown = JSON.parse(value);
  if (!Array.isArray(parsed) || !parsed.every((item) => typeof item === "string")) {
    throw new Error("BROWSER_ARGS_JSON must be a JSON string array.");
  }
  return parsed;
}

function loadRuntimeConfigFromEnv() {
  return BrowserRuntimeConfigSchema.parse({
    mode: process.env["BROWSER_MODE"],
    headless: parseBooleanEnv(process.env["BROWSER_HEADLESS"]),
    cdpUrl: process.env["BROWSER_CDP_URL"],
    cdpHost: process.env["BROWSER_CDP_HOST"],
    cdpPort: parseIntegerEnv(process.env["BROWSER_CDP_PORT"], "BROWSER_CDP_PORT"),
    channel: process.env["BROWSER_CHANNEL"],
    executablePath: process.env["BROWSER_EXECUTABLE_PATH"],
    userDataDir: process.env["BROWSER_USER_DATA_DIR"],
    args: parseArgsJson(process.env["BROWSER_ARGS_JSON"]),
    sessionsDir: process.env["BROWSER_SESSIONS_DIR"],
  });
}

const agent = defineAgent(
  {
    name: "browser-use-agent",
    tools: [
      browserStatus,
      openPlatform,
      zhipinReadMessages,
      zhipinSendReply,
      zhipinGetCandidateInfo,
      yupaoReadMessages,
      yupaoSendReply,
    ],
  },
  {
    onShutdown: shutdownRuntime,
  },
);

async function main(): Promise<void> {
  await initRuntime(loadRuntimeConfigFromEnv());

  // 以 HTTP 模式启动 MCP Server
  await agent.listen({
    transport: {
      type: "http",
      port: parseInt(process.env["BROWSER_AGENT_PORT"] ?? "3100", 10),
      host: process.env["BROWSER_AGENT_HOST"] ?? "127.0.0.1",
    },
  });
}

main().catch(async (err: unknown) => {
  console.error("Fatal error:", err);
  await shutdownRuntime().catch(() => {});
  process.exit(1);
});
