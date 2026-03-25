---
"@roll-agent/core": minor
---

Agent env declaration system, install safety, and config migration detection

- Fix env placeholder detection: `${FOO}` values in agents.env are now
  correctly reported as "missing" instead of falsely passing checks
- Fix tgz/tarball install: resolveInstalledPackageRoot 3-level fallback
  for non-standard package specs
- Fix symlink safety: roll-env-file path check uses realpathSync
- Add agent env declaration system: SKILL.md roll-env-file + env.yaml
  contract, inspectAgentEnvRequirements in doctor/add/install/info
- agent-install rejects git URLs and local directories with guidance
- doctor reports per-agent env status (ok/warn/fail)
- Config migration detection in roll update and roll doctor
