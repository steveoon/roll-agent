# Herdr 状态集成：Codex 独立复核

日期：2026-11-13。审查人：Codex t3。实现者：Roll t1。

结论：主要接线符合方案，没有发现 High/Critical 级代码缺陷；发现两个已执行复现的 Medium 问题。尚不能将本交付标为完整验收通过。建议先修复取消原因映射及新增测试的环境依赖，再补提醒转换验收。

## 先前审查要求

| 要求                           | 状态   | 当前证据                                              |
| ------------------------------ | ------ | ----------------------------------------------------- |
| 回合结果与 UI phase 分开       | 已落实 | 完成依赖迭代器关闭，late persistence error 测试通过   |
| 绕过缩放时的视觉输出过滤       | 已落实 | 独立 fd 写入；Ink/basic 两个真实 PTY 用例本次重跑通过 |
| Ink 和基础 REPL 都覆盖         | 已落实 | 两入口共用 reporter；独立重跑相关测试                 |
| owner 统一清理、旧句柄不能复活 | 已落实 | CLI finally dispose，代次失效与切会话测试通过         |
| 区分正常取消与失败             | 有遗漏 | timeout 也被归为 idle，见 M1                          |
| 已查看/未查看完成提醒          | 未验证 | t1 明确未做，本次不以保存的静态截图代替状态转换验收   |

## 范围与基线

- 工作区审查，`dev` / HEAD `3ee2ea3da2a87a8738e82a7c559267c4439b2738`，相对 HEAD 的全部实现交付：7 个 tracked 修改文件、10 个 untracked 新文件，共 17 个。暂存区为空。
- 包括生产代码、全部新增测试/fixture、文档与 Core minor changeset；没有忽略 untracked。
- 文件快照 SHA-256 清单：`/tmp/codex-herdr-reviewed-manifest.json`。
- 本次没有修改实现、测试、配置、依赖或原验收报告；仅新增本复核报告。没有 commit/push/发布。
- Node 24.22.3；根 packageManager 要求 pnpm 11.24.0。本次 pnpm 启动在沙箱网络中遇到签名查询失败，未改包管理器保护，改用仓库已安装的 tsc/eslint 直接检查。

## 问题与设计

交互式 Roll CLI 原先没有根状态报文，Herdr 无法把它纳入 Agents 列表。新模块以固定 app=roll 编码 OSC 7501，CLI 是唯一所有者，两个前端从真实等待和回合边界驱动它。运行时与协议包未引入 Herdr 依赖，终端控制写入与渲染/日志分离。

## 评分

以下为 benchmark-code-review 的本地六轴量表，不是官方工程认证。

| 维度                         | 分数 | 依据                                                                      |
| ---------------------------- | ---- | ------------------------------------------------------------------------- |
| Correctness                  | 8/10 | 主要边界成立，但 timeout 和主动取消混同                                   |
| Design / Architecture        | 9/10 | CLI 单一所有者、注入依赖、无 Runtime 反向接线                             |
| Testing                      | 7/10 | 真实 PTY 与负例较充分，但新增入口测试依赖外部 CI 环境；缺少非用户取消用例 |
| Operability                  | 8/10 | best-effort 写入、幂等清理可用；客户端提醒链仍未完成验收                  |
| Docs / Contract              | 8/10 | 说明与 changeset 范围清楚；取消原因的状态语义需补明确                     |
| Complexity / Maintainability | 9/10 | 模块范围小、无新依赖，代次防护有实际消费者                                |

**Overall: provisional B+ / 8.2。** 原始均分 49/6=8.1667，四舍五入到 8.2；无 High/Critical 缺陷封顶。

**Merge disposition: Not assessed（暂不作完整签收）。** 两个 Medium 需修复或明确接受，且提醒转换的适用验收未完成。GitNexus 的 critical 是影响范围，不是缺陷评级。

## Findings

### M1 — 超时取消被上报为普通 idle

- 位置：`packages/core/src/cli/chat/terminal-agent-status.ts:135`。
- 证据等级：**confirmed**；本次用真实 AgentSession、离线 MockLanguageModelV4 和生产 outcome mapper/reporter 执行复现；两个 CLI 消费点由图和源码核对。没有声称这次在真实 Herdr UI 上重复了超时场景。
- 触发：`turnTimeoutMs: 50`，模型的 doStream 等待 abort，Runtime 实际输出 `turn-cancelled`，`reason: "timeout"`，提示“本轮等待时间过长，已自动停止”。
- 实际：`terminalAgentOutcomeAfterEvent` 对所有 turn-cancelled 返回 cancelled，根报文为 `working → idle`，没有 error。该类型还包含 runtime；当前函数也不区分它。
- 预期：用户主动取消可以 idle；超时/运行异常中止应保留需要关注的终态，建议 timeout 映射 failed/error，并明确 runtime 关闭与运行异常的处理。至少不能在“错误上报”的产品描述下默默合并所有取消原因。
- 影响：用户离开 pane 时，超时会看起来只是正常空闲，无法通过错误状态关注这轮异常终止；不影响底层取消或持久化。
- 归属：本次新增状态分类的遗漏，不是 Runtime 的取消机制缺陷。初版方案也未充分展开非用户取消，需要一并补齐。
- 修复建议：按 SessionEvent 的 reason 分流；给共享 mapper 加 user/timeout/runtime 场景，并在至少一个真实 AgentSession 的 CLI harness 中验证超时结果。保持用户取消收尾前不能提前 idle，以及已有 failed 不被后续取消覆盖。

