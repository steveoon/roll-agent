import { writeSync } from "node:fs";
import type { SessionEvent } from "@roll-agent/runtime";

export const TERMINAL_AGENT_OUTCOMES = {
  completed: "completed",
  cancelled: "cancelled",
  failed: "failed",
} as const;
export type TerminalAgentOutcome =
  (typeof TERMINAL_AGENT_OUTCOMES)[keyof typeof TERMINAL_AGENT_OUTCOMES];
export const TERMINAL_AGENT_WAIT_KINDS = {
  permission: "permission",
  question: "question",
} as const;
export type TerminalAgentWaitKind =
  (typeof TERMINAL_AGENT_WAIT_KINDS)[keyof typeof TERMINAL_AGENT_WAIT_KINDS];

export interface TerminalAgentTurn {
  wait(kind: TerminalAgentWaitKind): void;
  resume(): void;
  finish(outcome: TerminalAgentOutcome): void;
}
export interface TerminalAgentStatus {
  ready(): void;
  beginTurn(): TerminalAgentTurn;
  resetSession(): void;
  dispose(): void;
}
export interface TerminalAgentStatusOptions {
  readonly enabled: boolean;
  readonly write: (sequence: string) => void;
}
const OUTCOME_STATE = { completed: "done", cancelled: "idle", failed: "error" } as const;

/** A CLI-owned reporter. Turn handles cannot resurrect retired sessions or a disposed owner. */
export function createTerminalAgentStatus(
  options: TerminalAgentStatusOptions,
): TerminalAgentStatus {
  let enabled = options.enabled;
  let disposed = false;
  let generation = 0;
  let previous: string | undefined;
  const emit = (fields: string): void => {
    if (!enabled || disposed || previous === fields) return;
    try {
      options.write(`\u001B]7501;${fields}\u001B\\`);
      previous = fields;
    } catch {
      // Control reporting must never fail the user turn. No asynchronous stream writes.
      enabled = false;
    }
  };
  return {
    ready() {
      if (previous === undefined) emit("state=idle:app=roll");
    },
    beginTurn() {
      const mine = ++generation;
      let finished = false;
      const active = () => !disposed && !finished && mine === generation;
      emit("state=working:app=roll");
      return {
        wait(kind) {
          if (active()) emit(`state=blocked:kind=${kind}:app=roll`);
        },
        resume() {
          if (active()) emit("state=working:app=roll");
        },
        finish(outcome) {
          if (!active()) return;
          finished = true;
          emit(`state=${OUTCOME_STATE[outcome]}:app=roll`);
        },
      };
    },
    resetSession() {
      generation++;
      emit("state=idle:app=roll");
    },
    dispose() {
      if (disposed) return;
      emit("state=clear");
      disposed = true;
      generation++;
    },
  };
}

export interface TerminalAgentEnvironment {
  readonly interactive: boolean;
  readonly terminalId: string | undefined;
  readonly stdinTty: boolean | undefined;
  readonly stdoutTty: boolean | undefined;
  readonly stderrTty: boolean | undefined;
}
export function terminalAgentStatusEnabled(env: TerminalAgentEnvironment): boolean {
  return (
    env.interactive &&
    Boolean(env.terminalId?.trim()) &&
    env.stdinTty === true &&
    env.stdoutTty === true &&
    env.stderrTty === true
  );
}

/** Capture the actual TTY descriptor before Ink patches stream.write. Never uses Ink or logs. */
export function createInteractiveTerminalAgentStatus(interactive: boolean): TerminalAgentStatus {
  const fd = process.stderr.fd;
  return createTerminalAgentStatus({
    enabled: terminalAgentStatusEnabled({
      interactive,
      terminalId: process.env["HC_TERMINAL_ID"],
      stdinTty: process.stdin.isTTY,
      stdoutTty: process.stdout.isTTY,
      stderrTty: process.stderr.isTTY,
    }),
    write: (sequence) => {
      const bytes = Buffer.from(sequence);
      let offset = 0;
      while (offset < bytes.length) {
        const written = writeSync(fd, bytes, offset, bytes.length - offset);
        if (written === 0) throw new Error("TTY control write made no progress");
        offset += written;
      }
    },
  });
}

const CANCELLATION_OUTCOME = {
  user: "cancelled",
  timeout: "failed",
  runtime: "failed",
} as const satisfies Record<
  Extract<SessionEvent, { type: "turn-cancelled" }>["reason"],
  TerminalAgentOutcome
>;

/** Terminal outcomes are independent of UI phase and message-finish (persistence may still fail). */
export function terminalAgentOutcomeAfterEvent(
  outcome: TerminalAgentOutcome,
  event: SessionEvent,
): TerminalAgentOutcome {
  if (event.type === "error") return "failed";
  if (event.type === "turn-cancelled" && outcome !== "failed") {
    return CANCELLATION_OUTCOME[event.reason];
  }
  return outcome;
}
