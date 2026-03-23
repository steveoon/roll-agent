# Agent Runtime Management V1 Plan

本文件定义 Roll 在 v1 阶段对 installable Agent 的分发、注册、启动、停止、健康检查、更新和移除行为，用于指导后续代码改动。

## 目标

- 支持把 `browser-use-agent` 作为 npm package 发布并通过 `roll agent install` 一键安装
- 让 `streamable-http` Agent 可以被 Roll 作为本地服务托管生命周期
- 保持现有 `stdio` Agent 的按需调用模式不变
- 将 Agent 的分发来源、MCP transport、生命周期 ownership 解耦

## 非目标

- 不做崩溃自动重启
- 不做日志轮转
- 不做动态端口分配
- 不做预编译 binary 分发
- 不支持所有 `source × transport × ownership` 任意组合

## v1 支持的合法组合

| transport | ownership | 典型场景 |
| --- | --- | --- |
| `stdio` | `on-demand` | 现有本地按需启动 Agent |
| `streamable-http` | `external-managed` | `roll agent add --remote ...` 注册的外部服务 |
| `streamable-http` | `core-managed` | 本地安装后由 Roll 启停的 HTTP Agent |

其余组合在 v1 直接视为不支持。

## 核心模型

Agent 模型拆成三层：

- `source`：Agent 是如何进入本地注册表的
- `transport`：Roll 与 Agent 通过什么 MCP 传输通信
- `runtime`：谁负责该 Agent 的生命周期

### Source

`source.type` 收敛为：

- `local-path`
- `git`
- `installed-package`
- `remote-manifest`

### Runtime

`runtime.ownership` 收敛为：

- `on-demand`
- `core-managed`
- `external-managed`

`runtime` 负责表达：

- ownership
- 启动命令
- endpoint 信息
- setup 信息

## Store Schema

`agents.json` 从“裸数组”升级为带版本的 envelope：

```json
{
  "schemaVersion": 2,
  "agents": []
}
```

### 迁移策略

- 读取时兼容旧格式数组
- 如果读到旧格式，先在内存中 normalize，再在首次写入时升级到 v2
- 旧记录迁移规则：
  - `stdio` 默认迁为 `runtime.ownership = "on-demand"`
  - `streamable-http` 默认迁为 `runtime.ownership = "external-managed"`
- 旧记录不因迁移而静默变成 `core-managed`

### 旧数据修正

历史上存在“本地路径注册的 HTTP Agent 被错误写成 `source.type = "remote"`”的问题。迁移时按以下规则修正：

- 如果 `source.type = "remote"` 但 `installPath` 存在本地目录且目录中包含 `SKILL.md`
  - 若该目录含 `.git`，迁成 `git`
  - 否则迁成 `local-path`
- 真正通过 `--remote` 注册的 manifest 目录保留为 `remote-manifest`

## Agent Package Manifest

installable Agent 的 runtime 信息放在 `package.json#rollAgent`，不放在独立文件中。

示例：

```json
{
  "name": "@roll-agent/browser-use-agent",
  "rollAgent": {
    "runtime": {
      "ownership": "core-managed",
      "transport": "streamable-http"
    },
    "start": {
      "command": "node",
      "args": ["dist/index.js"]
    },
    "endpoint": {
      "path": "/mcp",
      "port": 3100
    },
    "setup": {
      "playwright": {
        "browsers": ["chromium"]
      }
    }
  }
}
```

### Manifest 规则

