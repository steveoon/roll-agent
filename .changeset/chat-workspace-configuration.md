---
"@roll-agent/core": minor
"@roll-agent/runtime": minor
---

Make terminal chat history project-scoped: `roll chat --last`, `--list` and `/resume` select the current Git worktree or non-Git directory; explicit all-projects browsing includes unclassified legacy history. Add read-only history views and occupancy labels without taking over another client's session.

Normal chat accepts explicit configuration sources/resource workspaces, binds new scheduled tasks to the selected source, and supports `/status` and `/reload` in both terminal interfaces. Onboarding reads and writes the selected source, and an unbound default-config session reports reload unavailable while remaining usable. A shared Runtime controller waits for admitted turns and maintenance to settle, blocks admission while updates are pending or failed, preserves active state on failure, and validates ChatGPT model capabilities before application.
