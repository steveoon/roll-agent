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

The selection order is platform-specific tools, enabled applicable workflows, then generic
exploration. For deterministic multi-step operations, use `browser_execute` with explicit result
assertions. See [controlled exploration and workflows](browser-exploration.md) for helpers,
whole-script approval, resource limits and versioned workflow management. This reference describes
the compatible single-step tools and their optional strict-ref mode.

## Tool Summary

| Tool | Input | Output | Use it for |
| --- | --- | --- | --- |
| `browser_snapshot` | `pageId?`, `scope?`, `maxDepth?`, `maxNodes?`, `interactiveOnly?` | `page`, `snapshot` | Observe AX and limited non-semantic actionable controls. Optional `scope` is a uniquely matching CSS region, applied before the region's node budget. |
| `click_ref` | `ref`, `pageId?`, `snapshotId?`, `browserActionApproval?` | `success`, `ref`, `resolvedBy`, `target` | Click an emitted ref. Passing `snapshotId` enables strict instance/page/document/snapshot binding and disables semantic fallback. |
| `type_ref` | `ref`, `text`, `clear?`, `pageId?`, `snapshotId?`, `browserActionApproval?` | `success`, `ref`, `resolvedBy`, `target` | Focus a ref, optionally clear it, then insert text, with the same optional strict binding. |

`browser_snapshot.snapshot` contains:

| Field | Meaning |
| --- | --- |
| `nodes` | AX nodes returned to the orchestrator. With `interactiveOnly:true`, this is a flat list of interactive nodes. |
| `refs` | Current-snapshot handles, shaped as `@e1`, `@e2`, ... |
| `snapshotId` | Identity of this observation; use with its refs to request strict validation. |
| `browserInstance`, `pageId`, `documentId` | Originating instance, target and document identity; refs cannot move between these scopes. |
| `scope` | Requested CSS region, when supplied. An ambiguous or missing region is rejected. |
| `coverageWarnings` | Explicit observation gaps, such as canvas, incomplete iframe coverage or truncated DOM context scanning. |
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

Refs can also carry `context` with a form, dialog or nearby label, and a `locator` hint when a
unique CSS target can be identified. These hints aid selection and reusable scripts; they are not
durable guarantees after the page changes. Reusable locators are checked for uniqueness again at
execution time.

Iframe handling:

```text
main AX tree -> iframe node backendNodeId -> DOM.describeNode -> child frameId
  -> Page.createIsolatedWorld({ frameId }) + Runtime.evaluate in that frame
  -> DOM.getDocument({ pierce:true }) maps marker attributes back to backendNodeId
  -> Accessibility.getFullAXTree({ frameId })
  -> repeat for nested same-target iframes until maxNodes or frame de-duplication
  -> child refs carry frameId
```

When an iframe child ref is clicked or typed, `click_ref` / `type_ref` keep the `frameId` in the
resolved `target`. Only legacy calls without `snapshotId` may fall back to re-querying that frame's
AX tree when the original `backendNodeId` is stale. Strict calls stop instead.

## Structural choice rows

Native select options, ARIA choice roles, actionable list rows and independently actionable repeated
siblings are treated as atomic choices. A row can include an icon and multiple text descendants;
its container no longer consumes all descendant choices simply because the combined name is short.
Existing AX semantic roles are preserved. Plain prose lists and a single clickable card with text
children are not automatically split into choices. This grouping is independent of site labels,
domains and component classes.

