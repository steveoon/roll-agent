# OpenClaw `roll-core` SKILL 模板

这个模板用于把 `roll` 作为一个可编排 CLI skill 接入 OpenClaw。

默认调用策略：

- 已知 `agent + tool` 时优先 `roll run --json`
- 只知道自然语言意图时使用 `roll ask --json`
- 不要默认使用 `roll chat`，它当前仍是 experimental 骨架

## 推荐模板

```markdown
---
name: roll-core
description: Use roll to invoke registered MCP agents through a stable CLI surface.
---

## When to use

- Use `roll run --json <agent> <tool> ...` when the target agent and tool are known.
- Use `roll ask --json "<message>"` only when you know the intent but do not know which agent/tool to call.
- Do not use `roll chat` by default; it is experimental and currently returns `unavailable`.

## Command Strategy

1. Prefer deterministic execution with `roll run --json`.
2. If the user request is underspecified, use `roll ask --json`.
3. If `roll ask --json` returns `needs_input`, gather the missing structured fields and switch to `roll run --json --input-json`.
4. Treat `roll ask` as single-shot. Do not expect multi-step planning, session memory, or background orchestration.

## Output Handling

- Parse JSON from stdout.
- Treat non-zero exit codes as failures or gated states.
- For `roll ask --json`, handle these statuses:
  - `success`
  - `needs_input`
  - `needs_confirmation`
  - `failed`

## Examples

Known agent + tool:

```bash
roll run smart-reply-agent sync_brand_data --input-json '{"cityName":"上海市","brandAlias":"肯德基"}' --json
```

Known intent, unknown tool:

```bash
roll ask "帮我查看有哪些未读消息" --json
```
```
