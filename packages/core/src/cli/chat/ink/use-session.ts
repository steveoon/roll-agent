import { randomUUID } from "node:crypto";
import { useCallback, useReducer, useRef } from "react";
import type { AgentSession, SessionEvent } from "@roll-agent/runtime";
import { chatReducer, createInitialState, type ChatUiState } from "./state.ts";
import { log } from "../../utils/output.ts";

export interface UseSessionResult {
  readonly state: ChatUiState;
  readonly submit: (text: string) => void;
  readonly compact: () => void;
  readonly resolveConfirm: (approved: boolean) => void;
}

const TEXT_FLUSH_MS = 32;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function useSession(
  session: AgentSession,
  model: string,
  contextWindow: number | undefined,
): UseSessionResult {
  const [state, dispatch] = useReducer(chatReducer, createInitialState(model, contextWindow));
  const decisionRef = useRef<((approved: boolean) => void) | null>(null);
  const busyRef = useRef(false);

  const drive = useCallback(
    async (iterable: AsyncIterable<SessionEvent>) => {
      let pendingText = "";
      let flushTimer: ReturnType<typeof setTimeout> | undefined;
      const flushPending = () => {
        if (flushTimer !== undefined) {
          clearTimeout(flushTimer);
          flushTimer = undefined;
        }
        if (pendingText.length > 0) {
          const delta = pendingText;
          pendingText = "";
          dispatch({
            type: "session-event",
            id: randomUUID(),
            event: { type: "text-delta", delta },
          });
        }
      };
      try {
        for await (const event of iterable) {
          if (event.type === "debug") {
            log.debug(`chat.${event.stage} ${event.message}`);
            continue;
          }
          if (event.type === "text-delta") {
            pendingText += event.delta;
            if (flushTimer === undefined) {
              flushTimer = setTimeout(flushPending, TEXT_FLUSH_MS);
            }
            continue;
          }
          flushPending();
          if (event.type === "confirmation-required") {
            dispatch({ type: "session-event", id: randomUUID(), event });
            const approved = await new Promise<boolean>((resolve) => {
              decisionRef.current = resolve;
            });
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

  const resolveConfirm = useCallback((approved: boolean) => {
    decisionRef.current?.(approved);
  }, []);

  return { state, submit, compact, resolveConfirm };
}
