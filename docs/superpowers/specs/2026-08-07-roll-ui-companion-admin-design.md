# roll ui — Companion 管理板块设计

日期:2026-08-07。状态:已与用户对齐(落点 = 现有 `roll ui` 本地 Web 配置台;P0 全量含 enroll)。

## 目标

不会使用 CLI 的用户,通过已有的 `roll ui` 本地配置台完成 Companion Host 的状态审查与
全部管理操作(enroll/unenroll/enable/disable/workspace/service install|uninstall/
start/stop/restart/status/doctor/logs)。

## 现状基线(已核实)

- `roll ui`(packages/core/src/cli/commands/ui.ts)已存在:127.0.0.1 监听、随机
  basePath(`/__roll_ui/<routeToken>`)、URL fragment 一次性 bootstrap token →
  `POST /api/bootstrap` 兑换服务端 session cookie(常量时间比较、兑换即失效)、变更
  POST 叠 CSRF header、严格 CSP、前台进程 SIGINT/SIGTERM 优雅退出。
- 服务端:packages/core/src/ui/server.ts(`StartRollUiServerOptions { controller,
  staticAssets, signal?, onError?, bodyLimitBytes? }`,`RollUiHttpError(statusCode,
  code, message)`);契约层 contracts.ts(`RollUiController` 面向配置台)。
- 前端:packages/core/ui/(React + Tailwind,vite 构建 → dist/ui-assets;
  `RollUiApi` 类 + `Navigation` + components/lib 分层;测试与 src 同目录,
  `pnpm --filter @roll-agent/core test` 覆盖 `ui/**/*.test.ts`)。
- Companion 编排层:packages/core/src/companion-host/application.ts 的
  `CompanionApplication`,方法面与命令树一一对应,`getStatus()/doctor()` 返回
  schema 化结构(`CompanionHostStatus`/`CompanionDoctorResult`),
  `followLogs(onText, signal)` 天然适配 SSE。
- 平台约束:`createDefaultCompanionApplication()` 构造时即建平台凭据库,
  linux 上抛错(credentials.ts:180)——装配处必须平台守卫。

## 与远程接入方案的边界关系(不可违反)

- Companion daemon 继续不监听任何 TCP;监听 TCP 的只是用户显式启动的短命前台
  `roll ui` 进程(现状已如此)。
- 配对码不进 argv/日志/配置:浏览器密码框 → POST body → 进程内存 →
  `application.enroll()`;server/controller 任何日志路径不得输出请求体。
- workspace 仍由本机 `CompanionApplication` canonicalize 校验;该管理面永不经
  Relay 暴露(远程 requestPolicy allowlist 不含管理方法)。

## 设计

### 契约层(src/ui/contracts.ts)

新增独立接口(不动现有 `RollUiController`):

```ts
export interface RollUiCompanionController {
  getStatus(): Awaitable<unknown>;            // CompanionHostStatus
  getDoctor(): Awaitable<unknown>;            // CompanionDoctorResult
  readLogs(): Awaitable<unknown>;             // { text: string }
  followLogs(onText: (text: string) => void, signal: AbortSignal): Promise<void>;
  enroll(request: { pairingCode: string; workspace: string }): Awaitable<unknown>;
  unenroll(): Awaitable<unknown>;
  enable(): Awaitable<unknown>;
  disable(): Awaitable<unknown>;
  setWorkspace(request: { workspace: string }): Awaitable<unknown>;
  installService(): Awaitable<unknown>;
  uninstallService(): Awaitable<unknown>;
  start(): Awaitable<unknown>;
  stop(): Awaitable<unknown>;
  restart(): Awaitable<unknown>;
}
```

### Controller(src/ui/companion-controller.ts,新增)

`createRollUiCompanionController({ application })` 包装 `CompanionApplication`:

- 变更操作互斥:同一时刻仅允许一个变更在途,并发时抛可识别的 busy 错误
  (server 映射 409);读操作(status/doctor/logs)不受互斥限制。
