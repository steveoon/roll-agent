import { defineCommand } from "citty";
import { ChatGptAuthError, getChatGptAuthService } from "../../auth/chatgpt/service.ts";

const account = { type: "string", description: "ChatGPT 账号注册 ID" } as const;
const json = { type: "boolean", description: "JSON 格式输出", default: false } as const;

const login = defineCommand({
  meta: { description: "Continue with ChatGPT（实验功能）" },
  args: { account },
  async run({ args }) {
    const service = getChatGptAuthService();
    const attempt = await service.beginLogin(args.account);
    const cancel = () => {
      service.cancelLogin(attempt.id);
    };
    process.once("SIGINT", cancel);
    try {
      console.error("请在系统浏览器中完成 ChatGPT 登录授权。按 Ctrl+C 取消。");
      while (true) {
        const progress = service.loginStatus(attempt.id);
        if (progress.state !== "waiting" && progress.state !== "exchanging") {
          if (progress.state !== "succeeded") {
            throw new ChatGptAuthError(
              `login_${progress.state}`,
              progress.message ?? "ChatGPT 登录未完成。",
            );
          }
          console.error(progress.message);
          console.log(progress.accountId);
          return;
        }
        await new Promise<void>((resolve) => setTimeout(resolve, 250));
      }
    } finally {
      process.removeListener("SIGINT", cancel);
    }
  },
});

const status = defineCommand({
  meta: { description: "查看已保存账号及订阅授权状态" },
  args: { account, json },
  async run({ args }) {
    const result = await getChatGptAuthService().status(args.account);
    if (args.json) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    if (result.accounts.length === 0) {
      console.log("尚未登录 ChatGPT。请运行 roll auth chatgpt login。");
      return;
    }
    for (const profile of result.accounts) {
      console.log(
        `${profile.id === result.currentAccountId ? "*" : " "} ${profile.id}  ${profile.label}  ${profile.connected ? (profile.authorized ? "订阅已授权" : "订阅未授权") : "需要登录"}`,
      );
    }
    console.log(`管理用量: ${result.usageUrl}`);
  },
});

const models = defineCommand({
  meta: { description: "获取当前 ChatGPT 账号可用模型" },
  args: { account, json },
  async run({ args }) {
    const result = await getChatGptAuthService().models(args.account);
    if (args.json) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    for (const model of result) console.log(`${model.slug}\t${model.displayName}`);
  },
});

const refresh = defineCommand({
  meta: { description: "在服务端允许的时间刷新 ChatGPT 授权" },
  args: { account },
  async run({ args }) {
    const result = await getChatGptAuthService().refresh(args.account);
    console.log(
      `${result.accountId}: ${result.refreshed ? "凭证已刷新" : "已使用其他进程刷新的凭证"}`,
    );
  },
});

const logout = defineCommand({
  meta: { description: "撤销会话并清除本地 ChatGPT token" },
  args: { account },
  async run({ args }) {
    const result = await getChatGptAuthService().logout(args.account);
    console.log(`${result.accountId}: 已退出登录。`);
    if (!result.revocationConfirmed) {
      console.error(
        "远端会话撤销尚未确认。请在 ChatGPT 设置中断开 Roll: https://chatgpt.com/settings/usage",
      );
    }
  },
});

export default defineCommand({
  meta: { description: "ChatGPT 订阅授权（用于聊天与定时任务的实验功能）" },
  subCommands: { login, status, models, refresh, logout },
});
