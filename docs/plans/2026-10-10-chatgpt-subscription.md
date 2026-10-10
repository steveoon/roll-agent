# Roll ChatGPT 订阅最小接入验证

> 2026-10-10 Review 后范围更新（用户明确要求）：支持 scheduler 使用订阅模型，复用同一认证服务、流式适配器、Sampling 与压缩，保留无人值守审批／取消／时限。以下为原始开工方案；最新支持边界及使用方法见 `docs/how-to-use-chatgpt-subscription.md`。修复推理 off 映射、ask 误拦截、订阅目录启动阻塞，并在默认配置保存前提示共用字段的影响。

Status: approved implementation plan, 2026-10-10.

## Goal and architecture

Add experimental ChatGPT subscription access directly to `roll chat`, with CLI and
React configuration UI login. Use a Core-owned authentication service and an AI
SDK Responses adapter; retain ConversationEngine, ThreadStore, policy approvals,
MCP Tool Bridge, chat Sampling and compaction. Do not introduce Codex app-server.
Reject subscription selection in ask, Runtime service, scheduler and Companion.

## Entry points and configuration

- `roll auth chatgpt login|status|models|refresh|logout`, optional `--account`;
  status and models support `--json`.
- `roll chat --provider chatgpt --model <slug> --account <registration>` covers
  interactive, one-shot and session resume. Account precedence: flag, config,
  current authentication profile. Missing model: interactive selection or an
  actionable error for noninteractive calls.
- Add optional `runtime.chatgptAccountId`. Save subscription selection through
  `runtime.provider` / `runtime.model`, without an API key provider entry or a
  config migration.
- UI account panel: login, account selection, connection and grant status,
  dynamic models, refresh, logout, usage management link. Model/account changes
  use existing draft preview/save and apply to the next chat.
- Independent UI auth controller reuses session, Origin and CSRF protections;
  return only redacted state and progress, never OAuth credentials or hint URLs.

## Authentication

Follow official dynamic registration with persistent host identity, PKCE, state,
nonce, exact 127.0.0.1 callback, persist issued client ID before token exchange,
and verify ID token signature/JWKS, issuer, audience, expiry and nonce. Use exact
`jose@6.2.2` direct dependency, already in the lockfile. Derive public and stored
types from Zod schemas. CLI and UI share the same service; browser cancellation,
denial or timeout must preserve the active profile.

Store separate registration records under `~/.roll-agent/auth/chatgpt/`, directory
0700 and files 0600 on POSIX, with atomic writes. Do not merge by email. Obtain a
valid token for each inference request. Refresh under a cross-process profile
lock, re-read after acquiring it, rotate the whole credential record atomically,
and respect `earliest_refresh_at`. Temporary errors retain credentials; terminal
refresh failures require reauthorization. Logout attempts discovered revocation,
clears local tokens, retains registration/host mapping and reports unconfirmed
remote revocation.

## Responses and Roll integration

Add an async ChatGPT resolver while preserving existing API-key resolver signatures.
Fetch the selected account's `/v1/models`; show `display_name`, call with `slug`,
refetch on account changes and keep subscription models out of the static catalog.
Reuse `@ai-sdk/openai` serialization/parsing and `wrapLanguageModel`: store false,
developer messages, full local history replay, namespaced local function tools,
unaltered Roll tool names/schemas/approvals. Native `doStream`; `doGenerate` must
aggregate streaming text, reasoning, tool calls, usage and metadata, including
structured compaction and Sampling. Omit forbidden subscription parameters;
warn for unsupported maxOutputTokens without claiming a hard server cap. Retain
timeouts, abort and compaction validation. Errors and incomplete streams fail;
no implicit API billing fallback.

## Validation

Automated: OAuth verification/cancel, account isolation, model catalogs, credential
permissions/atomic writes, concurrent refresh/rotation/revocation, wire parameters,
tool namespaces, stream aggregation/structured output, abort/incomplete streams.
Regression: API-key providers, model switching, Sampling and CLI lazy loading.

Live acceptance uses this macOS host and a human-authorized ChatGPT subscription,
isolated config/temp workspace and random synthetic fixture only:

1. CLI and UI share a valid registration, grant state, no leaked tokens.
2. Real model list and selected slug used in inference.
3. Three chat turns retain random information, then restart/resume succeeds.
4. Actual Roll local tool reads the synthetic file, with execution record.
5. After earliest_refresh_at, real rotated credentials persist and the existing
   model continues working. Do not fake eligibility/expiry or mark all five done
   before a real refresh. Also exercise `/compact` once.

Before editing: save this plan, refresh GitNexus (previous index 4 commits behind),
repeat impact checks and disclose HIGH risk on shared model resolution. After:
focused tests, Core/Runtime typecheck, lint, UI build, Core published CLI checks,
graph change analysis, Core patch changeset. Report automated and live evidence
separately. Keep changes in an isolated worktree and do not publish.

## Official references

- https://developers.openai.com/siwc/token-sharing-open-source/sign-in
- https://developers.openai.com/siwc/token-sharing-open-source/profiles-and-sessions
- https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference
- https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations
- https://developers.openai.com/siwc/token-sharing-open-source/token-reference
- https://developers.openai.com/siwc/token-sharing-open-source/errors-and-recovery
