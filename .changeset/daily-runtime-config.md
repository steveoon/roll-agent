---
"@roll-agent/core": minor
"@roll-agent/runtime": minor
---

Let Runtime hosts select an explicit configuration source and resource workspace independently of the task working directory. Reject missing or empty explicit sources, preserve ordinary CLI discovery, and keep history, Agent, skill and browser resources bound to the chosen workspace.

Persist an optional opaque host context with scheduled tasks so create/list/extend, CLI/UI reauthorization and daemon execution keep the chosen source across restarts. Configuration and authority changes during confirmation are rejected; missing or corrupt sources fail without cwd fallback. Existing unbound jobs retain their original behavior. Scheduler schema 10 migrates existing rows and fences older writers; restart older scheduler daemons. Chat history schema and Runtime Protocol are unchanged.
