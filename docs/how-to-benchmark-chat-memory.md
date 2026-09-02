# How to benchmark `roll chat` memory growth

`pnpm bench:chat-heap` 在真实的 Ink 全屏 REPL 里复现「长时间连续工具调用 + 长 reasoning」的使用强度，采样 GC 后的堆占用，输出堆增长斜率并给出 PASS/FAIL。它用来验证 issue #242（长会话 V8 堆 OOM）的修复效果，也可作为回归守卫。

## 前置条件

- macOS / Linux，已安装 `tmux`（Ink 全屏 REPL 只在真实 PTY 下启用，管道 stdin 会退化成基础 REPL）
- Node ≥ 22.6，仓库依赖已安装

benchmark 不访问网络、不读写真实 `~/.roll-agent`：它在临时目录里生成独立的 `HOME`、`roll.config.yaml` 与 `threads-dir`，并启动一个本地假 DashScope 兼容 SSE 服务作为模型后端。

## 运行

```bash
pnpm bench:chat-heap                      # 修复后的默认行为，采样 180s
pnpm bench:chat-heap --mode baseline      # 强制 NODE_ENV=development，复现修复前的增长曲线
pnpm bench:chat-heap --entry dist         # 跑 packages/core/dist 构建产物（需先 build）
pnpm bench:chat-heap --duration 600 --keep --json
```

输出示例：

```
模式            fixed（NODE_ENV=production，entry=src）
采样窗口        150s / 31 个点（跳过前 30s）
完成步数        8
堆占用(GC 后)   76MB → 112MB（RSS 409MB，堆上限 4288MB）
堆增长斜率      13.9 MB/min（阈值 30）
撞上限预计      299 分钟
perf measure    0 条滞留（production 构建应为 0）
结论            PASS
```

退出码：`0` PASS，`1` FAIL（斜率超过 `--max-slope`），`2` 环境或驱动错误（如缺少 tmux、`roll chat` 未进入输入状态）。

## 它在测什么

假服务每一步先以约 400 字/秒流式输出 8000 字中文 reasoning（长段落、偶有换行，贴近真实 thinking 输出），再返回一个只读工具调用 `roll__read_file`；引擎执行工具后继续下一步，形成不间断的「思考 → 工具」循环。`heap-sampler.mjs` 通过 `--import` 注入 chat 进程，每 5 秒先 `gc()` 再记录 `heapUsed`、RSS、`performance.getEntriesByType("measure")` 条目数。

跳过 `--warmup` 秒后，对剩余采样点做最小二乘拟合得到 MB/min 斜率；「撞上限预计」= (堆上限 − 当前堆) ÷ 斜率。

## 解读

- **修复前（`--mode baseline`）**：本机实测约 150 MB/min，26 分钟即可撞上 4288MB 堆上限，`perf measure` 条目随渲染次数线性增长——这是 React 开发版 Performance Tracks 把每帧的新旧 `children` 文本塞进 `performance.measure()` 的 `detail`，而 Node 会把所有 measure 条目永久留在 user-timing 缓冲区。
- **修复后（默认）**：`perf measure` 为 0，本机约 14 MB/min。剩余增长来自 Ink 7 的 `measure-text.js` / `wrap-text.js` 无界文本缓存（随流式文本刷新缓慢累积，数小时连续流式输出才会接近上限）。上游已在 master 修复（vadimdemedes/ink#986，commit ad9e3ea 改用 quick-lru），v7.1.1 尚未包含；升级到包含该提交的 ink 版本后重跑本 benchmark，斜率应接近 0，届时可收紧 `--max-slope`。

## 参数调整

| 参数 | 默认 | 说明 |
| --- | --- | --- |
| `--reasoning-chars` | 8000 | 每步 reasoning 字数 |
| `--delta-ms` | 25 | 每 10 字的 SSE 间隔，越小流速越快 |
| `--columns` / `--rows` | 170 / 45 | tmux 窗口尺寸，影响换行与每帧文本量 |
| `--max-slope` | 30 | PASS 阈值（MB/min）。修复后本机约 14 MB/min（来自 Ink 缓存，随终端宽度与行长波动），修复前约 150 MB/min |
| `--keep` | 关 | 保留临时目录（含 `logs/trace.jsonl`、`logs/chat-stderr.log`、`logs/fake-llm.log`） |
