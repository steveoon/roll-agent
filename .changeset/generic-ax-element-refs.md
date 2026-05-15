---
"@roll-agent/browser": minor
"@roll-agent/browser-use-agent": minor
---

Add generic browser Accessibility snapshots and stable `@eN` element refs.

- Add AX snapshot schemas, `Accessibility.getFullAXTree` support, and `@eN` ref generation in `@roll-agent/browser`.
- Add backendNodeId-first element ref actions with role/name/nth fallback for stale refs, including recursive same-target iframe refs that carry `frameId`.
- Expose `browser_snapshot`, `click_ref`, and `type_ref` in `browser-use-agent`, capped by `security.maxSnapshotNodes` and gated by browser action policy.