- `SKILL.md` 继续只负责路由语义和能力说明
- `package.json#rollAgent` 负责 install/start/health/update/remove 所需的 runtime 信息
- runtime 信息解析优先级为：`package.json#rollAgent` > `SKILL.md metadata`
- 对没有 `rollAgent` manifest 的 Agent，继续从 `SKILL.md metadata` 读取 `roll-transport`、`roll-endpoint`、`roll-command`
- `SKILL.md metadata` 中的 `roll-transport`、`roll-endpoint`、`roll-command` 在 v1 保留为 legacy fallback，installable Agent 不应继续使用
- 解析优先级按 manifest 是否存在决定，而不是按 Agent 来源类型决定；`local-path` Agent 如果已经提供 `package.json#rollAgent`，也应优先使用 manifest
- 如果同一个 Agent 同时提供 `package.json#rollAgent` 和 legacy metadata，且 runtime 信息冲突，v1 应直接报错或至少给出强警告，不做静默覆盖
- 对 `core-managed + streamable-http`：
  - 必须提供 `start.command`
  - 必须提供固定 `endpoint.port`
  - 必须提供 `endpoint.path`

## 命令语义

### `roll agent install <package>`

v1 的 install 流程：

1. 安装 npm package 到 `~/.roll-agent/packages/...`
2. 解析 `SKILL.md`
3. 解析 `package.json#rollAgent`
4. 执行 setup
5. 写入注册表
6. 若 ownership 为 `core-managed` 且未传 `--no-start`，自动启动
7. 做一次 health check

建议新增参数：

- `--skip-browser-setup`
- `--no-start`

### `roll agent start <name>`

- `on-demand`
  - 返回成功提示：无需手动启动
- `core-managed`
  - 启动后台进程
  - 写 PID 文件
  - stdout/stderr 重定向到日志文件
  - 轮询 endpoint 的 MCP `tools/list`
- `external-managed`
  - 返回提示：由外部服务负责启动

### `roll agent stop <name>`

- `on-demand`
  - 返回成功提示：无常驻进程
- `core-managed`
  - 给 PID 发送 `SIGTERM`
  - 清理 PID 文件
- `external-managed`
  - 返回提示：由外部服务负责停止

### `roll agent health`

- `on-demand`
  - 显示为按需模式
- `core-managed`
  - 检查 PID 是否存活
  - 再做 MCP `tools/list`
- `external-managed`
  - 只做 MCP `tools/list`

### `roll update`

- `installed-package`
  - 重新安装 npm package
  - 重新解析 `SKILL.md`
  - 重新解析 `package.json#rollAgent`
  - 如未显式跳过，按 setup 配置重试 setup
  - 如果该 Agent 在更新前处于运行状态且 ownership 为 `core-managed`，则更新后自动重启
- `git`
  - `git pull`
  - 刷新本地 metadata
- `local-path`
  - 不拉代码
  - 重新解析本地 `SKILL.md` 和 `package.json#rollAgent`
  - 刷新注册表
- `remote-manifest`
  - 刷新本地 manifest 信息
  - 连通性检查

### `roll agent remove <name>`

- `installed-package`
  - 若为 `core-managed` 先 stop
  - 删除安装目录
  - 从注册表移除
- `local-path`
  - 若为 `core-managed` 先 stop
  - 仅 deregister，不删除源码目录
- `git`
  - 若为 `core-managed` 先 stop
  - 默认仅 deregister，不删除 clone 目录
- `remote-manifest`
  - 删除本地 manifest
  - 从注册表移除

## 进程管理

v1 仅实现最小后台服务托管：

- PID 文件目录：`~/.roll-agent/pids/`
- 日志目录：`~/.roll-agent/logs/`
- 不做进程自动拉起恢复
- 不做日志 rotate

### `core-managed + streamable-http` 启动细节

- spawn 时使用 Agent 安装目录作为 `cwd`
- 使用 manifest 中的固定端口
- 日志落到 `~/.roll-agent/logs/{agent}.log`
- 启动成功标准：
  - `listTools()` 成功
- 启动失败时输出：
  - endpoint
  - 日志文件路径

## Browser Setup UX

Playwright setup 是安装流程中最慢和最容易失败的部分，v1 采用以下策略：

- setup 前明确提示将下载浏览器运行时
- 支持 `--skip-browser-setup`
- setup 失败时不回滚整个 npm package 安装
- 失败后给出明确重试命令

