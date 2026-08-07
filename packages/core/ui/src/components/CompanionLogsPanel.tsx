import { useCallback, useEffect, useRef, useState } from "react";
import type { RollUiApi } from "../api.ts";
import { appendCompanionLogText, limitCompanionLogLines } from "../lib/companion-state.ts";

export interface CompanionLogsPanelProps {
  readonly api: RollUiApi;
  readonly onToast: (toast: {
    readonly tone: "success" | "warning";
    readonly message: string;
  }) => void;
}

export function CompanionLogsPanel({ api, onToast }: CompanionLogsPanelProps) {
  const [text, setText] = useState("");
  const [paused, setPaused] = useState(false);
  const [streaming, setStreaming] = useState(false);
  const outputRef = useRef<HTMLPreElement>(null);

  const loadInitialLogs = useCallback(async () => {
    try {
      setText(limitCompanionLogLines(await api.getCompanionLogs()));
    } catch (error) {
      onToast({
        tone: "warning",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }, [api, onToast]);

  useEffect(() => {
    if (paused) {
      setStreaming(false);
      return;
    }
    let active = true;
    loadInitialLogs().catch(() => undefined);
    const close = api.openCompanionLogStream({
      onText: (chunk) => {
        if (!active) return;
        setStreaming(true);
        setText((current) => appendCompanionLogText(current, chunk));
      },
      onError: () => {
        if (active) setStreaming(false);
      },
    });
    return () => {
      active = false;
      close();
    };
  }, [api, loadInitialLogs, paused]);

  useEffect(() => {
    const output = outputRef.current;
    if (output === null || paused) return;
    output.scrollTop = output.scrollHeight;
  }, [text, paused]);

  return (
    <section className="companion-logs" aria-labelledby="companion-logs-title">
      <div className="panel-heading-row">
        <div>
          <p className="eyebrow">{streaming ? "LIVE TAIL" : "LOG TAIL"}</p>
          <h3 id="companion-logs-title">运行日志</h3>
        </div>
        <div className="companion-log-actions">
          <button
            type="button"
            className="secondary-button"
            aria-pressed={paused}
            onClick={() => setPaused((current) => !current)}
          >
            {paused ? "继续跟随" : "暂停"}
          </button>
          <button type="button" className="secondary-button" onClick={() => setText("")}>
            清屏
          </button>
        </div>
      </div>
      <pre className="companion-log-output" ref={outputRef} tabIndex={0} aria-live="off">
        {text.length === 0 ? "暂无日志。" : text}
      </pre>
    </section>
  );
}