实际复现结果：

```json
{
  "terminalEvent": { "type": "turn-cancelled", "reason": "timeout" },
  "outcome": "cancelled",
  "states": ["working", "idle"]
}
```

### M2 — 新入口测试把 pipe 伪装为 TTY，普通本地环境必现失败

- 位置：`packages/core/src/cli/commands/chat-status-entry.test.ts:61-62`，以及该文件 spawn 使用的三个 pipe。
- 证据等级：**confirmed**；独立重跑 171 项得到 170 pass / 1 fail，唯一失败为 `actual CLI OSC exclusion: one shot`。另将同一入口文件设为 `CI=1` 后 11/11 通过。
- 触发：`NODE_ENV=test`，未设置 CI，TTY 矩阵为三个 true。preload 只设置 `isTTY`，没有把 Writable pipe 变成真正的 tty.WriteStream。
- 实际：单次聊天的 ora 路径调用缺失的 `cursorTo()`，抛出 `this[#stream].cursorTo is not a function`；watchdog 在 15 秒杀死子进程，exit 为 null，测试失败。
- 预期：状态排除测试应在普通本地环境与 CI 都可重复执行，不能依赖外部 CI 恰好禁用 spinner。
- 影响：新增测试会令正常本地回归变红；t1 的 171/171 结果不能不带环境条件地复现。这是测试夹具问题，不是实际 TTY 中的 Roll 状态输出缺陷。
- 修复建议：为入口夹具显式固定非渲染环境，或使用真正 PTY/完整的终端流替身；不能仅增加 watchdog 时间。保留对 stdout/stderr 零 OSC 的断言，并分别跑 CI=1 与 CI 未设置的用例。

独立复现命令（在允许进程身份查询的环境）：

```sh
env -u CI NODE_ENV=test node --experimental-strip-types --experimental-sqlite \
  --test --test-name-pattern='actual CLI OSC exclusion: one shot$' \
  packages/core/src/cli/commands/chat-status-entry.test.ts
```

## 验证记录

| 项目                           | 本次独立结果       | 限定                                                     |
| ------------------------------ | ------------------ | -------------------------------------------------------- |
| t1 列出的 171 项聊天回归       | 170/171，0 skipped | 无 CI；M2 是唯一失败                                     |
| 入口测试，CI=1 对照            | 11/11              | 证明环境依赖，不视作已修复                               |
| Ink/basic 真实 Unix PTY        | 2/2                | 测试驱动实际 CLI 前端和 reporter；会话事件为离线 fixture |
| Core CLI tsc --noEmit          | 通过               | 直接使用已安装 TypeScript                                |
| Core UI tsc --noEmit           | 通过               | 同上                                                     |
| 所有变更/新增 TS 的 ESLint     | 通过               | 未使用 fix                                               |
| git diff --check               | 通过               | 未暂存                                                   |
| timeout AgentSession 探针      | 已复现 M1          | 真实 Runtime 产生取消事件，生产 mapper 发 idle           |
| 旧 schedule-calendar help 失败 | 基线与当前均复现   | 两者 help.stdout 都为空、同一 --start-at 断言失败        |
| 侧边栏证据                     | 已查看 t1 保存截图 | 图中确有 roll-status 条目；未重复创建真实 Herdr 测试终端 |
| changeset                      | Core minor 合理    | 兼容性新增功能；未运行版本化或发布                       |

首次沙箱执行部分用例因 OS 进程身份查询受限而提前失败；在允许本机进程查询后重跑才得到上面的 170/171，不把权限失败归为产品回归。

调度基线使用 `git archive HEAD` 的独立临时快照，读取同一组已安装依赖，未 stash/reset/覆盖工作区。基线和当前都额外遇到 sandbox 对 legacy daemon 身份检查的限制；该额外失败与 help.stdout 断言分开记录。基线快照：`/tmp/codex-herdr-baseline-gtws2m4d`。

日志：`/tmp/codex-herdr-review-tests-elevated.log`、`/tmp/codex-herdr-entry-ci.log`、`/tmp/codex-herdr-schedule-baseline.log`、`/tmp/codex-herdr-schedule-current.log`、`/tmp/codex-herdr-review-typecheck.log`、`/tmp/codex-herdr-review-typecheck-ui.log`、`/tmp/codex-herdr-review-lint.log`。

## 图检查补全

通过临时 `GIT_INDEX_FILE` 与临时 object directory，把新增文件作为 intent-to-add 纳入比较，并直接调用已安装 GitNexus LocalBackend 获取完整机器可读结果；没有改变真实 index 或 objects。

