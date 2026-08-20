import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";

export interface HintFlagStore {
  isShown(key: string): boolean;
  markShown(key: string): void;
}

export function createInMemoryHintFlagStore(): HintFlagStore {
  const shown = new Set<string>();
  return {
    isShown: (key) => shown.has(key),
    markShown: (key) => {
      shown.add(key);
    },
  };
}

function readShownFlags(filePath: string): Set<string> {
  let raw: string;
  try {
    raw = readFileSync(filePath, "utf8");
  } catch {
    return new Set();
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed !== null && typeof parsed === "object" && "shown" in parsed) {
      const shown = (parsed as { shown: unknown }).shown;
      if (Array.isArray(shown)) {
        return new Set(shown.filter((value): value is string => typeof value === "string"));
      }
    }
  } catch {
    return new Set();
  }
  return new Set();
}

export function defaultHintFlagPath(): string {
  return resolve(homedir(), ".roll-agent", "chat-hints.json");
}

export function createFileHintFlagStore(filePath = defaultHintFlagPath()): HintFlagStore {
  const shown = readShownFlags(filePath);
  return {
    isShown: (key) => shown.has(key),
    markShown: (key) => {
      if (shown.has(key)) {
        return;
      }
      shown.add(key);
      try {
        mkdirSync(dirname(filePath), { recursive: true });
        writeFileSync(filePath, JSON.stringify({ shown: [...shown] }));
      } catch {
        shown.delete(key);
      }
    },
  };
}
