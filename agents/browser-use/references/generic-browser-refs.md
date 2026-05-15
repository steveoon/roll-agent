# Generic Browser Refs

Use this reference when an orchestrator needs to operate a browser page element that is not covered
by a platform-specific tool.

## Purpose

`browser_snapshot`, `click_ref`, and `type_ref` provide a generic accessibility-driven observe/action
loop:

```text
AX snapshot -> select emitted @eN -> click/type -> re-observe or read back
```

This is a fallback layer for unmodeled page operations. For BOSS workflows, prefer `zhipin_*` tools
when they already express the business action.

## Tool Summary

| Tool | Input | Output | Use it for |
| --- | --- | --- | --- |
| `browser_snapshot` | `pageId?`, `maxDepth?`, `maxNodes?`, `interactiveOnly?` | `page`, `snapshot` | Observe the current page's AX tree and get `@eN` refs. It also merges limited DOM-action hints for non-semantic controls such as clickable tabs rendered as `span`, and recursively inlines same-target iframe AX refs when Chrome exposes child `frameId` values. |
| `click_ref` | `ref`, `pageId?`, `browserActionApproval?` | `success`, `ref`, `resolvedBy`, `target` | Click a ref returned by `browser_snapshot`. |
| `type_ref` | `ref`, `text`, `clear?`, `pageId?`, `browserActionApproval?` | `success`, `ref`, `resolvedBy`, `target` | Focus a ref, optionally clear it, then insert text. |

`browser_snapshot.snapshot` contains:

| Field | Meaning |
| --- | --- |
| `nodes` | AX nodes returned to the orchestrator. With `interactiveOnly:true`, this is a flat list of interactive nodes. |
| `refs` | Current-snapshot handles, shaped as `@e1`, `@e2`, ... |
| `nodeCount` | Number of returned nodes. |
| `truncated` | `true` when `maxNodes` stopped traversal. |
| `maxNodes` | Effective node cap after applying `BROWSER_SECURITY_JSON.maxSnapshotNodes`. |
| `interactiveOnly` | Whether non-interactive context nodes were omitted. |
| `maxDepth` | Optional AX tree depth cap used for this snapshot. |

Each `refs[]` item contains `ref`, optional `backendNodeId`, optional `frameId`, `role`, `name`,
`nth`, and `disabled`. AX-native refs use their AX role. DOM-action refs use `role:"clickable"`,
`role:"focusable"`, or `role:"editable"`, preserve a real `backendNodeId` when Chrome exposes one,
and appear in `nodes[]` with `properties.domActionable:true`, `properties.domActionKind`, and
`properties.domActionHints`.

Iframe handling:

```text
main AX tree -> iframe node backendNodeId -> DOM.describeNode -> child frameId
  -> Accessibility.getFullAXTree({ frameId })
  -> repeat for nested same-target iframes until maxNodes or frame de-duplication
  -> child refs carry frameId
```

When an iframe child ref is clicked or typed, `click_ref` / `type_ref` keep the `frameId` in the
resolved `target`. If the original `backendNodeId` is stale, the fallback re-queries that same frame's
AX tree before dispatching the viewport action.

## Selection Logic

Choose a target in this order:

1. Match the user's intent against `role` and `name`, for example `role:"button"` and `name:"交换电话"`.
2. Reject refs with `disabled:true`.
3. For non-semantic clickable text, match `role:"clickable"`, the visible label, and
   `properties.domActionable:true`; examples include tab/filter labels such as `未读`.
4. If there are multiple matching nodes, prefer visible task context from nearby `nodes` data or take
   another snapshot with `interactiveOnly:false` and a small `maxDepth`.
5. If a matching ref includes `frameId`, pass the ref normally; do not pass `frameId` manually.
6. Keep the selected `page.pageId` and pass it back to `click_ref` / `type_ref` when multiple pages are open.

Do not construct refs manually. Only pass refs emitted by the most recent snapshot for that page.

## Action Flow

