import { readFileSync } from "node:fs";

/** 读取并解析 JSON 文件，容忍 Windows 工具写入的 UTF-8 BOM */
export function readJsonFile(filePath: string): unknown {
  const raw = readFileSync(filePath, "utf-8");
  const text = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
  return JSON.parse(text) as unknown;
}
