import { createFormLoopProgress, observeFormLoopProgress } from "./form-loop-progress.ts";
import {
  createInteractionFeedback,
  observeInteractionFeedback,
  recordInteractionAttempt,
  withInteractionFeedback,
  acceptInteractionFeedback,
} from "./interaction-feedback.ts";
import { createHash } from "node:crypto";
import {
  createExecutionContext,
  observeExecution,
  executionSummary,
  recordExecutionAction,
} from "./execution-context.ts";
import { acceptFormDecisions, formReady, formActionOwner } from "./form-policy.ts";
import {
  acceptProgressEvidence,
  progressSummary,
  terminalObservationMatches,
} from "./task-progress-policy.ts";
import { setTimeout as delay } from "node:timers/promises";
import type { BrowserOperateInput, BrowserOperateOutput } from "./contracts.ts";
import type { DecisionProvider } from "./decisions.ts";
import { validateChoices } from "./decisions.ts";
import type { GoalDriver } from "./loop.ts";
import type { GoalSnapshot } from "./observation.ts";
import {
  buildTaskDecisionRequest,
  taskControlIdentity,
  taskElements,
  taskState,
} from "./task-policy.ts";
import { semanticGoalControl } from "./task-freshness.ts";
import { taskSources } from "./task-sources.ts";
import { createPickerMemory, pickerActionLabel } from "./picker-state.ts";

