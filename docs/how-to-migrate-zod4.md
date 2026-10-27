# Migrate schema consumers to Zod 4

Roll now pins Zod **4.6.6**, which includes the fix for
[GHSA-mrhx-c7xc-m3w5](https://github.com/advisories/GHSA-mrhx-c7xc-m3w5).
The installed AI SDK and MCP SDK already support Zod 4 and do not require an
upgrade for this migration.

## Who needs to change code

Agent authors passing schemas to `defineTool()` must use Zod 4 schemas for both
`input` and `output`. Consumers composing exported schemas from Core's
`config/*`, Runtime, Browser, Companion's `localApprovalDecisionSchema`, or
Reply Authority Client must also use Zod 4.
These public TypeScript schema interfaces are breaking changes and receive
major Changesets. Zod 3 schemas are no longer accepted by the SDK's types.

CLI users do not need to edit `roll.config.yaml` or migrate databases. Existing
configuration defaults, YAML keys, tool names, and Runtime/Relay wire versions
remain unchanged. Protocol and Relay schema APIs already used `zod/v4`.
Relay Client retains its existing public schema interfaces.
Protocol owns its UUID and timestamp validation patterns, retaining the existing
accepted wire values across this dependency upgrade. The exported `uuidSchema`
lets Relay reuse the same validation; the existing `timestampSchema` continues
to accept minute precision. Generated Runtime/Relay schemas keep their existing
union representation for strict JSON Schema consumers.

## Update an Agent

Install Zod 4 alongside the new SDK:

```sh
pnpm add zod@4.6.6
```

Continue importing `z` from `zod`. Do not switch to `zod/v3` to bypass migration:
that restores the old implementation, including its oversized-array behavior.

```ts
import { z } from "zod";
import { defineTool } from "@roll-agent/sdk";

export const lookup = defineTool({
  name: "lookup",
  description: "Look up entries",
  input: z.object({
    labels: z.record(z.string(), z.string()),
    options: z.object({ limit: z.number().int().min(1).default(10) }).prefault({}),
  }),
  output: z.object({ count: z.number().int() }),
  execute: async (input) => ({ count: Math.min(Object.keys(input.labels).length, input.options.limit) }),
});
```

Apply these changes where relevant:

- Replace `z.record(valueSchema)` with `z.record(z.string(), valueSchema)`.
- Use `.prefault({})` for an omitted object whose child defaults must be parsed.
  Zod 4 `.default()` returns its value directly; it does not fill nested defaults.
- Replace Zod 3's `ZodType<Output, ZodTypeDef, Input>` with
  `ZodType<Output, Input>`. Tool `execute` receives the parsed output type;
  direct test calls should pass `tool.input.parse(rawInput)`.
- Use `.safeExtend()` when adding fields to a refined object without losing its
  refinements. Root preprocessing and transforms use `ZodPipe`; `ZodEffects`
  and `ZodBranded` are no longer runtime classes.
- Inspect `ZodError.issues` rather than depending on Zod 3's English messages or
  issue codes. For example, invalid enum values now use `invalid_value`.

SDK tool registration exposes the input object to MCP and validates the original
schema before business execution. Root refinements, preprocessing, and transforms
continue to run through that validation path. Application-output schemas must
remain representable as JSON Schema: custom refinements, transformations,
coercion, defaults, and flagged regular expressions are rejected before execution.

See the [Zod 4 migration guide](https://zod.dev/v4/changelog) for other upstream
changes, including stricter numeric validation and enum-keyed records.
