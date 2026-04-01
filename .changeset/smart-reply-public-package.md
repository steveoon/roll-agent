---
"@roll-agent/smart-reply-agent": minor
---

feat(smart-reply): publish as public npm package with pipeline sub-path export

- Rename from `smart-reply-agent` (private) to `@roll-agent/smart-reply-agent` (public)
- Add `./pipeline` sub-path export exposing `generateSmartReply` and all related types
- Add `rollAgent` manifest for stdio on-demand agent registration
- Exclude test files from build output
