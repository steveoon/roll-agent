---
"@roll-agent/core": minor
"@roll-agent/runtime": minor
---

`roll chat` 新增可恢复上下文的 Esc 中断协议，并让已安装 skill 的脚本路径与进程退出状态可判定。

- Ink 执行态支持 legacy VT 与 kitty keyboard 编码的 Esc 中断；工具确认框中的 Esc 仍只拒绝当前工具。
- 取消事件区分 user / timeout / runtime，保留已经完成的 AI SDK steps 与取消标记，避免 UI 历史存在但下一轮模型上下文丢失。
- 用户取消会在模型两次后台任务轮询之间直接 interrupt 当前会话的 exec 进程；服务端另提供 `session.close` 做完整资源释放。
- turn timeout 使用 Roll 自有 abort reason，provider 网络超时仍按真实错误上报，不再被误判成整轮 300000ms 超时。
- `roll__skill` 返回 canonical `SKILL_ROOT`，相对脚本与 reference 统一从该目录解析，不再猜测 `.roll`、`.claude` 或其它安装位置。
- reference 加载不再为取得根路径重复读取 `SKILL.md`，并区分“skill 不存在”和“reference 不存在”。
- `roll__skill` 列出的 references 相对路径在 Windows 上也统一为正斜杠 canonical 形式，模型回传两种分隔符均可解析。
- shell 结果显式标记 abort / timeout；后台 exec 仅在用户主动取消时中断当前会话，运行时总超时不会误杀已后台化任务。