说明：

- `@roll-agent/browser` 当前依赖的是 `playwright-core`
- 如果要让 Roll 能稳定执行浏览器安装，`browser-use-agent` 需要提供一个明确的 setup 路径
- v1 可以是：
  - `rollAgent.setup.playwright`
  - 或 package 内暴露显式 setup script

## 发布策略

v1 的最终分发形态：

- `@roll-agent/core`
- `@roll-agent/sdk`
- `@roll-agent/browser`
- `@roll-agent/browser-use-agent`

其中：

- 终端用户只需要安装 `@roll-agent/core`
- `@roll-agent/browser` 是给 Agent 包和生态复用的 library
- `browser-use-agent` 通过 `roll agent install @roll-agent/browser-use-agent` 安装

### 发布流水线注意事项

v1 选择保留 workspace 依赖，并把 release 流程切到 `pnpm publish`。

原因：

- `browser-use-agent` 需要继续在 monorepo 本地开发时使用 `workspace:*`
- `pnpm publish` 会在发布时正确处理 workspace 依赖
- 这样不会为了发布而反向污染本地开发依赖声明

## 代码改动顺序

### Phase 1. 数据模型与迁移

- 更新 `packages/core/src/types/agent.ts`
- 更新 `packages/core/src/registry/store.ts`
- 加入 v1 → v2 store migration

### Phase 2. 发现与注册

- 更新 `packages/core/src/registry/discovery.ts`
- 更新 `packages/core/src/registry/source.ts`
- 更新 `packages/core/src/cli/commands/agent-add.ts`
- 让 source 与 transport 解耦

### Phase 3. Runtime 管理

- 重构 `packages/core/src/registry/process-manager.ts`
- 让其支持 `core-managed + streamable-http`
- 加入 PID / log file 管理

### Phase 4. CLI 生命周期命令

- 更新 `packages/core/src/cli/commands/agent-install.ts`
- 更新 `packages/core/src/cli/commands/agent-start.ts`
- 更新 `packages/core/src/cli/commands/agent-stop.ts`
- 更新 `packages/core/src/cli/commands/agent-health.ts`
- 更新 `packages/core/src/cli/commands/update.ts`
- 更新 `packages/core/src/cli/commands/agent-remove.ts`

### Phase 5. Agent Packaging

- 发布 `@roll-agent/browser`
- 将 `agents/browser-use/package.json` 调整为可发布包
- 为 `browser-use-agent` 增加 `package.json#rollAgent`
- 校准发布脚本

## 测试范围

### Store / Migration

- 旧数组格式读取
- 写回后升级为 `schemaVersion: 2`
- 历史误判的本地 HTTP Agent source 修正

### Discovery

- 只带 `SKILL.md` 的旧 Agent 兼容读取
- 同时带 `SKILL.md + package.json#rollAgent` 的 installable Agent 读取
- 非法组合拒绝

### Runtime

- `stdio + on-demand`
- `streamable-http + external-managed`
- `streamable-http + core-managed`

### Commands

- `install`
- `start`
- `stop`
- `health`
- `update`
- `remove`

### Browser Setup

- setup 成功
- `--skip-browser-setup`
- setup 失败但包安装与注册保留

## 完成标准

满足以下条件即视为 v1 完成：

- 用户可通过 `npm install -g @roll-agent/core` 安装 Roll
- 用户可通过 `roll agent install @roll-agent/browser-use-agent` 一键安装 browser-use-agent
- 对 `browser-use-agent`：
  - `install` 可完成 setup、注册和启动
  - `start` 可启动本地 HTTP 服务
  - `stop` 可停止本地 HTTP 服务
  - `health` 可报告真实状态
  - `update` 可升级并在需要时重启
  - `remove` 可停止并卸载
- 现有 `stdio` Agent 的按需模式保持兼容
