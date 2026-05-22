import { defineTool } from "@roll-agent/sdk";
import { z } from "zod";
import { BrowserSecurityConfigSchema, BrowserStatusSchema } from "@roll-agent/browser";
import type { BrowserSessionInfo } from "@roll-agent/browser";
import {
  BROWSER_USE_DECLARED_ENV_KEYS,
  collectEffectiveEnvSources,
  EffectiveEnvSourcesSchema,
} from "../diagnostics/effective-env.ts";
import { getReplyAuthorityKeysLoaded, getBrowserInstancePool } from "../runtime-holder.ts";
import { isVisualCursorEnabled } from "../visual-cursor.ts";
import { isVisualActivityEnabled } from "../visual-activity.ts";
import {
  BrowserUsePolicyConfigSchema,
  BrowserUsePolicyWarningSchema,
  collectBrowserUsePolicyWarnings,
  getBrowserUsePolicy,
} from "../browser-use-policy.ts";

const BrowserUseStatusSchema = BrowserStatusSchema.extend({
  replyAuthorityKeysLoaded: z.boolean(),
  visualCursorEnabled: z.boolean(),
  visualActivityEnabled: z.boolean(),
  security: BrowserSecurityConfigSchema,
  toolPolicy: BrowserUsePolicyConfigSchema,
  policyWarnings: z.array(BrowserUsePolicyWarningSchema),
  effectiveEnvSources: EffectiveEnvSourcesSchema,
});

export const browserStatus = defineTool({
  name: "browser_status",
  description: "查询浏览器运行状态和活跃 session 信息",
  input: z.object({}),
  output: BrowserUseStatusSchema,
  execute: async (_input, ctx) => {
    ctx.logger.info("Querying browser status");

    const instancePool = getBrowserInstancePool();
    const bundles = instancePool.listBundles();
    const primaryInstanceId = instancePool.resolvePrimaryInstanceId();
    const primaryBundle =
      bundles.find((bundle) => bundle.id === primaryInstanceId) ?? bundles[0];
    if (primaryBundle === undefined) {
      throw new Error("BrowserInstancePool has no runtime bundles.");
    }
    const running = bundles.some((bundle) => bundle.runtime.isRunning());
    const { headless, mode, security } = primaryBundle.runtime.getConfig();
    const toolPolicy = getBrowserUsePolicy();

    const activeSessions: BrowserSessionInfo[] = [];

    for (const bundle of bundles) {
      const runtime = bundle.runtime;
      const ctxManager = bundle.contextManager;
      const store = bundle.sessionStore;
      const platforms = ctxManager.getActivePlatforms();

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
          browserInstance: bundle.id,
          platform,
          pagesOpen,
          currentUrl,
          hasLoginState,
          loginStateSource,
        });
      }
    }

    return {
      running,
      headless,
      mode,
      activeSessions,
      defaultInstanceId: instancePool.getDefaultInstanceId(),
      primaryInstanceId,
      instances: await instancePool.getInstanceStatuses(),
      replyAuthorityKeysLoaded: getReplyAuthorityKeysLoaded(),
      visualCursorEnabled: isVisualCursorEnabled(),
      visualActivityEnabled: isVisualActivityEnabled(),
      security,
      toolPolicy,
      policyWarnings: collectBrowserUsePolicyWarnings({ browserSecurity: security, toolPolicy }),
      effectiveEnvSources: collectEffectiveEnvSources(BROWSER_USE_DECLARED_ENV_KEYS),
    };
  },
});