- 变更请求体用 zod schema 校验(pairingCode 非空、workspace 非空字符串),
  遵循 schema 单一数据源。
- 错误原样向上抛(message 即用户可读文案),不额外分类。

### 服务端路由(src/ui/server.ts)

`StartRollUiServerOptions` 增加可选 `companionController?: RollUiCompanionController`;
未注入时 `/api/companion/*` 返回 404(code `companion_unavailable`)。

- `GET  /api/companion/status | /doctor | /logs` — 要求 session。
- `GET  /api/companion/logs/stream` — SSE(`text/event-stream`);要求 session
  (EventSource 同源自动携带 cookie);请求关闭即 abort `followLogs`;server
  close 时终止所有在途流。
- `POST /api/companion/enroll | /unenroll | /enable | /disable | /workspace |
  /service/install | /service/uninstall | /start | /stop | /restart`
  — 要求 session + CSRF;busy → 409。
- stop/restart 最长约 60s(既有停机预算),不为其设置更短的服务器超时。

### CLI 装配(src/cli/commands/ui.ts)

darwin/win32 上 `createDefaultCompanionApplication()` → controller 注入;其他平台
不注入(前端据 404 隐藏板块或显示"当前平台不支持")。构造失败不阻断配置台启动
(警告走 stderr,板块降级为不可用)。

### 前端(packages/core/ui/)

- `RollUiApi` 增加 companion 方法(含 SSE 的 EventSource 封装);`types.ts` 增加
  status/doctor DTO 类型(手写 DTO,与服务端 schema 字段一致)。
- `Navigation` 增加「Companion」板块;新组件 `components/Companion*.tsx`:
  - 状态卡:2s 轮询 status;展示 phase/enabled/enrolled/runtimeOnline/cwd/
    deviceId/lastError。
  - 未 enroll 时首要视图为 enroll 表单:配对码 `input[type=password]` +
    workspace 绝对路径文本框(浏览器拿不到目录选择器绝对路径,已知取舍;
    服务端校验错误回显)。
  - 操作区:start/stop/restart/enable/disable/service install/uninstall/unenroll;
    unenroll 与 service uninstall 二次确认;任一变更在途时全部按钮禁用并显示
    进行中态(stop/restart 明示可能长达一分钟);完成后立即刷新 status。
  - doctor 面板:按钮触发,渲染结构化检查项。
  - 日志面板:初始 `GET /logs`,SSE 追加;暂停/清屏。
- 界面中文,复用现有 Tailwind 风格与 Toast 模式。

## 测试

- `src/ui/companion-controller.test.ts`:fake CompanionApplication;互斥(busy)、
  zod 校验拒绝、方法转发正确。
- `src/ui/server.test.ts` 扩展:未注入 controller 404;无 session 401;POST 无
  CSRF 拒绝;各路由转发;busy 409;SSE 推流与连接中止清理;配对码不出现在
  onError/日志输出。
- 前端:关键纯逻辑(状态推导、操作可用性)按现有 `ui/**/*.test.ts` 模式测试。
- 端到端冒烟:构建后 `node packages/core/dist/cli/index.js ui --no-open` 拿 URL,
  完成 bootstrap 兑换,GET `/api/companion/status`(隔离 HOME),SIGTERM 退出。
- 全链:`pnpm --filter @roll-agent/core typecheck && pnpm lint &&
  pnpm --filter @roll-agent/core test && pnpm --filter @roll-agent/core build`。

## 明确不做(P0)

- 不改 Companion daemon/控制协议;不改 Electron MVP(未来可 loadURL 嵌入);
- 不做 HTTPS、常驻/托盘、i18n 框架、`roll ui` 新 CLI 参数;
- ui-server/controller 不进 core 公开 exports(内部模块);
- 不给 companion CLI 命令补 `--json`(controller 直调 application,无此需求)。
