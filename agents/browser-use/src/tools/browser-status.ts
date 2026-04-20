import { defineTool } from "@roll-agent/sdk";
import { z } from "zod";
import { BrowserStatusSchema } from "@roll-agent/browser";
import type { BrowserSessionInfo } from "@roll-agent/browser";
import {
  BROWSER_USE_DECLARED_ENV_KEYS,
  collectEffectiveEnvSources,
  EffectiveEnvSourcesSchema,
} from "../diagnostics/effective-env.ts";
import {
  getRuntime,
  getContextManager,
  getSessionStore,
  getReplyAuthorityKeysLoaded,
} from "../runtime-holder.ts";

const BrowserUseStatusSchema = BrowserStatusSchema.extend({
  replyAuthorityKeysLoaded: z.boolean(),
  effectiveEnvSources: EffectiveEnvSourcesSchema,
});

export const browserStatus = defineTool({
  name: "browser_status",
  description: "查询浏览器运行状态和活跃 session 信息",
  input: z.object({}),
  output: BrowserUseStatusSchema,
  execute: async (_input, ctx) => {
    ctx.logger.info("Querying browser status");

    const runtime = getRuntime();
    const ctxManager = getContextManager();
    const store = getSessionStore();
    const running = runtime.isRunning();
    const { headless, mode } = runtime.getConfig();

    const platforms = ctxManager.getActivePlatforms();
    const activeSessions: BrowserSessionInfo[] = [];

    for (const platform of platforms) {
      const pagesOpen = ctxManager.getPageCount(platform);
      const currentUrl = ctxManager.getCurrentUrl(platform);

      let hasLoginState: BrowserSessionInfo["hasLoginState"] = null;
      let loginStateSource: BrowserSessionInfo["loginStateSource"] = "unknown";

      if (runtime.shouldRestoreSessionSnapshot()) {
        const [cookies, localStorage] = await Promise.all([
          store.loadCookies(platform),
          store.loadLocalStorage(platform),
        ]);
        hasLoginState =
          (cookies !== undefined && cookies.length > 0) ||
          (localStorage !== undefined && Object.keys(localStorage).length > 0);
        loginStateSource = hasLoginState ? "snapshot" : "none";
      } else if (runtime.usesPersistentProfile()) {
        hasLoginState = null;
        loginStateSource = "profile";
      }

      activeSessions.push({
        platform,
        pagesOpen,
        currentUrl,
        hasLoginState,
        loginStateSource,
      });
    }

    return {
      running,
      headless,
      mode,
      activeSessions,
      replyAuthorityKeysLoaded: getReplyAuthorityKeysLoaded(),
      effectiveEnvSources: collectEffectiveEnvSources(BROWSER_USE_DECLARED_ENV_KEYS),
    };
  },
});
