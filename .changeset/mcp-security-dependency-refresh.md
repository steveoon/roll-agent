---
"@roll-agent/core": patch
"@roll-agent/runtime": patch
"@roll-agent/sdk": patch
---

更新 MCP SDK 至 1.32.0，并更新配置台开发依赖 Vite 与 launch-editor，以通过高危依赖审计。MCP HTTP 连接现在默认只跟随同源重定向；使用跨源跳转的服务请直接配置最终 MCP 地址。
