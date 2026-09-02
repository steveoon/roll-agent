---
"@roll-agent/core": patch
---

fix(chat): 修复长会话内存无界增长导致 V8 堆 OOM（#242）

CLI 入口现在默认 `NODE_ENV=production`（已显式设置时保持不变）。此前 React / Ink 一直以 development 构建运行，React 19.2 开发版的 Performance Tracks 会在每次组件渲染时调用 `performance.measure()`，并把变更前后的 `children` 文本放进 `detail`；Node 会把所有 measure 条目永久留在 user-timing 缓冲区。流式 thinking/reasoning 每 32ms 刷新一次预览，每个 reasoning 块的滞留量与「长度 × 刷新次数」成正比，连续工具调用几十分钟即可撞上 V8 堆上限。

修复后剩余的少量增长（本机约 14 MB/min）来自 Ink 7 的 `measureText` / `wrapText` 无界缓存，上游已在 master 修复（vadimdemedes/ink#986，commit ad9e3ea）但尚未发版，待下一个 ink 版本发布后升级即可归零。

新增 `pnpm bench:chat-heap`：在 tmux 里驱动真实 Ink REPL 对接本地假 DashScope SSE 服务，采样 GC 后堆增长斜率并给出 PASS/FAIL；`--mode baseline` 可复现修复前的增长曲线。
