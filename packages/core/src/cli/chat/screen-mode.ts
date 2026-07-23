import { execFile } from "node:child_process";
import {
  CHAT_SCREEN_MODES,
  chatScreenModeSchema,
  type ChatScreenMode,
} from "../../config/schema.ts";

export const CHAT_PRESENTATIONS = {
  fullscreen: "fullscreen",
  inline: "inline",
} as const;

export type ChatPresentation = (typeof CHAT_PRESENTATIONS)[keyof typeof CHAT_PRESENTATIONS];

export const CHAT_MULTIPLEXERS = {
  none: "none",
  tmux: "tmux",
  tmuxControl: "tmux-control",
  tmuxUnknown: "tmux-unknown",
  zellij: "zellij",
} as const;

export type ChatMultiplexer = (typeof CHAT_MULTIPLEXERS)[keyof typeof CHAT_MULTIPLEXERS];

export type ChatScreenModeSource = "cli" | "config";

export interface ChatTerminalCapabilities {
  readonly stdinIsTty: boolean;
  readonly stdoutIsTty: boolean;
  readonly rawModeSupported: boolean;
  readonly interactive: boolean;
  readonly ci: boolean;
  readonly dumbTerminal: boolean;
  readonly screenReader: boolean;
  readonly multiplexer: ChatMultiplexer;
}

export interface DetectChatTerminalCapabilitiesInput {
  readonly stdinIsTty: boolean;
  readonly stdoutIsTty: boolean;
  readonly rawModeSupported: boolean;
  readonly env: NodeJS.ProcessEnv;
  readonly readTmuxClientFlags?: () => Promise<string | undefined>;
}

export interface ResolveChatScreenModeRequestInput {
  readonly configMode: ChatScreenMode;
  readonly cliValue?: string;
  readonly messagePresent: boolean;
  readonly json: boolean;
  readonly server: boolean;
  readonly list: boolean;
}

export type ChatScreenModeRequest =
  | {
      readonly ok: true;
      readonly mode: ChatScreenMode;
      readonly source: ChatScreenModeSource;
    }
  | {
      readonly ok: false;
      readonly error: string;
    };

export type ChatPresentationDecision =
  | {
      readonly ok: true;
      readonly presentation: ChatPresentation;
      readonly reason:
        | "requested"
        | "auto"
        | "non-interactive"
        | "ci"
        | "dumb-terminal"
        | "screen-reader"
        | "tmux-control"
        | "tmux-unknown"
        | "zellij";
      readonly warning?: string;
    }
  | {
      readonly ok: false;
      readonly error: string;
    };

function envFlagEnabled(env: NodeJS.ProcessEnv, key: string): boolean {
  const value = env[key];
  return value !== undefined && value !== "0" && value !== "false";
}

export function isCiEnvironment(env: NodeJS.ProcessEnv): boolean {
  return envFlagEnabled(env, "CI") || envFlagEnabled(env, "CONTINUOUS_INTEGRATION");
}

function isTmuxControlMode(clientFlags: string | undefined): boolean {
  if (clientFlags === undefined) {
    return false;
  }
  const flags = clientFlags.split(",").map((flag) => flag.trim());
  return flags.includes("control") || flags.includes("control-mode");
}

export function readCurrentTmuxClientFlags(): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile(
      "tmux",
      ["display-message", "-p", "#{client_flags}"],
      { encoding: "utf8", timeout: 250, maxBuffer: 4_096, windowsHide: true },
      (error, stdout) => {
        resolve(error ? undefined : stdout.trim());
      },
    );
  });
}

export async function detectChatTerminalCapabilities(
  input: DetectChatTerminalCapabilitiesInput,
): Promise<ChatTerminalCapabilities> {
  let multiplexer: ChatMultiplexer = CHAT_MULTIPLEXERS.none;
  if (input.env.TMUX) {
    const clientFlags = await (input.readTmuxClientFlags ?? readCurrentTmuxClientFlags)();
    multiplexer =
      clientFlags === undefined
        ? CHAT_MULTIPLEXERS.tmuxUnknown
        : isTmuxControlMode(clientFlags)
          ? CHAT_MULTIPLEXERS.tmuxControl
          : CHAT_MULTIPLEXERS.tmux;
  } else if (input.env.ZELLIJ) {
    multiplexer = CHAT_MULTIPLEXERS.zellij;
  }

  return {
    stdinIsTty: input.stdinIsTty,
    stdoutIsTty: input.stdoutIsTty,
    rawModeSupported: input.rawModeSupported,
    interactive: input.stdinIsTty && input.stdoutIsTty && input.rawModeSupported,
    ci: isCiEnvironment(input.env),
    dumbTerminal: input.env.TERM?.toLowerCase() === "dumb",
    screenReader: input.env.INK_SCREEN_READER === "true",
    multiplexer,
  };
}