- 完整交付：17 文件、116 symbols、994 affected processes。
- 返回未标记 partial/truncated；输出数组数量与 summary 一致。
- risk 仍为 critical，未降级。数量包含测试和共享调用图，不等于存在 994 个真实破坏点。
- 原始结果：`/tmp/codex-herdr-graph-0yri_52x/result.json`。
- 已检查的关键生产路径：chat 交互分支 → owner → Ink/basic 注入 → 真实等待/迭代尾部 → dispose。MCP 的部分 named-symbol 候选返回异常 UID，采用明确文件和源码补证；不以整个索引“精确无漏”为结论。

因此，原报告中“漏掉 untracked、CLI 展示截断”两个范围问题已解决；静态图仍不能替代实际运行验收。

## 设计与安全判断

- CLI owner 优于在 hook 中持有：生命周期跨越会话切换和 Ink fallback，避免组件卸载误 clear；这个复杂度有必要。
- 独立 stderr fd 同步写入相比普通 stream.write：报文固定且很短，避免 Ink 拦截和异步异常；失败停用仅影响上报。未扩展为通用日志通道。
- 固定状态/app/kind 不含用户文本，因此当前协议编码没有新增动态文本注入面。HC_TERMINAL_ID 只做启用判断，没有被当作审批或访问权限。
- 本次没有修改网络认证、存储格式、SQL、支付或授权决策，这些安全面 N/A。终端 I/O、环境 gate、审批等待包装和子进程测试已检查。
- Regex audit：生产 diff 没有新增策略正则；trim/nonempty 与布尔 TTY gate 已有正反例。未增加字符串协议解析器。
- 已排除的重点假设：重复 ready 覆盖 done、旧回合覆盖新会话、clear 后复活、message-finish 早报完成、缩放丢状态；对应测试与源码支持排除。

## 尚未验证与下一步

- 本次未重跑全 Core 测试、完整 build、全仓 format 或真实 sidecar agent health；对应结果仍是执行者报告，不能标为本次独立通过。
- 本次只复核保存的 Herdr 侧边栏截图和两项 PTY 测试，没有重演真实 hc 状态全过程，也没有验已查看/未查看提醒转换。
- PTY 的 cancel 输入由 fixture 产生取消事件，不等于按键触发的所有取消链路已经实测；真实 Runtime 的 timeout 探针揭示了缺失分支。
- 建议 t1 先修 M1/M2并更新验证报告，补独立终端中的完成提醒转换证据，再提交第二轮复核。无须修改无关调度测试、46 个旧格式文件或正在运行的 sidecar。

## t4 独立复核后的综合结论

此节追加于 t4 完成独立审查后，保留上面的首次复核记录，不把修复前状态改写为通过。t4 最终答复已单独保存为 `/tmp/codex-herdr-t4-final-review.txt`，仅保存最终报告，不包含过程推理。两份报告未相互平均评分。

- **共同问题：异常取消误报 idle。** t4 评为 High，本报告评为 Medium；双方对触发和实际行为一致。t4 强调多终端后台关注提醒这一核心场景，Codex 强调影响限于 CLI 状态投影、没有破坏 Runtime 账本。统一决定在本轮签收前修复 user/timeout/runtime 的映射。
- **追加问题：审批截止期未释放前端等待。** t4 确认 Ink 和基础 REPL 在真实 Runtime 超时后仍停留 blocked/permission。Codex 阅读并重跑其离线探针，得到相同结果；日志 `/tmp/codex-herdr-combined-probes.log`。同时读取 HEAD 基线确认：无截止期的 decisionPromise 和只使用进程级 signal 的 renderer 在本次改动前已存在。归属为既有交互缺口，被新增跨进程状态契约暴露；本轮补齐 Core 前端收尾，不改变 Runtime。
- **测试问题合并处理。** 保留本报告 M2 的 CI 环境依赖问题；采纳 t4 的 JSON interactive 假阳性发现：目前任意启动错误的 exit=1 都能通过，应同时断言预期的 `--json 模式需要消息`。这两项属于同一个入口测试文件，但根因和验收断言分别保留。
- **待验收和归档。** 保留真实 Herdr 已查看/未查看提醒转换；验证报告作为有版本和场景边界的快照保留，并补报告索引。临时目录/PID 仅作本机证据线索，不作为长期可重复验收的唯一条件。
- **未采纳为当前修改项：Linux 非阻塞写风险。** t4 未在 Linux 实测；其 macOS 探针反而证伪了本机 O_NONBLOCK 假说。没有可复现证据，不为此扩展重试队列或更换 reporter 写入模型。

执行计划已写入本地 `docs/superpowers/plans/2026-11-13-herdr-review-followup.md`（该目录按仓库约定被忽略）；由用户指定的 t1 执行，继续禁止暂存、commit、push、发布、全局安装和干扰现有 sidecar。完成后交回 t3 复核。
