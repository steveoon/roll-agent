import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { sanitizeInstallId } from "./source.ts";

export interface RemoteManifestInput {
  readonly dataDir: string;
  readonly name: string;
  readonly description: string;
  readonly endpoint: string;
}

function yamlString(value: string): string {
  return JSON.stringify(value);
}

/** 为远程 MCP Agent 生成本地 manifest 目录，便于后续统一管理。 */
export function writeRemoteSkillManifest(input: RemoteManifestInput): string {
  const targetDir = resolve(input.dataDir, "remote", sanitizeInstallId(input.name));
  mkdirSync(targetDir, { recursive: true });

  const skillMd = `---
name: ${yamlString(input.name)}
description: ${yamlString(input.description)}
metadata:
  roll-transport: streamable-http
  roll-endpoint: ${yamlString(input.endpoint)}
---

Remote MCP Agent registered via \`roll agent add --remote\`.
`;

  writeFileSync(resolve(targetDir, "SKILL.md"), skillMd, "utf-8");
  return targetDir;
}
