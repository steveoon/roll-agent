---
"@roll-agent/runtime": patch
---

roll__bash 的 POSIX shell 现在以可降级的方式启用 pipefail：管道任一阶段失败整条管道即失败，退出码不再被 head/tail 等末端命令掩盖；不支持 pipefail 的旧 shell（如老版本 dash）自动降级为原有末端退出码语义。roll__bash 新增 `max_output_chars` 参数（整数，1000-200000，默认继承 `runtime.shell.max-model-output-chars`）按调用控制输出量；系统提示不再鼓励自接 head/tail 管道，改为引导使用该参数或 roll__read_file / roll__grep。
