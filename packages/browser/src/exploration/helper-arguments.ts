import { z } from "zod";
import { BrowserScriptError } from "./contracts.ts";

const signatures = {
  read: "Use page.read(target) and its .value for current input/textarea text; attribute is for supported HTML attributes. For a custom picker label, read .text and use a text expectation.",
  choose:
    "Use page.choose(target,{label}) or {value}. options.panel must be a CSS string in the target frame, not a locator object; obtain panelCss from page.inspectControl(target).",
  inspectControl:
    "Use page.inspectControl(target,{panel?}); options.panel must be a CSS string in the target frame, not a locator object.",
} as const;
type Helper = keyof typeof signatures;
const publicPaths = new Set([
  "attribute",
  "panel",
  "label",
  "value",
  "timeoutMs",
  "expect",
  "css",
  "ref",
  "snapshotId",
  "frameId",
  "role",
  "name",
  "scope",
]);

/** Only fixed API guidance crosses the worker boundary, never Zod's input/error text. */
export class BrowserHelperArgumentError extends BrowserScriptError {
  constructor(method: Helper, parameter: "target" | "options", issues: readonly z.ZodIssue[]) {
    const path = issues[0]?.path
      .filter((part): part is string => typeof part === "string" && publicPaths.has(part))
      .slice(0, 3)
      .join(".");
    super(
      "invalid_argument",
      `Invalid ${method} ${parameter}${path ? `.${path}` : ""}. ${parameter === "target" ? "Use page.ref(ref,snapshotId), page.locator(css,{frameId?}) or page.getByRole(role,{name,frameId?}). " : ""}${signatures[method]}`,
    );
  }
}

export function parseHelperArgument<T>(
  schema: z.ZodType<T, z.ZodTypeDef, unknown>,
  value: unknown,
  method: Helper,
  parameter: "target" | "options",
): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new BrowserHelperArgumentError(method, parameter, parsed.error.issues);
  return parsed.data;
}
