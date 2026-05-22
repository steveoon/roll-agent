import { defineAgent, createAgentLogger } from "@roll-agent/sdk";
import { attachBrowserSession } from "./tools/attach-browser-session.ts";
import { browserStatus } from "./tools/browser-status.ts";
import { browserStop } from "./tools/browser-stop.ts";
import { listPages } from "./tools/list-pages.ts";
import { navigateActiveTab } from "./tools/navigate-active-tab.ts";
import { openPlatform } from "./tools/open-platform.ts";
import { selectPage } from "./tools/select-page.ts";
import { browserSnapshot } from "./tools/browser-snapshot.ts";
import { clickRef } from "./tools/click-ref.ts";
import { typeRef } from "./tools/type-ref.ts";
import { zhipinDiagnoseBrowserState } from "./tools/zhipin-diagnose-browser-state.ts";
// Zhipin — 聊天
import { zhipinReadMessages } from "./tools/zhipin-read-messages.ts";
import { zhipinOpenChatPage } from "./tools/zhipin-open-chat-page.ts";
import { zhipinOpenChat } from "./tools/zhipin-open-chat.ts";
import { zhipinGetCandidateInfo } from "./tools/zhipin-get-candidate-info.ts";
import { zhipinGenerateReplyPreview } from "./tools/zhipin-generate-reply-preview.ts";
import { zhipinSendPreparedReply } from "./tools/zhipin-send-prepared-reply.ts";
import { zhipinExchangeWechat } from "./tools/zhipin-exchange-wechat.ts";
import { zhipinGetUsername } from "./tools/zhipin-get-username.ts";
import { zhipinScrollView } from "./tools/zhipin-scroll-view.ts";
// Zhipin — 推荐列表
import { zhipinFilterRecommendCandidates } from "./tools/zhipin-filter-recommend-candidates.ts";
import { zhipinGetCandidateList } from "./tools/zhipin-get-candidate-list.ts";
import { zhipinListRecommendJobs } from "./tools/zhipin-list-recommend-jobs.ts";
import { zhipinOpenRecommendPage } from "./tools/zhipin-open-recommend-page.ts";
import { zhipinSelectRecommendJob } from "./tools/zhipin-select-recommend-job.ts";
import { zhipinSayHello } from "./tools/zhipin-say-hello.ts";
import { zhipinOpenResume } from "./tools/zhipin-open-resume.ts";
import { zhipinLocateResumeCanvas } from "./tools/zhipin-locate-resume-canvas.ts";
import { zhipinCloseResume } from "./tools/zhipin-close-resume.ts";
// Yupao
import { yupaoReadMessages } from "./tools/yupao-read-messages.ts";
import { yupaoSendReply } from "./tools/yupao-send-reply.ts";
import { preloadReplyAuthorityKeys } from "./reply-authority/key-store.ts";
import { initRuntime, setReplyAuthorityKeysLoaded, shutdownRuntime } from "./runtime-holder.ts";
import { loadBrowserInstancesConfigFromEnv, loadRuntimeConfigFromEnv } from "./runtime-config.ts";
import { loadBrowserUsePolicyFromEnv, setBrowserUsePolicy } from "./browser-use-policy.ts";
import { withBrowserInstanceInput } from "./tools/browser-instance-input.ts";
import type { AnyToolDefinition } from "@roll-agent/sdk";

const logger = createAgentLogger("browser-use-agent");

function isGlobalBrowserRuntimeTool(toolName: string): boolean {
  return toolName === "browser_stop";
}

function withBrowserInstanceRuntimeSelection(tool: AnyToolDefinition): AnyToolDefinition {
  if (isGlobalBrowserRuntimeTool(tool.name)) {
    return tool;
  }

  return withBrowserInstanceInput(tool, {
    startRuntime: tool.name !== "browser_status",
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
      browserSnapshot,
      clickRef,
      typeRef,
      zhipinDiagnoseBrowserState,
      // Zhipin 聊天
      zhipinReadMessages,
      zhipinOpenChatPage,
      zhipinOpenChat,
      zhipinGetCandidateInfo,
      zhipinGenerateReplyPreview,
      zhipinSendPreparedReply,
      zhipinExchangeWechat,
      zhipinGetUsername,
      zhipinScrollView,
      // Zhipin 推荐列表
      zhipinOpenRecommendPage,
      zhipinListRecommendJobs,
      zhipinSelectRecommendJob,
      zhipinFilterRecommendCandidates,
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
      browserStop,
    ].map(withBrowserInstanceRuntimeSelection),
  },
  {
    onShutdown: shutdownRuntime,
  },
);

async function main(): Promise<void> {
  setBrowserUsePolicy(loadBrowserUsePolicyFromEnv());
  await initRuntime(loadRuntimeConfigFromEnv(), loadBrowserInstancesConfigFromEnv());

  try {
    await preloadReplyAuthorityKeys();
    setReplyAuthorityKeysLoaded(true);
  } catch (error) {
    setReplyAuthorityKeysLoaded(false);
    logger.error(
      `Failed to preload Reply Authority keys during startup; ` +
        `browser_status.replyAuthorityKeysLoaded=false. ` +
        `${error instanceof Error ? (error.stack ?? error.message) : String(error)}`,
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
  logger.error(`Fatal error: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
  await shutdownRuntime().catch(() => {});
  process.exit(1);
});
