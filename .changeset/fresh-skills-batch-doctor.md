---
"@roll-agent/core": patch
"@roll-agent/browser-use-agent": patch
---

Add orchestrator-focused runtime improvements across Roll and browser-use.

Core now serves registered agent skill documents through `roll skills list|get|path`, including an opt-in `roll skills get <agent> --include-references` mode that returns referenced local `references/*` documents. `roll run` also supports `--batch-json`, `--batch-file`, and `--batch-stdin` for multiple explicit tool calls in one CLI process, while `roll doctor` adds `--fix-plan` and safe `--fix` handling for config migration, missing agent data directories, and orphan core-managed runtime metadata.

The browser-use agent now emits and accepts BOSS recommend-list `candidateRef` handles so orchestrators can pass stable tool-facing references to `zhipin_say_hello` and `zhipin_open_resume` instead of relying only on raw DOM indices.
