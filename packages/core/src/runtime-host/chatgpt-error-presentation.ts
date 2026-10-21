import { APICallError } from "@ai-sdk/provider";
import { ChatGptAuthError } from "../auth/chatgpt/errors.ts";
import { ChatGptResponseError, ChatGptStreamInterruptedError } from "../llm/chatgpt-recovery.ts";

const PRESENTATIONS = {
  quota: {
    message: "ChatGPT 可用额度不足，请查看账号额度并等待恢复，或使用 /model 选择其他可用模型。",
    invalidatesConnection: false,
  },
  authentication: {
    message: "ChatGPT 登录或授权已失效，请在另一个终端运行 roll auth chatgpt login 重新授权。",
    invalidatesConnection: true,
  },
  permission: {
    message:
      "当前 ChatGPT 账号没有所需权限，请检查订阅与授权，必要时运行 roll auth chatgpt login 重新授权。",
    invalidatesConnection: true,
  },
  model: {
    message: "当前账号不提供所选模型或能力，请使用 /model 选择可用模型。",
    invalidatesConnection: false,
  },
  effort: {
    message: "当前模型不支持所选推理强度，请使用 /effort 或调整压缩推理强度。",
    invalidatesConnection: false,
  },
  rateLimit: {
    message: "ChatGPT 请求受到限流或额度限制，请查看账号额度并稍后重试。",
    invalidatesConnection: false,
  },
  network: {
    message: "ChatGPT 网络中断或服务暂不可用，请检查网络后输入 /reconnect 重试连接。",
    invalidatesConnection: true,
  },
  refreshPending: {
    message: "ChatGPT 暂未允许刷新授权，请稍后重试；若持续发生，请检查账号状态。",
    invalidatesConnection: true,
  },
  authUnknown: {
    message:
      "ChatGPT 账号检查或授权响应异常，请检查账号状态；必要时运行 roll auth chatgpt login 重新授权。",
    invalidatesConnection: true,
  },
  unknown: {
    message: "ChatGPT 请求失败或响应异常，请检查模型配置；若持续发生，请联系支持。",
    invalidatesConnection: false,
  },
} as const;

type ErrorPresentation = (typeof PRESENTATIONS)[keyof typeof PRESENTATIONS];

const CODE_PRESENTATIONS: Readonly<Record<string, keyof typeof PRESENTATIONS>> = {
  insufficient_quota: "quota",
  subscription_sharing_usage_limit_exceeded: "quota",
  login_required: "authentication",
  token_expired: "authentication",
  invalid_grant: "authentication",
  invalid_refresh_token: "authentication",
  refresh_token_expired: "authentication",
  refresh_token_invalidated: "authentication",
  refresh_token_reused: "authentication",
  invalid_id_token: "authentication",
  invalid_token_response: "authentication",
  invalid_refresh_time: "authentication",
  account_not_found: "authentication",
  refresh_too_early: "refreshPending",
  subscription_sharing_invalid_user: "authentication",
  chatpass_v2_invalid_authorization_context: "authentication",
  scope_not_authorized: "permission",
  chatpass_v2_scope_not_authorized: "permission",
  subscription_sharing_user_not_eligible: "permission",
  subscription_disabled: "permission",
  model_not_found: "model",
  model_unavailable: "model",
  subscription_sharing_unsupported_capability: "model",
  subscription_sharing_route_not_supported: "model",
  unsupported_effort: "effort",
  rate_limit_exceeded: "rateLimit",
  network_error: "network",
  jwks_unavailable: "network",
};

/** Only structured response codes are evidence; never inspect raw messages or response bodies. */
function responseCode(value: unknown): string | undefined {
  const seen = new Set<unknown>();
  for (
    let depth = 0;
    depth < 8 && typeof value === "object" && value !== null && !seen.has(value);
    depth += 1
  ) {
    seen.add(value);
    if ("code" in value && typeof value.code === "string") return value.code;
    value = "error" in value ? value.error : "response" in value ? value.response : undefined;
  }
  return undefined;
}

/** Provider diagnostics stay internal; UI surfaces receive actionable, fixed text. */
export function chatGptErrorPresentation(error: unknown): ErrorPresentation {
  const seen = new Set<unknown>();
  for (let depth = 0; depth < 8 && error !== undefined && !seen.has(error); depth += 1) {
    seen.add(error);
    if (error instanceof ChatGptStreamInterruptedError) return PRESENTATIONS.network;
    const code =
      error instanceof ChatGptAuthError || error instanceof ChatGptResponseError
        ? error.code
        : APICallError.isInstance(error)
          ? responseCode(error.data)
          : undefined;
    const status =
      error instanceof ChatGptAuthError
        ? error.status
        : APICallError.isInstance(error)
          ? error.statusCode
          : undefined;
    // A known code beats HTTP status; unknown business codes must not become network failures.
    if (code !== undefined) {
      const kind = Object.hasOwn(CODE_PRESENTATIONS, code) ? CODE_PRESENTATIONS[code] : undefined;
      if (kind !== undefined) return PRESENTATIONS[kind];
      if (!(error instanceof ChatGptAuthError) && status !== 401 && status !== 403) {
        return PRESENTATIONS.unknown;
      }
    }
    if (status === 401) return PRESENTATIONS.authentication;
    if (status === 403) return PRESENTATIONS.permission;
    if (status === 429) return PRESENTATIONS.rateLimit;
    if (status !== undefined && [408, 502, 503, 504].includes(status)) return PRESENTATIONS.network;
    if (error instanceof ChatGptAuthError) return PRESENTATIONS.authUnknown;
    if (status !== undefined || error instanceof ChatGptResponseError) return PRESENTATIONS.unknown;
    error = error instanceof Error ? error.cause : undefined;
  }
  return PRESENTATIONS.unknown;
}
