#!/usr/bin/env node
/**
 * stdin: roll stdout (success tool JSON or isError envelope).
 * stdout: {"stop":false} | {"stop":true,"reason":"access_restricted"|"captcha"}
 */
import { extractLastJson, readStdinUtf8 } from "./roll-json-extract.mjs";
import { classifyZhipinRiskPage } from "./risk-paths.mjs";

const text = await readStdinUtf8();
const jsonText = extractLastJson(text);
if (!jsonText) {
  process.stdout.write(JSON.stringify({ stop: false }));
  process.exit(0);
}

let root;
try {
  root = JSON.parse(jsonText);
} catch {
  process.stdout.write(JSON.stringify({ stop: false }));
  process.exit(0);
}

const hit = findRestrictedCode(root, 0) ?? findPageStop(root);
process.stdout.write(JSON.stringify(hit ?? { stop: false }));

function classifyUrlTitle(url, title) {
  const hit = classifyZhipinRiskPage(url, title);
  if (hit === null) {
    return null;
  }
  return { stop: true, reason: hit.kind === "verify" ? "captcha" : "access_restricted" };
}

function reasonFromKind(kind) {
  return kind === "verify" ? "captcha" : "access_restricted";
}

function findRestrictedCode(value, depth) {
  if (depth > 10 || value == null) {
    return null;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
      try {
        return findRestrictedCode(JSON.parse(trimmed), depth + 1);
      } catch {
        return null;
      }
    }
    return null;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const hit = findRestrictedCode(item, depth + 1);
      if (hit) {
        return hit;
      }
    }
    return null;
  }
  if (typeof value !== "object") {
    return null;
  }
  if (value.code === "zhipin_access_restricted") {
    const kind =
      value.details && typeof value.details === "object" && !Array.isArray(value.details)
        ? value.details.kind
        : undefined;
    return { stop: true, reason: reasonFromKind(kind) };
  }
  for (const key of ["result", "payload", "details", "content", "text", "page"]) {
    if (!Object.hasOwn(value, key)) {
      continue;
    }
    const hit = findRestrictedCode(value[key], depth + 1);
    if (hit) {
      return hit;
    }
  }
  return null;
}

function findPageStop(root) {
  if (typeof root !== "object" || root === null || Array.isArray(root)) {
    return null;
  }
  const nodes = [root, root.result, root.page, root.details];
  if (root.result && typeof root.result === "object") {
    nodes.push(root.result.page, root.result.details);
  }
  for (const node of nodes) {
    if (typeof node !== "object" || node === null || Array.isArray(node)) {
      continue;
    }
    const hit = classifyUrlTitle(node.url ?? node.page?.url, node.title ?? node.page?.title);
    if (hit) {
      return hit;
    }
  }
  return null;
}
