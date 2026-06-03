---
"@roll-agent/core": minor
---

增强 `roll agent install` / `roll update` 的网络韧性与跨平台（win-x64 / win-arm64 / macOS / Linux）兼容性，解决无 VPN、npm 官方源不稳定环境下的更新失败问题。

- 新增 `install` 配置段（`roll.config.yaml`）：`registry`（显式 opt-in 镜像源，默认仍走 npm 官方源，不做隐式自动 fallback）、`fetchRetries`、`preferOffline`（默认关闭，避免更新时复用过期 npm 元数据）、`networkTimeoutMs`。通过独立的韧性 partial loader 加载，即使全局配置处于待迁移状态，安装/更新链路也保持可用；若 `install` 段自身非法，则中止安装/更新，避免静默换源。
- 修复 `roll update` 在整体配置 YAML 不可读时无法 self-update 的回归：此时使用默认 `install` 配置继续更新；若配置文件可读但 `install` 段自身非法，仍中止更新并提示具体字段。
- `core-managed` Agent readiness 等待默认值保持不变，同时支持通过 `ROLL_AGENT_READY_STARTUP_TIMEOUT_MS` / `ROLL_AGENT_READY_PROBE_TIMEOUT_MS` / `ROLL_AGENT_READY_INTERVAL_MS` 覆盖，便于测试和故障诊断场景缩短等待。
- npm install / view 透传 `--registry`/`--fetch-retries`/`--prefer-offline`/`--no-audit`/`--no-fund`；安装命令在网络/超时类错误上做整体重试（次数随 `fetchRetries` 增长，上限 3 次，带退避）。
- 网络错误友好化：识别 `ETIMEDOUT`/`ECONNRESET`/`ENOTFOUND` 等错误码与超时被 kill 的进程，给出中文提示并引导配置 `install.registry` 镜像源；配置自定义 registry 时在日志高可见提示当前源。
- 修复 `execFile` 默认 1MB `maxBuffer` 隐患：弱网下 npm/Playwright 大量日志可能超限导致“安装其实成功却被误判失败”，统一放大缓冲上限。
- Windows 子进程封装改用 `process.env.ComSpec` 解析 shell（兼容 win-x64 / win-arm64 及定制 shell 路径），回退 `cmd.exe`。

不触碰发布供应链防护（`pnpm-workspace.yaml` 的 `minimumReleaseAge`/`blockExoticSubdeps`、release workflow、tarball 审计），镜像源切换仅作用于终端用户安装侧且为显式 opt-in。
