---
"@roll-agent/smart-reply-agent": patch
---

docs(smart-reply): clarify preferredBrand passthrough rules and diagnostics contract

- SKILL.md 补充招聘场景调用约束：`preferredBrand` 仅在 `communicationPosition` 含连字符类分隔符时透传第一段，禁止用通用岗位名或候选人公司名填充
- 明确 `diagnostics.brandResolutionSource="none"`、`resolvedBrand=""`、`ageGate.status="unknown"` 均为合法服务端结果，不是 tool 调用失败
- 工作流步骤补充"调用前补齐页面信号"阶段，序号从 4 步更新为 6 步
- 新增 reply-authority-client 测试：验证 preferredBrand 信号原样透传、通用岗位名不伪造品牌
