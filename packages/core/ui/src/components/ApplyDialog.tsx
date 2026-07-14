import { useEffect, useRef } from "react";
import type { ConfigActivationEffect } from "../types.ts";

interface ApplyDialogProps {
  readonly open: boolean;
  readonly effects: readonly ConfigActivationEffect[];
  readonly busy: boolean;
  readonly onCancel: () => void;
  readonly onSaveOnly: () => void;
  readonly onConfirm: () => void;
}

export function ApplyDialog({
  open,
  effects,
  busy,
  onCancel,
  onSaveOnly,
  onConfirm,
}: ApplyDialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog === null) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  const restartEffects = effects.filter((effect) => effect.kind === "restart-agent");
  const manualEffects = effects.filter((effect) => effect.kind === "manual");
  const canDeferActivation = restartEffects.length > 0 || manualEffects.length > 0;
  const changedPathCount = effects.flatMap((effect) => effect.paths).length;
  return (
    <dialog
      ref={dialogRef}
      className="apply-dialog"
      aria-labelledby="apply-dialog-title"
      aria-describedby="apply-dialog-description"
      onCancel={(event) => {
        event.preventDefault();
        if (!busy) onCancel();
      }}
      onClose={() => {
        if (!busy) onCancel();
      }}
    >
      <div className="dialog-stripe" />
      <p className="eyebrow">REVIEW + SAVE</p>
      <h2 id="apply-dialog-title">
        {changedPathCount > 0
          ? `确认保存 ${String(changedPathCount)} 项修改`
          : "确认保存 YAML 草稿"}
      </h2>
      <p id="apply-dialog-description">
        配置会先原子写入并备份原文件。下面逐项说明保存后的生效方式；只有当前正在运行的 core-managed
        Agent 会自动重启，已停止的 Agent 保持停止。
      </p>
      <div className="dialog-effect-list">
        {effects.length === 0 && (
          <div>
            <span className="status-dot ok" />
            <span>
              <strong>仅注释或格式发生变化</strong>
              <small>保存不会改变 Roll 的运行时配置，也不需要重启 Agent。</small>
            </span>
          </div>
        )}
        {effects.map((effect) => (
          <div className={effect.kind === "manual" ? "manual" : undefined} key={effect.title}>
            {effect.kind === "manual" ? (
              <span>!</span>
            ) : (
              <span className={`status-dot ${effect.kind === "restart-agent" ? "warn" : "ok"}`} />
            )}
            <span>
              <strong>{effect.title}</strong>
              <small>{effect.description}</small>
            </span>
          </div>
        ))}
      </div>
      {manualEffects.length > 0 && (
        <div className="manual-warning">
          人工步骤不会由 Web UI 自动执行；保存后请按提示完成迁移。
        </div>
      )}
      <div className="dialog-actions">
        <button type="button" className="secondary-button" disabled={busy} onClick={onCancel}>
          返回继续编辑
        </button>
        {canDeferActivation && (
          <button type="button" className="secondary-button" disabled={busy} onClick={onSaveOnly}>
            仅保存，稍后生效
          </button>
        )}
        <button type="button" className="primary-button" disabled={busy} onClick={onConfirm}>
          {busy
            ? "正在保存并处理…"
            : primaryActionLabel(restartEffects.length, manualEffects.length)}
        </button>
      </div>
    </dialog>
  );
}

function primaryActionLabel(restartCount: number, manualCount: number): string {
  if (restartCount > 0 && manualCount > 0) return "保存、重启并查看步骤";
  if (restartCount > 0) return `保存并重启 ${String(restartCount)} 个 Agent`;
  if (manualCount > 0) return "保存并查看人工步骤";
  return "确认保存配置";
}
