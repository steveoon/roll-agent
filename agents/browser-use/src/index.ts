import { defineAgent, createAgentLogger } from "@roll-agent/sdk";
import { BrowserRuntimeConfigSchema } from "@roll-agent/browser";
import { attachBrowserSession } from "./tools/attach-browser-session.ts";
import { browserStatus } from "./tools/browser-status.ts";
import { listPages } from "./tools/list-pages.ts";
import { navigateActiveTab } from "./tools/navigate-active-tab.ts";
import { openPlatform } from "./tools/open-platform.ts";
import { selectPage } from "./tools/select-page.ts";
// Zhipin — 聊天
import { zhipinReadMessages } from "./tools/zhipin-read-messages.ts";
import { zhipinOpenChat } from "./tools/zhipin-open-chat.ts";
import { zhipinGetCandidateInfo } from "./tools/zhipin-get-candidate-info.ts";
import { zhipinSendReply } from "./tools/zhipin-send-reply.ts";
import { zhipinExchangeWechat } from "./tools/zhipin-exchange-wechat.ts";
import { zhipinGetUsername } from "./tools/zhipin-get-username.ts";
// Zhipin — 推荐列表
import { zhipinGetCandidateList } from "./tools/zhipin-get-candidate-list.ts";
import { zhipinSayHello } from "./tools/zhipin-say-hello.ts";
import { zhipinOpenResume } from "./tools/zhipin-open-resume.ts";
import { zhipinLocateResumeCanvas } from "./tools/zhipin-locate-resume-canvas.ts";
import { zhipinCloseResume } from "./tools/zhipin-close-resume.ts";
// Yupao
import { yupaoReadMessages } from "./tools/yupao-read-messages.ts";
import { yupaoSendReply } from "./tools/yupao-send-reply.ts";
import { preloadReplyAuthorityKeys } from "./reply-authority/key-store.ts";
import { initRuntime, setReplyAuthorityKeysLoaded, shutdownRuntime } from "./runtime-holder.ts";

const logger = createAgentLogger("browser-use-agent");

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
      // 通用
      browserStatus,
      listPages,
      navigateActiveTab,
      openPlatform,
      selectPage,
      // Zhipin 聊天
      zhipinReadMessages,
      zhipinOpenChat,
      zhipinGetCandidateInfo,
      zhipinSendReply,
      zhipinExchangeWechat,
      zhipinGetUsername,
      // Zhipin 推荐列表
      zhipinGetCandidateList,
      zhipinSayHello,
      zhipinOpenResume,
      zhipinLocateResumeCanvas,
      zhipinCloseResume,
      // Yupao
      yupaoReadMessages,
      yupaoSendReply,
      // 调试
      attachBrowserSession,
    ],
  },
  {
    onShutdown: shutdownRuntime,
  },
);

async function main(): Promise<void> {
  await initRuntime(loadRuntimeConfigFromEnv());

  try {
    await preloadReplyAuthorityKeys();
    setReplyAuthorityKeysLoaded(true);
  } catch (error) {
    setReplyAuthorityKeysLoaded(false);
    logger.error(
      `Failed to preload Reply Authority keys during startup; ` +
        `browser_status.replyAuthorityKeysLoaded=false. ` +
        `${error instanceof Error ? error.stack ?? error.message : String(error)}`,
    );
  }

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
  logger.error(`Fatal error: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
  await shutdownRuntime().catch(() => {});
  process.exit(1);
});
