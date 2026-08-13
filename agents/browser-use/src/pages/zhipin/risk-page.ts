import { StructuredToolError, isStructuredToolError } from "@roll-agent/sdk";

export const ZHIPIN_ACCESS_RESTRICTED_CODE = "zhipin_access_restricted" as const;

export const ZHIPIN_RISK_PAGE_KINDS = [
  "ip_block",
  "uid_block",
  "verify",
  "security",
  "anti_spider_login",
] as const;
export type ZhipinRiskPageKind = (typeof ZHIPIN_RISK_PAGE_KINDS)[number];

const ZHIPIN_BLOCK_PATHS = [
  "/web/passport/zp/403.html",
  "/web/common/403.html",
  "/web/passport/cm/403.html",
] as const;

const ZHIPIN_VERIFY_PATHS = [
  "/web/passport/zp/verify.html",
  "/web/user/safe/verify-slider",
  "/web/passport/cm/verify.html",
] as const;

const ZHIPIN_SECURITY_PATHS = [
  "/web/passport/zp/security.html",
  "/web/common/security-check.html",
] as const;

const ZHIPIN_ANTI_SPIDER_LOGIN_PATHS = ["/web/user"] as const;
const ZHIPIN_ANTI_SPIDER_LOGIN_CODE = "38";

const ZHIPIN_BLOCK_CODE_KINDS: Readonly<Record<string, ZhipinRiskPageKind>> = {
  "31": "ip_block",
  "-1000031": "ip_block",
  "5002": "ip_block",
  "32": "uid_block",
  "5003": "uid_block",
  "5004": "uid_block",
};

const ZHIPIN_RISK_TITLE_KINDS = {
  访问受限: "ip_block",
  安全验证: "verify",
} as const satisfies Record<string, ZhipinRiskPageKind>;

export type ZhipinRiskPageInput = {
  readonly url: string;
  readonly title?: string;
};

export type ZhipinRiskPageHit = {
  readonly kind: ZhipinRiskPageKind;
  readonly url: string;
  readonly title: string;
};

const KIND_OPERATOR_HINT = {
  ip_block:
    "IP 级封禁：请等待页面标明的解封时间；刷新、换工具、换 browserInstance/profile 均无效。",
  uid_block: "账号级封禁：请等待账号解封；刷新、换工具、换 browserInstance/profile 均无效。",
  verify: "请在浏览器中手动完成验证并等待后再操作，不要立即重试。",
  security: "请在浏览器中手动完成安全检查并等待后再操作，不要立即重试。",
  anti_spider_login: "站点反爬拦截要求登录：请人工登录并等待后再操作，不要自动重试。",
} as const satisfies Record<ZhipinRiskPageKind, string>;

export function inspectZhipinRiskPage(input: ZhipinRiskPageInput): ZhipinRiskPageHit | null {
  const url = input.url.trim();
  const title = (input.title ?? "").trim();
  const pathname = readPathname(url);

  if (matchesPath(pathname, ZHIPIN_BLOCK_PATHS)) {
    return {
      kind: ZHIPIN_BLOCK_CODE_KINDS[readQueryCode(url) ?? ""] ?? "ip_block",
      url,
      title,
    };
  }
  if (matchesPath(pathname, ZHIPIN_VERIFY_PATHS)) {
    return { kind: "verify", url, title };
  }
  if (matchesPath(pathname, ZHIPIN_SECURITY_PATHS)) {
    return { kind: "security", url, title };
  }
  if (
    matchesPath(pathname, ZHIPIN_ANTI_SPIDER_LOGIN_PATHS) &&
    readQueryCode(url) === ZHIPIN_ANTI_SPIDER_LOGIN_CODE
  ) {
    return { kind: "anti_spider_login", url, title };
  }

  for (const needle of Object.keys(ZHIPIN_RISK_TITLE_KINDS) as Array<
    keyof typeof ZHIPIN_RISK_TITLE_KINDS
  >) {
    if (title.includes(needle)) {
      return { kind: ZHIPIN_RISK_TITLE_KINDS[needle], url, title };
    }
  }

  return null;
}

export function assertZhipinPageNotRestricted(input: ZhipinRiskPageInput): void {
  const hit = inspectZhipinRiskPage(input);
  if (hit !== null) {
    throw createZhipinAccessRestrictedError(hit);
  }
}

export function createZhipinAccessRestrictedError(hit: ZhipinRiskPageHit): StructuredToolError {
  return new StructuredToolError({
    code: ZHIPIN_ACCESS_RESTRICTED_CODE,
    message: `BOSS 风控页已出现（${hit.kind}）。${KIND_OPERATOR_HINT[hit.kind]}`,
    details: {
      kind: hit.kind,
      url: hit.url,
      title: hit.title,
    },
  });
}

export function rethrowStructuredToolError(error: unknown): void {
  if (isStructuredToolError(error)) {
    throw error;
  }
}

function matchesPath(pathname: string, paths: readonly string[]): boolean {
  return paths.some((path) => pathname === path || pathname.startsWith(`${path}/`));
}

function readPathname(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    const withoutHash = url.split("#")[0] ?? url;
    const withoutQuery = withoutHash.split("?")[0] ?? withoutHash;
    const schemeIndex = withoutQuery.indexOf("://");
    const afterScheme = schemeIndex >= 0 ? withoutQuery.slice(schemeIndex + 3) : withoutQuery;
    const slashIndex = afterScheme.indexOf("/");
    return slashIndex >= 0 ? afterScheme.slice(slashIndex) : afterScheme;
  }
}

function readQueryCode(url: string): string | undefined {
  try {
    return new URL(url).searchParams.get("code") ?? undefined;
  } catch {
    const query = url.split("?")[1]?.split("#")[0];
    if (query === undefined || query.length === 0) {
      return undefined;
    }
    for (const part of query.split("&")) {
      const separator = part.indexOf("=");
      const key = separator >= 0 ? part.slice(0, separator) : part;
      if (key !== "code") {
        continue;
      }
      const value = separator >= 0 ? part.slice(separator + 1) : "";
      try {
        return decodeURIComponent(value);
      } catch {
        return value;
      }
    }
    return undefined;
  }
}
