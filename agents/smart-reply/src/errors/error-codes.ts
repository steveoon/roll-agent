export const ErrorCategory = {
  CONFIG: "CONFIG",
  AUTH: "AUTH",
  NETWORK: "NETWORK",
  LLM: "LLM",
  VALIDATION: "VALIDATION",
  BUSINESS: "BUSINESS",
  SYSTEM: "SYSTEM",
} as const;

// eslint-disable-next-line @typescript-eslint/no-redeclare
export type ErrorCategory = (typeof ErrorCategory)[keyof typeof ErrorCategory];

export const ErrorCode = {
  LLM_UNAUTHORIZED: "LLM_UNAUTHORIZED",
  LLM_MODEL_NOT_FOUND: "LLM_MODEL_NOT_FOUND",
  LLM_RATE_LIMITED: "LLM_RATE_LIMITED",
  LLM_TIMEOUT: "LLM_TIMEOUT",
  LLM_GENERATION_FAILED: "LLM_GENERATION_FAILED",
  LLM_RESPONSE_PARSE_ERROR: "LLM_RESPONSE_PARSE_ERROR",
  CONFIG_NOT_FOUND: "CONFIG_NOT_FOUND",
  CONFIG_INVALID: "CONFIG_INVALID",
  CONFIG_MISSING_FIELD: "CONFIG_MISSING_FIELD",
  CONFIG_LOAD_FAILED: "CONFIG_LOAD_FAILED",
  NETWORK_TIMEOUT: "NETWORK_TIMEOUT",
  NETWORK_CONNECTION_FAILED: "NETWORK_CONNECTION_FAILED",
  NETWORK_HTTP_ERROR: "NETWORK_HTTP_ERROR",
  NETWORK_DNS_FAILED: "NETWORK_DNS_FAILED",
  AUTH_UNAUTHORIZED: "AUTH_UNAUTHORIZED",
  AUTH_FORBIDDEN: "AUTH_FORBIDDEN",
  AUTH_TOKEN_EXPIRED: "AUTH_TOKEN_EXPIRED",
  AUTH_TOKEN_INVALID: "AUTH_TOKEN_INVALID",
  VALIDATION_INVALID_INPUT: "VALIDATION_INVALID_INPUT",
  VALIDATION_MISSING_REQUIRED: "VALIDATION_MISSING_REQUIRED",
  VALIDATION_FORMAT_ERROR: "VALIDATION_FORMAT_ERROR",
  VALIDATION_SCHEMA_ERROR: "VALIDATION_SCHEMA_ERROR",
  BUSINESS_RULE_VIOLATION: "BUSINESS_RULE_VIOLATION",
  BUSINESS_RESOURCE_NOT_FOUND: "BUSINESS_RESOURCE_NOT_FOUND",
  BUSINESS_RESOURCE_EXISTS: "BUSINESS_RESOURCE_EXISTS",
  BUSINESS_OPERATION_NOT_ALLOWED: "BUSINESS_OPERATION_NOT_ALLOWED",
  SYSTEM_INTERNAL: "SYSTEM_INTERNAL",
  SYSTEM_DEPENDENCY_FAILED: "SYSTEM_DEPENDENCY_FAILED",
  SYSTEM_RESOURCE_UNAVAILABLE: "SYSTEM_RESOURCE_UNAVAILABLE",
  SYSTEM_UNKNOWN: "SYSTEM_UNKNOWN",
} as const;

// eslint-disable-next-line @typescript-eslint/no-redeclare
export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];

export const ERROR_CODE_TO_CATEGORY: Record<ErrorCode, ErrorCategory> = {
  [ErrorCode.LLM_UNAUTHORIZED]: ErrorCategory.LLM,
  [ErrorCode.LLM_MODEL_NOT_FOUND]: ErrorCategory.LLM,
  [ErrorCode.LLM_RATE_LIMITED]: ErrorCategory.LLM,
  [ErrorCode.LLM_TIMEOUT]: ErrorCategory.LLM,
  [ErrorCode.LLM_GENERATION_FAILED]: ErrorCategory.LLM,
  [ErrorCode.LLM_RESPONSE_PARSE_ERROR]: ErrorCategory.LLM,
  [ErrorCode.CONFIG_NOT_FOUND]: ErrorCategory.CONFIG,
  [ErrorCode.CONFIG_INVALID]: ErrorCategory.CONFIG,
  [ErrorCode.CONFIG_MISSING_FIELD]: ErrorCategory.CONFIG,
  [ErrorCode.CONFIG_LOAD_FAILED]: ErrorCategory.CONFIG,
  [ErrorCode.NETWORK_TIMEOUT]: ErrorCategory.NETWORK,
  [ErrorCode.NETWORK_CONNECTION_FAILED]: ErrorCategory.NETWORK,
  [ErrorCode.NETWORK_HTTP_ERROR]: ErrorCategory.NETWORK,
  [ErrorCode.NETWORK_DNS_FAILED]: ErrorCategory.NETWORK,
  [ErrorCode.AUTH_UNAUTHORIZED]: ErrorCategory.AUTH,
  [ErrorCode.AUTH_FORBIDDEN]: ErrorCategory.AUTH,
  [ErrorCode.AUTH_TOKEN_EXPIRED]: ErrorCategory.AUTH,
  [ErrorCode.AUTH_TOKEN_INVALID]: ErrorCategory.AUTH,
  [ErrorCode.VALIDATION_INVALID_INPUT]: ErrorCategory.VALIDATION,
  [ErrorCode.VALIDATION_MISSING_REQUIRED]: ErrorCategory.VALIDATION,
  [ErrorCode.VALIDATION_FORMAT_ERROR]: ErrorCategory.VALIDATION,
  [ErrorCode.VALIDATION_SCHEMA_ERROR]: ErrorCategory.VALIDATION,
  [ErrorCode.BUSINESS_RULE_VIOLATION]: ErrorCategory.BUSINESS,
  [ErrorCode.BUSINESS_RESOURCE_NOT_FOUND]: ErrorCategory.BUSINESS,
  [ErrorCode.BUSINESS_RESOURCE_EXISTS]: ErrorCategory.BUSINESS,
  [ErrorCode.BUSINESS_OPERATION_NOT_ALLOWED]: ErrorCategory.BUSINESS,
  [ErrorCode.SYSTEM_INTERNAL]: ErrorCategory.SYSTEM,
  [ErrorCode.SYSTEM_DEPENDENCY_FAILED]: ErrorCategory.SYSTEM,
  [ErrorCode.SYSTEM_RESOURCE_UNAVAILABLE]: ErrorCategory.SYSTEM,
  [ErrorCode.SYSTEM_UNKNOWN]: ErrorCategory.SYSTEM,
};

