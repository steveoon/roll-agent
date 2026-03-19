import type { Platform } from "@roll-agent/browser";
import { PLATFORMS } from "@roll-agent/browser";

export const PLATFORM_HOME = {
  zhipin: "https://www.zhipin.com",
  yupao: "https://www.yupao.com",
} as const satisfies Readonly<Record<Platform, string>>;

function getPlatformHost(platform: Platform): string {
  return new URL(PLATFORM_HOME[platform]).host;
}

export function matchesPlatformHost(url: string, platform: Platform): boolean {
  try {
    return new URL(url).host.includes(getPlatformHost(platform));
  } catch {
    return false;
  }
}

export function detectPlatformFromUrl(url: string): Platform | undefined {
  return PLATFORMS.find((platform) => matchesPlatformHost(url, platform));
}
