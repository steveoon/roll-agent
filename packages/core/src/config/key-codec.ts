export type KeyCodecNode =
  | { readonly kind: "object"; readonly fields: Readonly<Record<string, KeyCodecNode>> }
  | { readonly kind: "record"; readonly value: KeyCodecNode }
  | { readonly kind: "leaf" };

const LEAF: KeyCodecNode = { kind: "leaf" };

const PROVIDER_NODE: KeyCodecNode = {
  kind: "object",
  fields: {
    apiKey: LEAF,
    baseUrl: LEAF,
  },
};

const BROWSER_INSTANCE_NODE: KeyCodecNode = {
  kind: "object",
  fields: {
    platform: LEAF,
    mode: LEAF,
    headless: LEAF,
    cdpUrl: LEAF,
    cdpHost: LEAF,
    cdpPort: LEAF,
    channel: LEAF,
    executablePath: LEAF,
    userDataDir: LEAF,
    sessionsDir: LEAF,
    args: LEAF,
    profileName: LEAF,
    profileColor: LEAF,
    windowBounds: {
      kind: "object",
      fields: {
        x: LEAF,
        y: LEAF,
        width: LEAF,
        height: LEAF,
      },
    },
    trackingAgentId: LEAF,
  },
};

export const CONFIG_KEY_CODEC: KeyCodecNode = {
  kind: "object",
  fields: {
    llm: {
      kind: "object",
      fields: {
        defaultProvider: LEAF,
        defaultModel: LEAF,
        providers: {
          kind: "record",
          value: PROVIDER_NODE,
        },
      },
    },
    ask: {
      kind: "object",
      fields: {
        llmModel: LEAF,
        confirmThreshold: LEAF,
      },
    },
    runtime: {
      kind: "object",
      fields: {
        provider: LEAF,
        model: LEAF,
        maxSteps: LEAF,
        turnTimeoutMs: LEAF,
        threadsDir: LEAF,
        contextWindow: LEAF,
        approval: {
          kind: "object",
          fields: {
            default: LEAF,
            overrides: {
              kind: "record",
              value: LEAF,
            },
          },
        },
        compaction: {
          kind: "object",
          fields: {
            enabled: LEAF,
            strategy: LEAF,
            threshold: LEAF,
            keepRecentTurns: LEAF,
            keepRecentTokens: LEAF,
          },
        },
      },
    },
    agents: {
      kind: "object",
      fields: {
        dataDir: LEAF,
        env: {
          kind: "record",
          value: {
            kind: "record",
            value: LEAF,
          },
        },
      },
    },
    install: {
      kind: "object",
      fields: {
        registry: LEAF,
        fetchRetries: LEAF,
        preferOffline: LEAF,
        networkTimeoutMs: LEAF,
      },
    },
    browser: {
      kind: "object",
      fields: {
        defaultInstance: LEAF,
        instances: {
          kind: "record",
          value: BROWSER_INSTANCE_NODE,
        },
      },
    },
  },
};

export function kebabToCamel(key: string): string {
  return key.replace(/-([a-z])/g, (_, ch: string) => ch.toUpperCase());
}

export function camelToKebab(key: string): string {
  return key.replace(/[A-Z]/g, (ch) => `-${ch.toLowerCase()}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function decodeFromYaml(value: unknown, node: KeyCodecNode = CONFIG_KEY_CODEC): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => decodeFromYaml(item, node));
  }
  if (!isRecord(value)) {
    return value;
  }

  if (node.kind === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
      const camelKey = kebabToCamel(key);
      const childNode = node.fields[camelKey] ?? LEAF;
      result[camelKey] = decodeFromYaml(child, childNode);
    }
    return result;
  }

  if (node.kind === "record") {
    const result: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
      result[key] = decodeFromYaml(child, node.value);
    }
    return result;
  }

  return value;
}

function walkUserPath(parts: readonly string[], objectKeyOutput: "camel" | "kebab"): string[] {
  const result: string[] = [];
  let current: KeyCodecNode = CONFIG_KEY_CODEC;

  for (const part of parts) {
    if (current.kind === "object") {
      const camelKey = kebabToCamel(part);
      const childNode = current.fields[camelKey];
      if (childNode) {
        result.push(objectKeyOutput === "camel" ? camelKey : camelToKebab(camelKey));
        current = childNode;
      } else {
        result.push(part);
        current = LEAF;
      }
    } else if (current.kind === "record") {
      result.push(part);
      current = current.value;
    } else {
      result.push(part);
    }
  }

  return result;
}

export function encodePathToYaml(parts: readonly string[]): string[] {
  return walkUserPath(parts, "kebab");
}

export function normalizeUserPath(parts: readonly string[]): string[] {
  return walkUserPath(parts, "camel");
}
