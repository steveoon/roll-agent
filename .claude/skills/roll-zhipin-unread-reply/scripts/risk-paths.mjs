/**
 * Shared BOSS risk-page classifier for skill scripts.
 * Keep in sync with agents/browser-use/src/pages/zhipin/risk-page.ts
 */

const BLOCK_PATHS = [
  "/web/passport/zp/403.html",
  "/web/common/403.html",
  "/web/passport/cm/403.html",
];

const VERIFY_PATHS = [
  "/web/passport/zp/verify.html",
  "/web/user/safe/verify-slider",
  "/web/passport/cm/verify.html",
];

const SECURITY_PATHS = ["/web/passport/zp/security.html", "/web/common/security-check.html"];

const ANTI_SPIDER_LOGIN_PATHS = ["/web/user"];
const ANTI_SPIDER_LOGIN_CODE = "38";

const BLOCK_CODE_KINDS = {
  31: "ip_block",
  "-1000031": "ip_block",
  5002: "ip_block",
  32: "uid_block",
  5003: "uid_block",
  5004: "uid_block",
};

/**
 * @param {unknown} url
 * @param {unknown} title
 * @returns {{ kind: "ip_block"|"uid_block"|"verify"|"security"|"anti_spider_login", via: "url"|"title" } | null}
 */
export function classifyZhipinRiskPage(url, title) {
  const pageUrl = String(url ?? "").trim();
  const pageTitle = String(title ?? "").trim();
  const pathname = readPathname(pageUrl);

  if (matchesPath(pathname, BLOCK_PATHS)) {
    return { kind: BLOCK_CODE_KINDS[readQueryCode(pageUrl) ?? ""] ?? "ip_block", via: "url" };
  }
  if (matchesPath(pathname, VERIFY_PATHS)) {
    return { kind: "verify", via: "url" };
  }
  if (matchesPath(pathname, SECURITY_PATHS)) {
    return { kind: "security", via: "url" };
  }
  if (
    matchesPath(pathname, ANTI_SPIDER_LOGIN_PATHS) &&
    readQueryCode(pageUrl) === ANTI_SPIDER_LOGIN_CODE
  ) {
    return { kind: "anti_spider_login", via: "url" };
  }
  if (pageTitle.includes("访问受限")) {
    return { kind: "ip_block", via: "title" };
  }
  if (pageTitle.includes("安全验证")) {
    return { kind: "verify", via: "title" };
  }
  return null;
}

function matchesPath(pathname, paths) {
  return paths.some((path) => pathname === path || pathname.startsWith(`${path}/`));
}

function readPathname(url) {
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

function readQueryCode(url) {
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
