---
"@roll-agent/core": patch
---

统一 stdio 子 Agent 的环境变量继承口径：`buildStdioChildEnv` 现在始终继承宿主 `process.env`（config `agents.env` 同名项优先覆盖），与 core-managed spawn 行为一致。

此前 stdio 子进程仅在 config 配置了至少一个 env 时才继承宿主环境，导致三处口径互相矛盾：env 检测（`inspectAgentEnvRequirements`）认可 shell 环境变量、`roll doctor` 运行态实测却报「运行态缺失」、且给 Agent 配置任意一个变量会隐式改变其他宿主变量的可见性（非单调）。统一后 shell 中已 export 的必填变量在运行态真实可用，doctor 对此类变量的结论从误报 fail（运行态缺失）修正为 warn（运行态漂移，提示尚未持久化到 YAML）；真实缺失仍照常报错。
