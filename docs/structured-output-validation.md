# Structured App output: implementation and validation record

Date: 2026-09-17. Scope: phase one only. The code is implemented in three isolated worktrees on `codex/structured-agent-output`; the initial validation preceded any commits, pushes, package publication or production deployment.

## Delivered

- Opt-in SDK/MCP output contract, portable schema checks and completed-but-invalid execution markers.
- Runtime Protocol 1.5, independent bounded result persistence, stable event metadata, read-only result RPC and Node Client support.
- Relay Wire 1.2, version-bound sessions, safe legacy projections, exact live host authorization and non-replayed query responses.
- Electron candidate cards and an independent Web table renderer with safe fallback and isolated component errors.
- Synthetic Subagent, actual Runtime/SDK subprocess integration, actual Relay WebSocket harness and developer guide.

## Verification

| Check | Result |
| --- | --- |
| Roll workspace typecheck and lint | Passed |
| Roll full workspace tests | 4,183 passed, 23 skipped, zero failures |
| Final Companion focused suite after compatibility helper addition | 95 passed |
| Root script tests | 41 passed, 10 skipped |
| Core E2E | 70 passed |
| Roll full build | Passed |
| Packed package and dependency denylist audit | Passed |
| npm and GitHub Release dry-runs | Passed; neither published anything |
| Runtime focused persistence/SDK integration | 116 passed; included in broader runs where applicable |
| Actual isolated Relay network integration | Passed: result read, revocation, reconnect/history and single execution |
| Cloud Relay | 67 tests passed; typecheck, lint and build passed with local candidate protocol package |
| Electron | 197 tests passed; typecheck and build passed with local candidate packages |
| Electron original complete artifact verifier | Not passed: registry dependency provenance gate correctly rejects unpublished candidate-package overlay |
| Electron remaining artifact/security assertions | Passed separately as diagnostic checks; not a substitute for the complete verifier |

GitNexus indices were built independently for these worktrees. Change analysis included new source files through intent-to-add and returned no partial/truncated result: Roll603 changed symbols/107 affected flows; Relay68/18; Electron101/69. All report critical aggregate risk, consistent with this cross-protocol change; graph reachability is not proof of correctness.

## Actual UI observations

The same persisted synthetic candidate result was opened in the real Electron application and in Ego Lite through the actual local Relay server. Electron displayed the candidate card and Web displayed a table. Browser reload, reconnect and reopening history recovered the table. After removing the isolated host grant, reopening history cleared the table and displayed `Result: denied`.

The local browser run explicitly used the example's loopback-only WS testing adapter. Production SDK/WSS validation was not relaxed. This observation does not constitute deployed WSS/TLS verification.

Screenshots are retained in the task artifact directory as `roll-structured-electron-card.png` and `roll-structured-web-table.png`.

## Release gates still open

1. Publish the Changesets feature versions through the existing CI OIDC workflow. Expected dependency releases include Protocol0.7, client-node0.6 and relay-protocol0.4; final values are determined by the generated release PR.
2. Update Electron and Cloud Relay registry dependency pins and lockfiles after those versions exist. Their current tracked manifests/locks remain registry-coherent; their installed local validation overlays contain unreleased code. Do not treat a fresh registry install as verified against the new feature yet.
3. Run the original complete Electron artifact verifier with those published dependencies, plus clean frozen installs for both consumers.
4. Deploy the backwards-compatible Relay upgrade before enabling the new Companion/client chain, then perform a dedicated test-Workspace check on the deployed WSS endpoint.

The local package overlays are deliberately untracked. No absolute local dependency, fabricated registry integrity or vendored protocol snapshot was committed. Original artifact provenance checks remain enforced.

## Existing limitation found during GUI inspection

The existing transcript store timestamps a batch of user/assistant messages when the turn is persisted, while a tool execution receives its earlier execution timestamp. Consequently, a history card can sort before its originating user message. The comparator already respects timestamps and does not mix message and operation sequence domains. This pre-existing timestamp lifecycle was left unchanged; no speculative reordering or historical rewrite was added to this feature.

During initial implementation, the original source checkouts, user-provided untracked Relay guide and existing GitNexus instruction edits remained untouched. Test processes were stopped after GUI verification; user Companion enrollment and credentials were not changed.

## Local dev integration

The follow-up integration commits the feature separately in each repository and fast-forwards local dev branches only. Existing main branches and unrelated working files are preserved. Relay and Electron dependency manifests remain on their published versions until the feature packages are published; a fresh registry installation is not yet a supported verification path for these consumer changes. Publication, dependency/lockfile updates, production deployment and deployed WSS acceptance remain separate pending steps.
