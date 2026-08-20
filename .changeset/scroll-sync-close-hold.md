---
"@roll-agent/core": patch
---

roll chat 滚动光标闪烁的真正修复：Ink 的滚动重绘 span 只含隐藏光标（光标恢复在下一个独立 span），此前两个同步块之间光标有一帧隐藏态，每滚一次闪一下。托管输出层现在扣住 hide-only span 的 `?2026l` 关闭符，让终端同步块保持打开直到光标 span 关闭整体，重绘与光标恢复原子应用；100ms 兜底释放避免无光标场景卡帧。附带 `ROLL_CHAT_WRITE_TRACE` 环境变量可抓取 chunk 级写入轨迹用于诊断