For a single-select field, use `page.inspectControl(field)` and `page.choose(field, {label})` inside
`browser_execute`. See [control helpers](browser-exploration.md#通用单选控件) for portal association,
strict frame identity, result assertions and supported limits.

## Selection Logic

Choose a target in this order:

1. Match the user's intent against `role` and `name`, for example `role:"button"` and `name:"交换电话"`.
2. Reject refs with `disabled:true`.
3. For non-semantic clickable text, match `role:"clickable"`, the visible label, and
   `properties.domActionable:true`; examples include tab/filter labels such as `未读`.
4. If multiple nodes match, inspect `context` and nearby nodes, or request a uniquely matching
   `scope` with `interactiveOnly:false`. Select the intended ref explicitly; do not assume the first
   same-name button is correct. Script locators reject non-unique matches.
5. If a matching ref includes `frameId`, pass the ref normally; do not pass `frameId` manually.
6. Keep `page.pageId` and `snapshot.snapshotId` and pass both back to the single-step action. For
   multiple instances, also keep the same `browserInstance`; it is not inferred from the ref.

Do not construct refs manually. Only pass refs emitted by the most recent snapshot for that page.

## Action Flow

First obtain a real `pageId` from `list_pages`, then call `browser_snapshot` with that page and an
optional region. Build the action from the returned identities and the selected ref. For example,
the following `click_ref` JSON is a template: replace both placeholders and `@e3` with values from
the same current snapshot; do not copy a ref from another execution.

```json
{
  "pageId": "<page.pageId>",
  "snapshotId": "<snapshot.snapshotId>",
  "ref": "@e3"
}
```

Save the completed object as an input file and use
`roll run browser-use-agent click_ref --input-file <input-file> --json`. For `type_ref`, use a
textbox ref and add `text` and optional `clear:true`. Add the same `browserInstance` used to obtain
the snapshot when selecting an instance explicitly.

When `BROWSER_SECURITY_JSON.actionPolicy` is `confirm`, the first side-effecting action can return
`needs_confirmation`. Obtain explicit user approval before merging
`details.approvalRequest.retryInput` into the original input unchanged. Possessing the returned
credential is not user approval. Single-step tools use `browserActionApproval`; controlled scripts
use `scriptApproval`, and workflow activation uses `toolActionApproval`. Do not interchange them.

Single-step `success:true` confirms dispatch, not a verified business outcome. Read the resulting
field or business state, or use `browser_execute` with an explicit `expect` / `postconditions` and
check `verification`. Refresh the snapshot when the next action needs new target information;
do not require a full-page snapshot after every action.

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

With `snapshotId`, the latest snapshot, browser instance, page and document must all match; a
detached backend node stops the action without `role/name/nth` fallback. A newer snapshot also
invalidates the older snapshot identity. Scripts always require this strict binding for
`page.ref(ref, snapshotId)`.

Legacy `click_ref` / `type_ref` calls without `snapshotId` first resolve by `backendNodeId`, then may
fall back to `role/name/nth`. That fallback preserves compatibility but is not a business identity;
prefer strict mode for new callers.

## Relationship To BOSS Refs

| Ref family | Produced by | Consumed by | Meaning |
| --- | --- | --- | --- |
| `@eN` | `browser_snapshot` or script `page.snapshot()` | `click_ref`, `type_ref`, script `page.ref(ref, snapshotId)` | Generic AX element handle for the originating instance/page snapshot. |
| `@cN` | `zhipin_get_candidate_list` | `zhipin_say_hello`, `zhipin_open_resume` | BOSS recommendation candidate handle. |
| `@jN` | `zhipin_list_recommend_jobs` | `zhipin_select_recommend_job` | BOSS recommendation job-filter handle. |

Do not pass one ref family into another tool family.

## Boundary Conditions

- This is an Accessibility Tree snapshot, not a full HTML dump, screenshot, network log, or page state database.
- DOM-action refs are intentionally narrow: short visible non-semantic elements with click hints such as
  `cursor:pointer`, `onclick`, `tabIndex`, or nearby class names like `filter`, `tab`, `menu`, `dropdown`,
  `button`, or `toggle`. Plain article text is not exposed as clickable.
- DOM-action augmentation is collected from the active document and same-target iframe execution contexts.
  Non-semantic iframe controls can be promoted when they are visible short-label `span`/`div`/`li`-style
  elements with action hints and Chrome can map their marker attributes back to `backendNodeId`.
- Composite dropdown option rows such as `li.company-item` are promoted by using their visible descendant
  text only inside dropdown/menu/select/option contexts, so large page containers are still filtered out.
- Canvas, image-map hotspots, non-accessible custom widgets, and deeply nested iframe/Shadow DOM flows may not expose
  enough AX semantics for reliable operation.
- Same-target iframe refs are recursively inlined while Chrome's normal page-scoped CDP session can
  resolve child `frameId` values. The recursion stops at `maxNodes`, skipped frame errors, or repeated
  frame IDs. Cross-target/OOPIF iframe traversal is not implemented here because it requires flattened
  CDP `sessionId` routing, which this native controller intentionally does not expose yet.
- These single-step ref tools cover click and text input. `browser_execute` additionally supports
  controlled hover, key presses, scrolling, navigation, waits and assertions. Arbitrary browser
  shortcuts, file upload and complex gestures are outside that helper surface.
- Generic pointer/text actions check same-origin iframe ancestors for overlays and focus changes.
  Unsupported transforms return a coverage gap; cross-origin ancestry is also blocked, with origin
  policy errors taking precedence when an origin is not allowed.
- The implementation does not call `Runtime.enable()` for the native CDP path. Fallback matching may use
  `Runtime.evaluate`, but it does not enable the Runtime domain. This avoids that specific detection point, not every
  possible anti-automation signal.
- `domainAllowlist`, `maxSnapshotNodes`, and `actionPolicy` from `BROWSER_SECURITY_JSON` still apply.
