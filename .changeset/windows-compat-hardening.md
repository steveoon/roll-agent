---
"@roll-agent/core": patch
---

Windows 兼容性加固（基于全库静态审计，报告见 docs/windows-compatibility.md）。

- **stdio 子进程编码**：`buildStdioChildEnv` 注入 `PYTHONUTF8=1` / `PYTHONIOENCODING=utf-8`（可被 agent env 显式覆盖），消除 Windows 上 Python 子 Agent 按 locale 编码写 stdout 导致的中文乱码；非 Node Agent 接入文档补充 UTF-8 编码要求
- **BOM 容忍**：registry 层读取 `package.json` / sidecar / agents.json 统一经 `readJsonFile`（strip UTF-8 BOM），修复 Windows 工具写入 BOM 后 `roll agent add` 报 `Invalid package.json` 的问题
- **托管进程 spawn**：`process-manager` 切换 cross-spawn（Windows 上可解析 `.cmd`/`.bat` 启动命令，与 MCP SDK 行为对齐）并设置 `windowsHide`；`roll agent stop` 在 Windows 提示强制终止语义
- **home 解析统一**：config 的 `~` 展开改用 `os.homedir()`（与 ThreadStore 一致，避免 Git Bash 下 `HOME`/`USERPROFILE` 不一致导致数据目录分裂），并支持 `~\` 前缀
- **agents.json 原子写**：临时文件 + rename，避免崩溃时半截写入被静默清空
- **chat spinner 降级**：不支持 Unicode 的终端（legacy conhost 等）自动从 braille 降级为 ASCII 帧