```bash
roll run browser-use-agent browser_snapshot --input-json '{"interactiveOnly":true}' --json
roll run browser-use-agent click_ref --input-json '{"ref":"@e3"}' --json
roll run browser-use-agent browser_snapshot --input-json '{"interactiveOnly":true}' --json
```

For text input:

```bash
roll run browser-use-agent type_ref --input-json '{"ref":"@e5","text":"hello","clear":true}' --json
```

When `BROWSER_SECURITY_JSON.actionPolicy` is `confirm`, the first side-effecting action can return
`needs_confirmation`. In that case, take `details.approvalRequest.retryInput` from the structured
error and merge it into the retry input unchanged.

## Visual Feedback

The generic ref tools use the native CDP visual feedback path:

| Tool | Activity capsule | Visual cursor |
| --- | --- | --- |
| `browser_snapshot` | Shows reading and completion/failure state. | Not applicable because it is read-only. |
| `click_ref` | Shows click progress and completion/failure state. | Shows pointer placement and click pulse for the resolved target point. |
| `type_ref` | Shows input progress and completion/failure state. | Shows pointer placement and click pulse before text insertion. |

`BROWSER_VISUAL_ACTIVITY=false` disables the capsule. `BROWSER_VISUAL_CURSOR=false` disables the
pointer and click pulse.

## Staleness Rules

Refresh the snapshot before reusing `@eN` after any of these events:

- navigation, reload, redirect, or platform switch
- modal open/close
- list filtering, search, sort, or virtual-scroll loading
- a prior `click_ref` that may re-render the target area
- `click_ref` / `type_ref` returns a stale-ref or not-found error

`click_ref` and `type_ref` first resolve by `backendNodeId` when the ref has one. If that fails, they
fall back to `role/name/nth`. The fallback is useful for small re-renders, but it is not a business
identity.

## Relationship To BOSS Refs

| Ref family | Produced by | Consumed by | Meaning |
| --- | --- | --- | --- |
| `@eN` | `browser_snapshot` | `click_ref`, `type_ref` | Generic AX element handle for the current page snapshot. |
| `@cN` | `zhipin_get_candidate_list` | `zhipin_say_hello`, `zhipin_open_resume` | BOSS recommendation candidate handle. |
| `@jN` | `zhipin_list_recommend_jobs` | `zhipin_select_recommend_job` | BOSS recommendation job-filter handle. |

Do not pass one ref family into another tool family.

## Boundary Conditions

- This is an Accessibility Tree snapshot, not a full HTML dump, screenshot, network log, or page state database.
- DOM-action refs are intentionally narrow: short visible non-semantic elements with click hints such as
  `cursor:pointer`, `onclick`, `tabIndex`, or nearby class names like `filter`, `tab`, `menu`, `button`, or
  `toggle`. Plain article text is not exposed as clickable.
- DOM-action augmentation is collected from the active document path. Iframe refs are primarily AX-based;
  non-semantic iframe controls that Chrome exposes only as static text may still need a dedicated tool.
- Canvas, image-map hotspots, non-accessible custom widgets, and deeply nested iframe/Shadow DOM flows may not expose
  enough AX semantics for reliable operation.
- Same-target iframe refs are recursively inlined while Chrome's normal page-scoped CDP session can
  resolve child `frameId` values. The recursion stops at `maxNodes`, skipped frame errors, or repeated
  frame IDs. Cross-target/OOPIF iframe traversal is not implemented here because it requires flattened
  CDP `sessionId` routing, which this native controller intentionally does not expose yet.
- Only click and text input are covered. Drag, hover, keyboard shortcuts, file upload, and complex gestures still need
  dedicated tools.
- The implementation does not call `Runtime.enable()` for the native CDP path. Fallback matching may use
  `Runtime.evaluate`, but it does not enable the Runtime domain. This avoids that specific detection point, not every
  possible anti-automation signal.
- `domainAllowlist`, `maxSnapshotNodes`, and `actionPolicy` from `BROWSER_SECURITY_JSON` still apply.
