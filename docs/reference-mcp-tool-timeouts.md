# MCP tool execution timeouts

A tool may opt into a longer or shorter MCP request deadline through metadata:

```ts
defineTool({
  // Existing name, schema and implementation...
  _meta: { "roll/executionTimeoutMs": 120_000 },
});
```

Runtime, `roll run`, and `roll ask` accept integer values from 1,000 through 1,800,000 milliseconds. Missing or invalid values retain the MCP SDK default (currently 60 seconds). The declaration is read from the listed tool's MCP metadata, never guessed from arbitrary tool arguments. The SDK already forwards `_meta` without a special adapter.

The tool deadline does not replace the Runtime turn's cancellation signal, turn timeout, tool policy, or resource lock. A tool must still implement its own cancellation and operation budget. An Agent declaring a maximum task duration should allow a small amount of transport/cleanup time in the advertised deadline.

`browser_operate` advertises 1,205,000 milliseconds for its maximum 1,200,000 millisecond operation budget. A shorter turn timeout still cancels the call first. Unrelated tools keep their existing deadlines.