export function resolveChatScreenModeRequest(
  input: ResolveChatScreenModeRequestInput,
): ChatScreenModeRequest {
  if (input.cliValue === undefined) {
    return { ok: true, mode: input.configMode, source: "config" };
  }

  const parsed = chatScreenModeSchema.safeParse(input.cliValue);
  if (!parsed.success) {
    return {
      ok: false,
      error: `--screen-mode 仅支持 ${CHAT_SCREEN_MODES.join("、")}`,
    };
  }

  const conflicts = [
    input.messagePresent ? "message" : undefined,
    input.json ? "--json" : undefined,
    input.server ? "--server" : undefined,
    input.list ? "--list" : undefined,
  ].filter((value): value is string => value !== undefined);
  if (conflicts.length > 0) {
    return {
      ok: false,
      error: `--screen-mode 仅适用于无起始消息的交互式 roll chat，不能与 ${conflicts.join("、")} 同用`,
    };
  }

  return { ok: true, mode: parsed.data, source: "cli" };
}

function formatMissingInteractiveCapabilities(capabilities: ChatTerminalCapabilities): string {
  const missing = [
    capabilities.stdinIsTty ? undefined : "stdin TTY",
    capabilities.stdoutIsTty ? undefined : "stdout TTY",
    capabilities.rawModeSupported ? undefined : "raw mode",
  ].filter((value): value is string => value !== undefined);
  return missing.join("、");
}

export function resolveChatPresentation(input: {
  readonly mode: ChatScreenMode;
  readonly source: ChatScreenModeSource;
  readonly capabilities: ChatTerminalCapabilities;
}): ChatPresentationDecision {
  if (input.mode === "inline") {
    return { ok: true, presentation: CHAT_PRESENTATIONS.inline, reason: "requested" };
  }

  if (input.mode === "fullscreen") {
    if (input.capabilities.interactive) {
      return { ok: true, presentation: CHAT_PRESENTATIONS.fullscreen, reason: "requested" };
    }

    const missing = formatMissingInteractiveCapabilities(input.capabilities);
    if (input.source === "cli") {
      return {
        ok: false,
        error: `--screen-mode fullscreen 需要交互式终端，当前缺少：${missing}`,
      };
    }
    return {
      ok: true,
      presentation: CHAT_PRESENTATIONS.inline,
      reason: "non-interactive",
      warning: `chat.screen-mode=fullscreen 需要交互式终端，当前缺少 ${missing}；已回退基础 REPL`,
    };
  }

  if (!input.capabilities.interactive) {
    return { ok: true, presentation: CHAT_PRESENTATIONS.inline, reason: "non-interactive" };
  }
  if (input.capabilities.ci) {
    return { ok: true, presentation: CHAT_PRESENTATIONS.inline, reason: "ci" };
  }
  if (input.capabilities.dumbTerminal) {
    return { ok: true, presentation: CHAT_PRESENTATIONS.inline, reason: "dumb-terminal" };
  }
  if (input.capabilities.screenReader) {
    return { ok: true, presentation: CHAT_PRESENTATIONS.inline, reason: "screen-reader" };
  }
  if (input.capabilities.multiplexer === CHAT_MULTIPLEXERS.tmuxControl) {
    return { ok: true, presentation: CHAT_PRESENTATIONS.inline, reason: "tmux-control" };
  }
  if (input.capabilities.multiplexer === CHAT_MULTIPLEXERS.tmuxUnknown) {
    return { ok: true, presentation: CHAT_PRESENTATIONS.inline, reason: "tmux-unknown" };
  }
  if (input.capabilities.multiplexer === CHAT_MULTIPLEXERS.zellij) {
    return { ok: true, presentation: CHAT_PRESENTATIONS.inline, reason: "zellij" };
  }
  return { ok: true, presentation: CHAT_PRESENTATIONS.fullscreen, reason: "auto" };
}