/** Interaction only: the selected engine decides; Roll owns preparation and final verification. */
export async function runBrowserTask(
  input: BrowserOperateInput,
  driver: GoalDriver,
  decide: DecisionProvider,
  signal: AbortSignal,
): Promise<BrowserOperateOutput> {
  const started = performance.now();
  const execution = createExecutionContext(input);
  const feedback = createInteractionFeedback();
  const buildRequest: typeof buildTaskDecisionRequest = (...args) =>
    withInteractionFeedback(buildTaskDecisionRequest(...args), feedback, args[1], execution);
  const progress = execution.read;
  const steps: BrowserOperateOutput["steps"] = [];
  const resolvedValues: NonNullable<BrowserOperateOutput["resolvedValues"]> = [];
  const sources = taskSources(input);
  const pickerMemory = createPickerMemory();
  const formLoopProgress = createFormLoopProgress();
  const visits = new Map<string, number>();
  const clicks = new Map<string, number>();
  let finalSnapshot: GoalSnapshot | undefined;
  let guidance = "";
  const finish = async (
    status: BrowserOperateOutput["status"],
    error?: string,
    question?: string,
  ): Promise<BrowserOperateOutput> => {
    // One read-only handoff observation after the last action, including a failed one.
    // It must never turn an uncertain action into a replay or a verified success.
    let fresh = false;
    if (!signal.aborted) {
      try {
        finalSnapshot = await driver.observe();
        observeExecution(execution, finalSnapshot, taskElements(finalSnapshot), input.readTask);
        fresh = true;
      } catch {
        if (status === "model_done") status = "needs_reasoning";
      }
    }
    if (
      status === "interaction_done" &&
      progress &&
      input.readTask &&
      (!fresh ||
        !finalSnapshot ||
        !terminalObservationMatches(progress, input.readTask, finalSnapshot))
    ) {
      status = "needs_reasoning";
      if (progress.phase === "done") progress.phase = "return";
    }
    if (
      status === "interaction_done" &&
      execution.form &&
      (!fresh ||
        !finalSnapshot ||
        !formReady(execution, finalSnapshot, pickerMemory.observe(finalSnapshot)))
    ) {
      status = "needs_reasoning";
    }
    if (signal.aborted) status = "cancelled";
    return {
      status,
      verified: false,
      execution: executionSummary(execution),
      ...(progress ? { progress: structuredClone(progress) } : {}),
      elapsedMs: performance.now() - started,
      steps,
      resolvedValues,
      textCalls: [],
      recoveryDecisions: 0,
      pendingRequirements: ["model_done", "interaction_done"].includes(status)
        ? []
        : [
            ...(execution.form
              ? execution.form.fields
                  .filter((f) => f.status !== "satisfied")
                  .map((f) => `${f.name}: ${f.status} (${f.reason})`)
              : []),
            question ??
              error ??
              (progress && input.readTask
                ? progressSummary(progress, input.readTask).remaining
                : input.goal),
          ],
      ...(finalSnapshot
        ? {
            finalObservation: {
              ...taskState(
                input,
                finalSnapshot,
                steps,
                guidance,
                resolvedValues,
                pickerMemory.observe(finalSnapshot),
              ),
              ...(progress && input.readTask
                ? { taskProgress: progressSummary(progress, input.readTask) }
                : {}),
              executionContext: executionSummary(execution),
              observationFresh: fresh,
              verification:
                "Roll must compare this page against the ORIGINAL whole goal, including requested navigation, selected filters, empty results and unwanted activePanels. Background/list text does not prove a requested detail was opened or a panel closed. Inspect missing evidence once, then correct only mismatches; missing candidates do not prove an entry does not exist. model_done is not success certification.",
            },
          }
        : {}),
      ...(error === undefined ? {} : { error }),
      ...(question === undefined ? {} : { question }),
    };
  };
  try {
    for (let step = 1; step <= input.maxSteps; step++) {
      signal.throwIfAborted();
      const observedAt = performance.now();
      let snapshot = await driver.observe();
      if (!snapshot.snapshotId) throw new Error("Observation has no snapshot identity");
      finalSnapshot = snapshot;
      const readChanged = observeExecution(
        execution,
        snapshot,
        taskElements(snapshot),
        input.readTask,
      );
      observeInteractionFeedback(feedback, snapshot, execution);
      if (execution.form && execution.summary.documentChanged) {
        return finish(
          "needs_reasoning",
          "The delegated form document changed; Roll must confirm the new scope.",
        );
      }
      if (
        execution.form?.fields.some((f) => f.intent === "preserve" && f.status === "unsatisfied")
      ) {
        return finish(
          "needs_reasoning",
          "A preserve-only field changed; reported without restoring it outside write scope.",
        );
      }
      if (readChanged) {
        guidance = "Previously captured region changed; recapture this target.";
        if (progress && progress.conflicts > 2) {
          return finish(
            "needs_reasoning",
            "Repeated evidence changes; returning recorded progress.",
          );
        }
      }
      if (
        execution.form &&
        observeFormLoopProgress(formLoopProgress, snapshot, execution.form, steps.at(-1))
      ) {
        return finish(
          "needs_reasoning",
          "Repeated form/option state without field progress. Inspect the unresolved field or editor once; do not repeat the same open/close or scrolling cycle.",
        );
      }
      const observationMs = performance.now() - observedAt;
      // Ignore regenerated refs, layout and page clocks when detecting ineffective loops.
      const fingerprint = createHash("sha256")
        .update(
          JSON.stringify({
            documentId: snapshot.documentId,
            pageState: snapshot.pageState,
            progress: progress
              ? { phase: progress.phase, missing: progress.missing, conflicts: progress.conflicts }
              : undefined,
            form: execution.form,
            elements: taskElements(snapshot).map(
              ({ ref: _ref, identity: _identity, position: _position, ...element }) => element,
            ),
          }),
        )
        .digest("hex");
      const seen = (visits.get(fingerprint) ?? 0) + 1;
      visits.set(fingerprint, seen);
      if (seen > 4) {
        return finish(
          "needs_reasoning",
          "Repeated observation without progress; Roll should inspect and revise the task.",
        );
      }
      const suppressed = new Set(
        snapshot.refs
          .filter((ref) => (clicks.get(fingerprint + taskControlIdentity(ref)) ?? 0) >= 2)
          .map(taskControlIdentity),
      );
      const pickers = pickerMemory.observe(snapshot);
      const request = buildRequest(
        input,
        snapshot,
        steps,
        guidance,
        suppressed,
        resolvedValues,
        pickers,
        progress,
        execution,
      );
      const result = await decide(request, signal);
      signal.throwIfAborted();
      validateChoices(request, result.choices);
      const selectedAction = result.choices.operation!;
      const actionSeparator = selectedAction.indexOf(":");
      const operation =
        actionSeparator < 0 ? selectedAction : selectedAction.slice(0, actionSeparator);
      const record: BrowserOperateOutput["steps"][number] = {
        step,
        observationMs,
        decisionMs: result.elapsedMs,
        actionMs: 0,
        operation,
        executed: false,
        requestedModel: result.requestedModel,
        resolvedModel: result.resolvedModel,
        provider: result.provider,
        ...(result.attempts === undefined ? {} : { decisionAttempts: result.attempts }),
        ...(result.distributions ? { distributions: result.distributions } : {}),
        ...(result.usage ? { usage: result.usage } : {}),
      };
      steps.push(record);
      if (acceptInteractionFeedback(feedback, execution, result.choices)) {
        record.operation = "UPDATE_EXECUTION_CONTEXT";
        guidance =
          "Page feedback identified an unmet prerequisite. Advance that supplied field before retrying the blocked action.";
        continue;
      }
      if (execution.form) {
        const actionRef = selectedAction.split(":")[1];
        const selectedOwner = actionRef
          ? formActionOwner(execution, actionRef, taskElements(snapshot), pickers)
          : undefined;
        const ownerBefore = JSON.stringify(
          execution.form.fields.find((f) => f.id === selectedOwner),
        );
        const accepted = acceptFormDecisions(
          execution,
          snapshot,
          taskElements(snapshot),
          result.choices,
        );
        if (accepted.error) return finish("needs_reasoning", accepted.error);
        // Answers in one request are independent. Rebuild eligibility locally and
        // keep an offered target action only if its branch still means the same thing.
        const revised = accepted.changed
          ? buildRequest(
              input,
              snapshot,
              steps,
              guidance,
              suppressed,
              resolvedValues,
              pickers,
              progress,
              execution,
            )
          : undefined;
        const actionStillValid =
          revised &&
          selectedAction.includes(":") &&
          Object.hasOwn(revised.questions.operation!.criteria, selectedAction) &&
          ownerBefore ===
            JSON.stringify(execution.form.fields.find((f) => f.id === selectedOwner)) &&
          revised.routing?.targets[selectedAction] === request.routing?.targets[selectedAction];
        if (accepted.changed && !actionStillValid) {
          record.operation = "UPDATE_EXECUTION_CONTEXT";
          guidance =
            "Current field binding/evidence changed; discard the old action and choose from updated delegation state.";
          continue;
        }
        if (operation === "DONE") {
          if (formReady(execution, snapshot, pickers)) {
            const outcome = await finish("interaction_done");
            if (
              outcome.status === "needs_reasoning" &&
              !execution.summary.documentChanged &&
              !execution.form.fields.some(
                (f) => f.intent === "preserve" && f.status === "unsatisfied",
              ) &&
              !signal.aborted
            ) {
              record.operation = "CONTINUE_TASK";
              guidance =
                "The final current observation changed. Continue this same delegation and repair only set fields; historical matches do not finish the task.";
              continue;
            }
            return outcome;
          }
          record.operation = "CONTINUE_TASK";
          guidance =
            "Delegated fields or their application state are not all current and satisfied.";
          continue;
        }
      }

      if (progress && input.readTask) {
        if (progress.phase === "collect" && result.choices.capture_region === "AMBIGUOUS") {
          return finish("needs_reasoning", "Target evidence identity is ambiguous.");
        }
        if (
          progress.phase === "collect" &&
          acceptProgressEvidence(progress, input.readTask, snapshot, result.choices)
        ) {
          record.operation = "CAPTURE_EVIDENCE";
          guidance =
            "Required target evidence is stored. The phase changed to RETURN; discard the old-phase action and only reach the terminal.";
          continue;
        }
        if (
          progress.phase === "return" &&
          result.choices.progress_terminal === "READY" &&
          terminalObservationMatches(progress, input.readTask, snapshot)
        ) {
          progress.phase = "done";
          record.operation = "INTERACTION_DONE";
          return finish("interaction_done");
        }
        if (operation === "DONE") {
          record.operation = "CONTINUE_TASK";
          guidance =
            progress.phase === "collect"
              ? "Required read evidence has not been captured. Continue the actual target view or return REASSESS; do not claim completion from a click/list summary."
              : "Historical reading is complete. Only restore the specified terminal; do not reopen the target. Reporting uses the stored evidence.";
          continue;
        }
      }
      if (operation === "DONE") {
        if (result.choices.completion === "COMPLETE") return finish("model_done");
        record.operation = "CONTINUE_TASK";
        const completion = result.choices.completion;
        const match = /^REQUIREMENT:v(\d+)$/u.exec(completion ?? "");
        const requirement = match ? input.values[Number(match[1]) - 1] : undefined;
        guidance =
          completion === "OPEN_PANEL"
            ? "The requested field values are applied, but an editor/picker is still open. Close the unwanted panel with ESCAPE or an observed close control without changing correct values, then inspect the result."
            : requirement
              ? `Completion found remaining work for ${requirement.name}: ${JSON.stringify(requirement.text.slice(0, 200))}. Advance that ORIGINAL obligation; do not turn auxiliary source material into a new requirement.`
              : "The same-state completion judgment found unfinished or unobservable original requirements. Inspect all requested fields, including plain inputs; choose missing work or REASSESS, not another premature DONE.";
        continue;
      }
      if (operation === "NEEDS_INPUT") {
        return finish(
          "needs_input",
          undefined,
          "请根据当前页面和原始目标补充缺少的字段资料或所需文案，再继续未完成部分。",
        );
      }
      if (operation === "REASSESS") {
        return finish("needs_reasoning", "Decision engine returned unresolved work to Roll.");
      }
      if (operation === "BLOCKED") {
        return finish(
          "blocked",
          "Decision engine reported a page obstacle; inspect finalObservation.",
        );
      }
      let actionFieldId: string | undefined;
      let actionIdentity: string | undefined;
      let invoked = false;
      let actionAt: number | undefined;
      try {
        if (operation === "WAIT") {
          await delay(150, undefined, { signal });
        } else if (operation === "ESCAPE") {
          actionAt = performance.now();
          invoked = true;
          await driver.invoke("press", ["Escape"]);
        } else {
          const selected =
            actionSeparator < 0 ? undefined : selectedAction.slice(actionSeparator + 1);
          if (!selected) throw new Error("Missing action target");
          const separator = selected.lastIndexOf(":");
          const refId = operation === "SELECT" ? selected.slice(0, separator) : selected;
          const ref = snapshot.refs.find((item) => item.ref === refId);
          if (!ref) throw new Error("Selected target is not observed");
          const identity = taskControlIdentity(ref);
          actionIdentity = identity;
          record.target = pickerActionLabel(ref, pickers, operation);
          actionFieldId = formActionOwner(execution, ref.ref, taskElements(snapshot), pickers);
          if (execution.form && !actionFieldId && !operation.startsWith("SCROLL_")) {
            return finish("needs_reasoning", "Action is outside the current delegated field scope");
          }
          const option =
            operation === "SELECT"
              ? snapshot.controls?.[ref.ref]?.options?.[Number(selected.slice(separator + 1))]
              : undefined;
          if (operation === "SELECT" && (!option || option.disabled)) {
            throw new Error("Native option is not available");
          }
          const sourceHead = request.routing?.targets[selectedAction];
          const sourceId = sourceHead ? result.choices[sourceHead] : undefined;
          const value = sourceId ? sources.values[sourceId] : undefined;
          if (operation === "TYPE_TEXT" && (!value || sourceId === "NONE")) {
            return finish(
              "needs_input",
              undefined,
              `请为“${ref.name}”提供符合当前控件含义的值或已准备文案；现有资料候选不匹配。`,
            );
          }
          const guardAt = performance.now();
          let current = ref;
          let unchanged: boolean;
          if (driver.checkTarget) {
            unchanged = await driver.checkTarget(snapshot, ref);
          } else {
            const fresh = await driver.observe();
            const rebound = fresh.refs.find((item) => taskControlIdentity(item) === identity);
            const before = snapshot.controls?.[ref.ref];
            const after = rebound ? fresh.controls?.[rebound.ref] : undefined;
            const beforeNode = taskElements(snapshot).find((item) => item.ref === ref.ref);
            const afterNode = rebound
              ? taskElements(fresh).find((item) => item.ref === rebound.ref)
              : undefined;
            unchanged = Boolean(
              rebound &&
              snapshot.documentId === fresh.documentId &&
              snapshot.pageId === fresh.pageId &&
              snapshot.browserInstance === fresh.browserInstance &&
              beforeNode?.name === afterNode?.name &&
              beforeNode?.value === afterNode?.value &&
              beforeNode?.role === afterNode?.role &&
              beforeNode?.disabled === afterNode?.disabled &&
              (before && after
                ? JSON.stringify(semanticGoalControl(before)) ===
                  JSON.stringify(semanticGoalControl(after))
                : !before && !after),
            );
            snapshot = fresh;
            finalSnapshot = fresh;
            if (rebound) current = rebound;
          }
          record.observationMs += performance.now() - guardAt;
          signal.throwIfAborted();
          if (!unchanged) {
            record.operation = "STALE_DECISION";
            record.error = "Selected control changed before dispatch; observe and choose again.";
            guidance = record.error;
            continue;
          }
          const locator = { ref: current.ref, snapshotId: snapshot.snapshotId };
          const currentValue = taskElements(snapshot).find(
            (item) => item.ref === current.ref,
          )?.value;
          if (value && currentValue === value.text) {
            record.operation = "VALUE_ALREADY_PRESENT";
            guidance =
              "The input already contains that text. If this is a search, select and apply a candidate; otherwise advance another requirement.";
            continue;
          }
          const method = option
            ? "choose"
            : value
              ? "fill"
              : operation === "CLICK"
                ? "click"
                : "scroll";
          const params: unknown[] = option
            ? [locator, { value: option.value }]
            : value
              ? [locator, value.text, { expect: { target: locator, value: value.text } }]
              : operation === "CLICK"
                ? [locator]
                : [locator, { dy: operation === "SCROLL_UP" ? -600 : 600 }];
          if (value) record.valueName = value.name;
          if (option) record.target += ` → ${option.label}`;
          actionAt = performance.now();
          invoked = true;
          await driver.invoke(method, params);
          signal.throwIfAborted();
          if (value || option) {
            const targetKey = JSON.stringify([snapshot.documentId, identity]);
            const previous = resolvedValues.findIndex((item) => item.targetKey === targetKey);
            if (previous >= 0) resolvedValues.splice(previous, 1);
            resolvedValues.push({
              ...(value ?? {
                text: option!.label,
                source: "selected" as const,
                sourceIds: [],
                evidence:
                  "Observed option selected by the decision engine; not independent verification",
              }),
              field: current.name,
              targetKey,
            });
          }
          if (operation === "CLICK") {
            clicks.set(fingerprint + identity, (clicks.get(fingerprint + identity) ?? 0) + 1);
          }
          guidance =
            "Use the fresh page to assess progress. A dispatched click or written query alone does not prove selection was applied.";
        }
        record.executed = invoked && driver.actionExecuted();
      } catch (error) {
        record.executed = invoked && driver.actionExecuted();
        record.error =
          error instanceof Error ? error.message.slice(0, 400) : "Browser task action failed";
        if (record.executed || signal.aborted) {
          return finish(signal.aborted ? "cancelled" : "failed", record.error);
        }
        if (!invoked) return finish("needs_reasoning", record.error);
        guidance =
          "Action rejected before dispatch; observe current targets before choosing again.";
      } finally {
        if (actionIdentity) {
          recordInteractionAttempt(feedback, snapshot, {
            operation: record.operation,
            identity: actionIdentity,
            target: record.target ?? "",
            executed: record.executed,
            ...(record.error ? { error: record.error } : {}),
          });
        }
        recordExecutionAction(
          execution,
          {
            operation: record.operation,
            ...(record.target ? { target: record.target } : {}),
            executed: record.executed,
            ...(record.error ? { error: record.error } : {}),
          },
          actionFieldId,
        );
        if (actionAt !== undefined) record.actionMs = performance.now() - actionAt;
      }
      const recent = steps.slice(-3);
      if (
        recent.length === 3 &&
        recent.every((item) => item.operation === "WAIT" || item.error !== undefined)
      ) {
        return finish(
          "needs_reasoning",
          "Three steps without progress; returning to Roll without a fallback call.",
        );
      }
    }
    return finish("step_limit");
  } catch (error) {
    return finish(
      signal.aborted ? "cancelled" : "failed",
      error instanceof Error ? error.message.slice(0, 400) : "Browser task failed",
    );
  }
}
