import { StructuredToolError } from "@roll-agent/sdk";
import type { Platform } from "@roll-agent/browser";
import { getBrowserInstancePool } from "../runtime-holder.ts";

export function assertBrowserInstancePlatform(platform: Platform | undefined): void {
  if (platform === undefined) {
    return;
  }

  const bundle = getBrowserInstancePool().getBundle();
  if (bundle.platform === undefined || bundle.platform === platform) {
    return;
  }

  throw new StructuredToolError({
    code: "platform_mismatch",
    message:
      `Tool platform "${platform}" does not match browser instance "${bundle.id}" platform "${bundle.platform}".`,
    details: {
      browserInstance: bundle.id,
      expectedPlatform: bundle.platform,
      requestedPlatform: platform,
    },
  });
}

export function readPlatformFromToolInput(input: unknown): Platform | undefined {
  if (typeof input !== "object" || input === null || !("platform" in input)) {
    return undefined;
  }

  const platform = input.platform;
  return platform === "zhipin" || platform === "yupao" ? platform : undefined;
}
