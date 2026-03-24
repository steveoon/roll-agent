# smart-reply-agent

`smart-reply-agent` is on-demand (`stdio`) and does not need startup.

## Tools

- `generate_reply(candidateMessage, conversationHistory, candidateInfo)`
- `sync_brand_data(cityName, brandAlias?)`

## Input Expectations

Use `generate_reply` only when you already have structured input:

- `candidateMessage`: the current candidate message
- `conversationHistory`: ordered message history
- `candidateInfo`: structured candidate context

If you do not have those fields yet, gather them first through explicit `browser-use-agent` calls and then switch to `roll run smart-reply-agent generate_reply --input-json ...`.
