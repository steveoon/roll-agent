---
"@roll-agent/runtime": patch
---

Fail closed when shell auto-approval cannot prove filesystem or executable containment: canonicalize existing paths, accept only exact common flags, reject unresolved glob and symlink-following reads, bind known-safe execution to a fixed POSIX shell and system `PATH`, and carry one admission snapshot through locked revalidation and execution. Require confirmation for Git and custom executables.
