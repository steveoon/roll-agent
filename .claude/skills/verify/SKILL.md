---
name: verify
description: 端到端验证 roll CLI 变更的配方：隔离 HOME + expect PTY 驱动交互式 clack/Ink 界面，观察真实 CLI 行为而非跑测试。适用于验证 roll setup / roll chat / roll agent install / roll config 等命令的真实行为。
---

# roll CLI 端到端验证配方

## 启动 CLI（开发模式，零构建）

```bash
node --experimental-strip-types /path/to/repo/packages/core/src/cli/index.ts <command>
```

- `roll chat` 需要额外加 `--experimental-sqlite`（thread-store 用 `node:sqlite`，Node 22.x 需 flag）。
  发布产物的 `packages/core/bin/roll.js` 有 re-exec 自动补 flag，直接跑 `src/cli/index.ts` 或 `dist/cli/index.js` 时**不会**经过该包装，必须手动带 flag。
- 加 `--disable-warning=ExperimentalWarning` 减噪。

## 环境隔离（必做）

- `HOME=$(mktemp -d)` 隔离 `~/.roll-agent`（registry/缓存/agents）与 `~/roll.config.yaml`。
- **cwd 必须在 repo 外**（如 `$HOME/work`），否则配置发现链会命中 repo 根的 `roll.config.yaml`。
- 宿主 shell 可能带着 `REPLY_AUTHORITY_*` / `RECRUITMENT_EVENTS_*` 等真实 env——env 检测（`inspectAgentEnvRequirements`）认 `process.env`，要驱动「缺 env」分支必须 `env -u VAR1 -u VAR2 ...` 显式清除。

## expect 驱动交互式界面（clack 向导 / Ink TUI）

```tcl
set stty_init "rows 40 columns 120"   ;# 关键！默认 PTY 尺寸会让 clack 逐字符换行渲染，匹配全废
log_file -noappend $logfile           ;# 完整捕获，事后用 perl 去 ANSI 分析
spawn env -u REPLY_AUTHORITY_URL HOME=$vhome node --experimental-strip-types $cli setup
expect { "provider" {} timeout { puts "TIMEOUT"; exit 1 } }
sleep 1                                ;# 每次 send 前留 1s，clack 渲染完成前输入会被吞
send "\r"
```

- 匹配点选 **ASCII 片段**（"provider"、"API key"、"npmmirror"）；中文匹配不稳定。
- clack confirm：`y`/`n` 单键直接确认；select：`\033\[B` 下移 + `\r`；multiselect：空格 toggle + 方向键 + `\r`（全新 HOME 下官方 agent 全部默认勾选，顺序 = catalog 顺序：browser-use, smart-reply, reply-policy-tuner, octopus）。
- 事后分析：`perl -pe 's/\e\[[0-9;?]*[a-zA-Z]//g' log | grep -v '^\s*$'`。

## 值得驱动的流程

- `roll config setup llm`：假 key `sk-fake-verify-key`，观察成功消息与 `~/roll.config.yaml` 写入。
- `roll agent install browser-use --skip-browser-setup`：唯一 core-managed 官方包，走 npm 真装（配 npmmirror 快很多：`roll config set install.registry https://registry.npmmirror.com`，注意 `config set` 需已有配置文件）。
- `roll setup` / `roll chat`（onboarding）：装 smart-reply 最轻；npm 安装步骤给 300s timeout。
- catalog 缓存：`roll agent list --available` 触发发现，检查 `$HOME/.roll-agent/catalog-cache.json`。

## 坑

- expect 默认 timeout 10s，npm 安装/doctor 步骤要单独调大。
- Ink TUI 的提示符是 `›`（UTF-8）不是 ASCII `>`，匹配 banner 文本更稳（如 "Roll Agent v"）。
- 假 API key 能进 TUI 但无法对话；退出发 `\x03`。
