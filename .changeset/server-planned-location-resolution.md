---
"@roll-agent/reply-authority-client": minor
"@roll-agent/browser-use-agent": minor
---

Default Zhipin reply generation to Reply Authority server-side planning, consume server
location-resolution stream events, and add a prepare-reply-context client API for speculative
context preheating. Zhipin reply previews now surface timing details from stream phase latency
events so prepared-context hits are visible in the browser feedback layer.

`ReplyAuthorityRequestError` now exposes the HTTP `statusCode`, and `zhipin_get_candidate_info`
backs off prepare attempts for 10 minutes after persistent failures (tenant prepare disabled or
missing client env) instead of re-issuing doomed requests on every call. Its `locationSignals`
output field is deprecated and always empty now that extraction lives server-side.

`zhipin_generate_reply_preview` now consumes `gate.completed` events: when a server-side
fact/quality gate rewrote the final reply, the browser completion label appends
「终稿经安全门调整」 and the tool output includes `gateRewritten: true`, explaining why the
final reply may differ from the streamed draft.
