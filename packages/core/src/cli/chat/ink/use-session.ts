import { randomUUID } from "node:crypto";
import { useCallback, useReducer, useRef } from "react";
import type { AgentSession, SessionEvent } from "@roll-agent/runtime";
import { chatReducer, createInitialState, type ChatUiState, type HistoryItem } from "./state.ts";
import type { ThinkingLevel } from "../../../llm/providers.ts";
import { log } from "../../utils/output.ts";
import { formatDebugEvent } from "../../utils/debug-format.ts";

export interface UseSessionOptions {
  readonly model: string;
  readonly contextWindow: number | undefined;
  readonly initialHistory?: readonly HistoryItem[];
  readonly initialThinkingLevel?: ThinkingLevel;
  readonly onThinkingChange?: (level: ThinkingLevel) => void;
}

export interface UseSessionResult {
  readonly state: ChatUiState;
  readonly submit: (text: string, sendText?: string) => void;
  readonly compact: () => void;
  readonly cancel: () => void;
  readonly resolveConfirm: (approved: boolean) => void;
  readonly setDraft: (value: string) => void;
  readonly setThinking: (level: ThinkingLevel) => void;
  readonly setAutoMode: (value: boolean) => void;
  readonly toggleAutoMode: () => void;
  readonly commitHistory: (item: HistoryItem) => void;
}

const STREAM_FLUSH_MS = 32;

type StreamDeltaEvent = Extract<SessionEvent, { type: "text-delta" | "reasoning-delta" }>;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function useSession(session: AgentSession, options: UseSessionOptions): UseSessionResult {
  const [state, dispatch] = useReducer(
    chatReducer,
    createInitialState(options.model, options.contextWindow, {
      ...(options.initialHistory ? { history: options.initialHistory } : {}),
      ...(options.initialThinkingLevel ? { thinkingLevel: options.initialThinkingLevel } : {}),
    }),
  );
  const onThinkingChange = options.onThinkingChange;
  const decisionRef = useRef<((approved: boolean) => void) | null>(null);
  const autoModeRef = useRef(false);
  const busyRef = useRef(false);

  const drive = useCallback(
    async (iterable: AsyncIterable<SessionEvent>) => {
      let pendingDelta: StreamDeltaEvent | undefined;
      let flushTimer: ReturnType<typeof setTimeout> | undefined;
      const flushPending = () => {
        if (flushTimer !== undefined) {
          clearTimeout(flushTimer);
          flushTimer = undefined;
        }
        if (pendingDelta !== undefined) {
          const event = pendingDelta;
          pendingDelta = undefined;
          dispatch({
            type: "session-event",
            id: randomUUID(),
            event,
          });
        }
      };
      const bufferDelta = (event: StreamDeltaEvent): void => {
        if (pendingDelta === undefined) {
          pendingDelta = event;
        } else if (pendingDelta.type === "text-delta" && event.type === "text-delta") {
          pendingDelta = { type: "text-delta", delta: pendingDelta.delta + event.delta };
        } else if (
          pendingDelta.type === "reasoning-delta" &&
          event.type === "reasoning-delta" &&
          pendingDelta.reasoningId === event.reasoningId
        ) {
          pendingDelta = {
            type: "reasoning-delta",
            reasoningId: event.reasoningId,
            delta: pendingDelta.delta + event.delta,
          };
        } else {
          flushPending();
          pendingDelta = event;
        }
        if (flushTimer === undefined) {
          flushTimer = setTimeout(flushPending, STREAM_FLUSH_MS);
        }
      };
      try {
        for await (const event of iterable) {
          if (event.type === "debug") {
            log.debug(formatDebugEvent(event));
            continue;
          }
          if (event.type === "text-delta" || event.type === "reasoning-delta") {
            bufferDelta(event);
            continue;
          }
          flushPending();
          if (event.type === "confirmation-required") {
            if (autoModeRef.current) {
              session.approve(event.approvalId);
              continue;
            }
            const approvedPromise = new Promise<boolean>((resolve) => {
              decisionRef.current = resolve;
            });
            dispatch({ type: "session-event", id: randomUUID(), event });
            const approved = await approvedPromise;
            decisionRef.current = null;
            if (approved) {
              session.approve(event.approvalId);
            } else {
              session.reject(event.approvalId, "用户取消");
            }
            dispatch({ type: "confirm-resolved" });
            continue;
          }
          dispatch({ type: "session-event", id: randomUUID(), event });
        }
      } catch (error) {
        flushPending();
        dispatch({
          type: "session-event",
          id: randomUUID(),
          event: { type: "error", stage: "execute", message: errorMessage(error) },
        });
      } finally {
        flushPending();
        dispatch({ type: "turn-end" });
        busyRef.current = false;
      }
    },
    [session],
  );

  const submit = useCallback(
    (text: string) => {
      if (busyRef.current) {
        return;
      }
      busyRef.current = true;
      dispatch({ type: "submit-user", id: randomUUID(), text });
      drive(session.send(text)).catch(() => undefined);
    },
    [drive, session],
  );

  const compact = useCallback(() => {
    if (busyRef.current) {
      return;
    }
    busyRef.current = true;
    dispatch({ type: "start-compaction" });
    drive(session.compact("manual")).catch(() => undefined);
  }, [drive, session]);

  const cancel = useCallback(() => {
    if (!busyRef.current) {
      return;
    }
    if (session.cancel()) {
      dispatch({ type: "cancel-requested" });
    }
  }, [session]);

  const resolveConfirm = useCallback((approved: boolean) => {
    decisionRef.current?.(approved);
  }, []);

  const setDraft = useCallback((value: string) => {
    dispatch({ type: "set-draft", value });
  }, []);

  const setThinking = useCallback(
    (level: ThinkingLevel) => {
      dispatch({ type: "set-thinking", level });
      onThinkingChange?.(level);
    },
    [onThinkingChange],
  );

  const setAutoMode = useCallback((value: boolean) => {
    autoModeRef.current = value;
    dispatch({ type: "set-auto", value });
    if (value) {
      decisionRef.current?.(true);
    }
  }, []);

  const toggleAutoMode = useCallback(() => {
    setAutoMode(!autoModeRef.current);
  }, [setAutoMode]);

  const commitHistory = useCallback((item: HistoryItem) => {
    dispatch({ type: "commit-history", item });
  }, []);

  return {
    state,
    submit,
    compact,
    cancel,
    resolveConfirm,
    setDraft,
    setThinking,
    setAutoMode,
    toggleAutoMode,
    commitHistory,
  };
}
