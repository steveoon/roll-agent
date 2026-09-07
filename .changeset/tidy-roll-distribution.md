---
"@roll-agent/core": minor
---

Add standalone installations with a private Node/npm execution environment, install.sh/install.ps1 installers, channel-aware updates, and installation diagnostics. Bare node/npm/npx commands and npm lifecycle scripts use the selected execution environment while explicit interpreter paths and other commands retain their existing environment. Background services use pinned absolute launch paths; busy or unverifiable services defer switching versions rather than interrupting active work.

Preserve npm installations and refuse self-updates when the running installation cannot be matched to npm's target directory. Users of other global package managers can continue to update through their original manager. Standalone installation and update URLs become available after verified platform assets are deployed.

Clean up interrupted standalone downloads and preflight operations on SIGINT/SIGTERM, and retain lock ownership details for uncatchable termination. Treat unavailable version checks consistently as a skipped self-update for npm and standalone installations, while keeping actual installation failures nonzero. Allow doctor to diagnose damaged installations when global flags precede the command.

Retry transient Windows sharing errors during version activation within a bounded budget, retaining the active version when activation fails. Avoid redundant file-content hashing after extraction while preserving archive checksums, extracted file-type checks, and immutable-version comparisons.
