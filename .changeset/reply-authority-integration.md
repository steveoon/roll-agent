---
"@roll-agent/smart-reply-agent": minor
"@roll-agent/browser-use-agent": minor
"@roll-agent/core": patch
---

feat(smart-reply): generate_reply 全切 Reply Authority Service 云端签发

smart-reply-agent 不再本地执行回复管线，改为向 Reply Authority Service 转发请求。
输入新增必填 target（platform/tenantId/conversationId/candidateId），
输出新增 signedEnvelope 和 envelopeExp。
环境变量：REPLY_AUTHORITY_URL + REPLY_AUTHORITY_BEARER_TOKEN。

feat(browser-use): zhipin_send_reply 实现本地 Ed25519 信封验签

输入从 message 改为 signedEnvelope，发送前执行完整验证链路：
Ed25519 签名校验 → iss/aud/platform 校验 → exp/iat 时间戳校验 →
jti 防重放 → conversationId/candidateId 目标绑定校验。
zhipin_read_messages 和 zhipin_get_candidate_info 输出补充 conversationId/candidateId。

fix(core): agent-start 未注入 agents.env 到 core-managed 进程

roll agent start 启动 core-managed agent 时未传递 agents.env 配置的环境变量，
改为通过 getAgentEnv() 查找并注入。

fix(core): config set 错误转换 SCREAMING_SNAKE_CASE 键名

camelToKebab 对全大写+下划线格式的环境变量名（如 REPLY_AUTHORITY_KEYS_URL）
逐字符插入连字符，现跳过此类键名。
