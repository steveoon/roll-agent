---
"@roll-agent/core": major
---

Remove the partial `/reload` command from ordinary interactive `roll chat`. After editing `roll.config.yaml`, restart and resume with `--last` (or `--session <id>`) to apply the complete configuration while preserving conversation history. `/status` remains read-only; `/model`, effort and Fast switching retain their existing behavior. Runtime configuration reload and per-thread model APIs used by third-party apps, including the legacy `--server` entry point, are unchanged.
