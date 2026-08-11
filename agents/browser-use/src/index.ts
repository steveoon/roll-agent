import { defineAgent, createAgentLogger } from "@roll-agent/sdk";
import { attachBrowserSession } from "./tools/attach-browser-session.ts";
import { browserStatus } from "./tools/browser-status.ts";
import { browserStop } from "./tools/browser-stop.ts";
import { listPages } from "./tools/list-pages.ts";
import { navigateActiveTab } from "./tools/navigate-active-tab.ts";
import { browserReloadActiveTab } from "./tools/browser-reload-active-tab.ts";
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
import { zhipinJudgePreparedReply } from "./tools/zhipin-judge-prepared-reply.ts";
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
import { zhipinCaptureResume } from "./tools/zhipin-capture-resume.ts";
import { zhipinCloseResume } from "./tools/zhipin-close-resume.ts";
// Yupao
import { yupaoReadMessages } from "./tools/yupao-read-messages.ts";
import { yupaoSendReply } from "./tools/yupao-send-reply.ts";
import { preloadReplyAuthorityKeys } from "./reply-authority/key-store.ts";
import {
  initializeReplyFeedbackOutbox,
  shutdownReplyFeedbackOutbox,
} from "./reply-authority/reply-feedback-outbox.ts";
import { initRuntime, setReplyAuthorityKeysLoaded, shutdownRuntime } from "./runtime-holder.ts";
import { loadBrowserInstancesConfigFromEnv, loadRuntimeConfigFromEnv } from "./runtime-config.ts";
import { loadBrowserUsePolicyFromEnv, setBrowserUsePolicy } from "./browser-use-policy.ts";
import { withBrowserInstanceInput } from "./tools/browser-instance-input.ts";
import type { AnyToolDefinition } from "@roll-agent/sdk";

const logger = createAgentLogger("browser-use-agent");

async function shutdownAgent(): Promise<void> {
  const results = await Promise.allSettled([shutdownReplyFeedbackOutbox(), shutdownRuntime()]);
  const errors = results
    .filter((result): result is PromiseRejectedResult => result.status === "rejected")
    .map((result) => result.reason);
  if (errors.length > 0) {
    throw new AggregateError(errors, "Failed to fully shut down browser-use-agent");
  }
}

function isGlobalBrowserRuntimeTool(toolName: string): boolean {
  return toolName === "browser_stop" || toolName === "zhipin_judge_prepared_reply";
}

/**
 * page-free / 只读诊断工具：不操作共享页面状态，无需进 per-instance 互斥队列。
 * 尤其 browser_status / list_pages 是编排器的"排障出口"，
 * 必须保证在实例被长操作占用时依然可用。
 */
const PAGE_FREE_TOOL_NAMES = new Set<string>([
  "browser_status",
  "list_pages",
  "attach_browser_session",
  "zhipin_diagnose_browser_state",
]);

function withBrowserInstanceRuntimeSelection(tool: AnyToolDefinition): AnyToolDefinition {
  if (isGlobalBrowserRuntimeTool(tool.name)) {
    return tool;
  }

  return withBrowserInstanceInput(tool, {
    startRuntime: tool.name !== "browser_status",
    serializePageOps: !PAGE_FREE_TOOL_NAMES.has(tool.name),
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
      browserReloadActiveTab,
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
      zhipinJudgePreparedReply,
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
      zhipinCaptureResume,
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
    onShutdown: shutdownAgent,
  },
);

async function main(): Promise<void> {
  setBrowserUsePolicy(loadBrowserUsePolicyFromEnv());
  initializeReplyFeedbackOutbox({ logger });
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
  await shutdownAgent().catch(() => {});
  process.exit(1);
});