export const ERROR_USER_MESSAGES: Record<ErrorCode, string> = {
  [ErrorCode.LLM_UNAUTHORIZED]: "AI 服务认证失败，请检查配置",
  [ErrorCode.LLM_MODEL_NOT_FOUND]: "所选模型暂时不可用，请尝试其他模型",
  [ErrorCode.LLM_RATE_LIMITED]: "请求过于频繁，请稍后重试",
  [ErrorCode.LLM_TIMEOUT]: "AI 响应超时，请稍后重试",
  [ErrorCode.LLM_GENERATION_FAILED]: "内容生成失败，请稍后重试",
  [ErrorCode.LLM_RESPONSE_PARSE_ERROR]: "AI 响应格式异常，请重试",
  [ErrorCode.CONFIG_NOT_FOUND]: "配置数据未找到，请先进行初始化",
  [ErrorCode.CONFIG_INVALID]: "配置格式无效，请检查配置",
  [ErrorCode.CONFIG_MISSING_FIELD]: "配置缺少必需字段",
  [ErrorCode.CONFIG_LOAD_FAILED]: "配置加载失败，请重试",
  [ErrorCode.NETWORK_TIMEOUT]: "网络请求超时，请检查网络连接",
  [ErrorCode.NETWORK_CONNECTION_FAILED]: "网络连接失败，请检查网络",
  [ErrorCode.NETWORK_HTTP_ERROR]: "服务器返回错误，请稍后重试",
  [ErrorCode.NETWORK_DNS_FAILED]: "域名解析失败，请检查网络",
  [ErrorCode.AUTH_UNAUTHORIZED]: "请先登录",
  [ErrorCode.AUTH_FORBIDDEN]: "您没有权限执行此操作",
  [ErrorCode.AUTH_TOKEN_EXPIRED]: "登录已过期，请重新登录",
  [ErrorCode.AUTH_TOKEN_INVALID]: "认证信息无效，请重新登录",
  [ErrorCode.VALIDATION_INVALID_INPUT]: "输入参数无效",
  [ErrorCode.VALIDATION_MISSING_REQUIRED]: "缺少必需参数",
  [ErrorCode.VALIDATION_FORMAT_ERROR]: "数据格式错误",
  [ErrorCode.VALIDATION_SCHEMA_ERROR]: "数据验证失败",
  [ErrorCode.BUSINESS_RULE_VIOLATION]: "操作违反业务规则",
  [ErrorCode.BUSINESS_RESOURCE_NOT_FOUND]: "请求的资源不存在",
  [ErrorCode.BUSINESS_RESOURCE_EXISTS]: "资源已存在",
  [ErrorCode.BUSINESS_OPERATION_NOT_ALLOWED]: "当前操作不被允许",
  [ErrorCode.SYSTEM_INTERNAL]: "系统内部错误，请稍后重试",
  [ErrorCode.SYSTEM_DEPENDENCY_FAILED]: "依赖服务异常，请稍后重试",
  [ErrorCode.SYSTEM_RESOURCE_UNAVAILABLE]: "系统资源不可用，请稍后重试",
  [ErrorCode.SYSTEM_UNKNOWN]: "发生未知错误，请稍后重试",
};

export function getErrorCategory(code: ErrorCode): ErrorCategory {
  return ERROR_CODE_TO_CATEGORY[code];
}

export function getErrorUserMessage(code: ErrorCode): string {
  return ERROR_USER_MESSAGES[code];
}

export function isErrorInCategory(code: ErrorCode, category: ErrorCategory): boolean {
  return ERROR_CODE_TO_CATEGORY[code] === category;
}
