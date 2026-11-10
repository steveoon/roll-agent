---
"@roll-agent/core": patch
---

Fix nested Roll commands on Windows when the current Node executable uses an extended path. Preserve equivalent ordinary drive and UNC paths, and use a native launch bridge for namespace-dependent, Unicode or genuinely long launch paths. Keep arguments, raw standard streams, exit codes and existing process ownership while continuing to run the current Node and Roll entrypoint.
