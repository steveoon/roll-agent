import { useEffect, useRef } from "react";

interface ScheduleExtensionDialogProps {
  readonly open: boolean;
  readonly description: string;
  readonly onDecision: (approved: boolean) => void;
}

export function ScheduleExtensionDialog({
  open,
  description,
  onDecision,
}: ScheduleExtensionDialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog === null) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  return (
    <dialog
      ref={dialogRef}
      className="apply-dialog schedule-extension-dialog"
      aria-labelledby="schedule-extension-dialog-title"
      aria-describedby="schedule-extension-dialog-description"
      onCancel={(event) => {
        event.preventDefault();
        onDecision(false);
      }}
      onClose={() => {
        if (open) onDecision(false);
      }}
    >
      <div className="dialog-stripe" />
      <p className="eyebrow">SCHEDULE</p>
      <h2 id="schedule-extension-dialog-title">确认追加轮数</h2>
      <p id="schedule-extension-dialog-description" className="schedule-extension-details">
        {description}
      </p>
      <div className="dialog-actions">
        <button type="button" className="secondary-button" onClick={() => onDecision(false)}>
          取消
        </button>
        <button type="button" className="primary-button" onClick={() => onDecision(true)}>
          确认并继续任务
        </button>
      </div>
    </dialog>
  );
}
