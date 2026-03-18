import { defineAgent } from "@roll-agent/sdk";
import { browserStatus } from "./tools/browser-status.ts";
import { browserLogin } from "./tools/browser-login.ts";
import { zhipinReadMessages } from "./tools/zhipin-read-messages.ts";
import { zhipinSendReply } from "./tools/zhipin-send-reply.ts";
import { zhipinGetCandidateInfo } from "./tools/zhipin-get-candidate-info.ts";
import { yupaoReadMessages } from "./tools/yupao-read-messages.ts";
import { yupaoSendReply } from "./tools/yupao-send-reply.ts";
import { initRuntime, shutdownRuntime } from "./runtime-holder.ts";

const agent = defineAgent(
  {
    name: "browser-use-agent",
    tools: [
      browserStatus,
      browserLogin,
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
  // 初始化浏览器运行时
  await initRuntime({
    headless: process.env["BROWSER_HEADLESS"] !== "false",
  });

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
