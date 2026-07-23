import { test } from "node:test";
import assert from "node:assert/strict";
import type { ChatTerminalCapabilities } from "./screen-mode.ts";
import {
  CHAT_MULTIPLEXERS,
  CHAT_PRESENTATIONS,
  detectChatTerminalCapabilities,
  isCiEnvironment,
  resolveChatPresentation,
  resolveChatScreenModeRequest,
} from "./screen-mode.ts";

function capabilities(overrides: Partial<ChatTerminalCapabilities> = {}): ChatTerminalCapabilities {
  return {
    stdinIsTty: true,
    stdoutIsTty: true,
    rawModeSupported: true,
    interactive: true,
    ci: false,
    dumbTerminal: false,
    screenReader: false,
    multiplexer: CHAT_MULTIPLEXERS.none,
    ...overrides,
  };
}

test("isCiEnvironment follows Ink-compatible CI flag semantics", () => {
  assert.equal(isCiEnvironment({}), false);
  assert.equal(isCiEnvironment({ CI: "1" }), true);
  assert.equal(isCiEnvironment({ CONTINUOUS_INTEGRATION: "true" }), true);
  assert.equal(isCiEnvironment({ CI: "false", CONTINUOUS_INTEGRATION: "0" }), false);
});

test("detectChatTerminalCapabilities distinguishes tmux control mode", async () => {
  const detected = await detectChatTerminalCapabilities({
    stdinIsTty: true,
    stdoutIsTty: true,
    rawModeSupported: true,
    env: { TMUX: "/tmp/tmux-501/default,123,0" },
    readTmuxClientFlags: async () => "utf8,control-mode",
  });

  assert.equal(detected.interactive, true);
  assert.equal(detected.multiplexer, CHAT_MULTIPLEXERS.tmuxControl);
});

test("detectChatTerminalCapabilities safely classifies unknown tmux state", async () => {
  const detected = await detectChatTerminalCapabilities({
    stdinIsTty: true,
    stdoutIsTty: true,
    rawModeSupported: true,
    env: { TMUX: "/tmp/tmux-501/default,123,0", ZELLIJ: "session-id" },
    readTmuxClientFlags: async () => undefined,
  });

  assert.equal(detected.multiplexer, CHAT_MULTIPLEXERS.tmuxUnknown);
});

test("detectChatTerminalCapabilities recognizes Zellij outside tmux", async () => {
  const detected = await detectChatTerminalCapabilities({
    stdinIsTty: true,
    stdoutIsTty: true,
    rawModeSupported: true,
    env: { ZELLIJ: "session-id" },
  });

  assert.equal(detected.multiplexer, CHAT_MULTIPLEXERS.zellij);
});

test("detectChatTerminalCapabilities recognizes dumb and screen-reader terminals", async () => {
  const detected = await detectChatTerminalCapabilities({
    stdinIsTty: true,
    stdoutIsTty: true,
    rawModeSupported: true,
    env: { TERM: "dumb", INK_SCREEN_READER: "true" },
  });

  assert.equal(detected.dumbTerminal, true);
  assert.equal(detected.screenReader, true);
});

test("resolveChatScreenModeRequest applies CLI over config", () => {
  assert.deepEqual(
    resolveChatScreenModeRequest({
      configMode: "inline",
      cliValue: "fullscreen",
      messagePresent: false,
      json: false,
      server: false,
      list: false,
    }),
    { ok: true, mode: "fullscreen", source: "cli" },
  );
  assert.deepEqual(
    resolveChatScreenModeRequest({
      configMode: "inline",
      messagePresent: false,
      json: false,
      server: false,
      list: false,
    }),
    { ok: true, mode: "inline", source: "config" },
  );
});

test("resolveChatScreenModeRequest rejects invalid values and non-interactive surfaces", () => {
  const invalid = resolveChatScreenModeRequest({
    configMode: "auto",
    cliValue: "wide",
    messagePresent: false,
    json: false,
    server: false,
    list: false,
  });
  const conflicting = resolveChatScreenModeRequest({
    configMode: "auto",
    cliValue: "inline",
    messagePresent: true,
    json: true,
    server: false,
    list: false,
  });

  assert.equal(invalid.ok, false);
  assert.match(invalid.ok ? "" : invalid.error, /auto、fullscreen、inline/);
  assert.equal(conflicting.ok, false);
  assert.match(conflicting.ok ? "" : conflicting.error, /message、--json/);
});

test("auto selects fullscreen only for safe interactive terminals", () => {
  const cases = [
    [capabilities(), CHAT_PRESENTATIONS.fullscreen, "auto"],
    [capabilities({ multiplexer: CHAT_MULTIPLEXERS.tmux }), CHAT_PRESENTATIONS.fullscreen, "auto"],
    [
      capabilities({ multiplexer: CHAT_MULTIPLEXERS.tmuxUnknown }),
      CHAT_PRESENTATIONS.inline,
      "tmux-unknown",
    ],
    [capabilities({ ci: true }), CHAT_PRESENTATIONS.inline, "ci"],
    [capabilities({ dumbTerminal: true }), CHAT_PRESENTATIONS.inline, "dumb-terminal"],
    [capabilities({ screenReader: true }), CHAT_PRESENTATIONS.inline, "screen-reader"],
    [
      capabilities({ multiplexer: CHAT_MULTIPLEXERS.tmuxControl }),
      CHAT_PRESENTATIONS.inline,
      "tmux-control",
    ],
    [capabilities({ multiplexer: CHAT_MULTIPLEXERS.zellij }), CHAT_PRESENTATIONS.inline, "zellij"],
    [
      capabilities({ stdinIsTty: false, interactive: false }),
      CHAT_PRESENTATIONS.inline,
      "non-interactive",
    ],
  ] as const;

  for (const [terminal, presentation, reason] of cases) {
    const decision = resolveChatPresentation({
      mode: "auto",
      source: "config",
      capabilities: terminal,
    });
    assert.equal(decision.ok, true);
    if (decision.ok) {
      assert.equal(decision.presentation, presentation);
      assert.equal(decision.reason, reason);
    }
  }
});

test("explicit fullscreen overrides CI and multiplexer safety when TTY capabilities exist", () => {
  const decision = resolveChatPresentation({
    mode: "fullscreen",
    source: "cli",
    capabilities: capabilities({
      ci: true,
      multiplexer: CHAT_MULTIPLEXERS.tmuxControl,
    }),
  });

  assert.deepEqual(decision, {
    ok: true,
    presentation: CHAT_PRESENTATIONS.fullscreen,
    reason: "requested",
  });
});

test("forced fullscreen errors for CLI but warns and falls back for config", () => {
  const terminal = capabilities({
    stdinIsTty: false,
    stdoutIsTty: false,
    rawModeSupported: false,
    interactive: false,
  });
  const cliDecision = resolveChatPresentation({
    mode: "fullscreen",
    source: "cli",
    capabilities: terminal,
  });
  const configDecision = resolveChatPresentation({
    mode: "fullscreen",
    source: "config",
    capabilities: terminal,
  });

  assert.equal(cliDecision.ok, false);
  assert.match(cliDecision.ok ? "" : cliDecision.error, /stdin TTY、stdout TTY、raw mode/);
  assert.equal(configDecision.ok, true);
  if (configDecision.ok) {
    assert.equal(configDecision.presentation, CHAT_PRESENTATIONS.inline);
    assert.match(configDecision.warning ?? "", /已回退基础 REPL/);
  }
});
