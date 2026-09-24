import { randomUUID } from "node:crypto";
import type { BrowserProgramDriver } from "@roll-agent/browser";
import { NativeVisualActivitySession } from "./native-visual-activity-session.ts";
import type { NativeExecutionCard } from "./native-visual-activity-session.ts";
import type { GoalSnapshot } from "./goal/observation.ts";

type VisualTarget = {
  evaluateJson<T = unknown>(expression: string, options?: { timeoutMs?: number }): Promise<T>;
  getBoxModelByBackendNodeId?(options: { backendNodeId: number; timeoutMs?: number }): Promise<
    | {
        content?: readonly number[];
        border?: readonly number[];
      }
    | undefined
  >;
};
type PointerEvent = { type: "mouseMoved" | "mousePressed"; x: number; y: number };
type ResolvedVisualTarget = { backendNodeId: number; frameId: string; role: string; name: string };
type Stage = "viewing" | "deciding" | "acting" | "waiting" | "checking";

let lastExecutionEpoch = Date.now() * 1000;
function nextExecutionEpoch(): number {
  lastExecutionEpoch = Math.max(lastExecutionEpoch + 1, Date.now() * 1000);
  return lastExecutionEpoch;
}

function safeFieldName(value: string): string | undefined {
  const name = value.replace(/\s+/gu, " ").trim();
  if (!name || name.length > 32 || /[@:/\\\n\r\t]|\d{6,}/u.test(name)) return undefined;
  return name;
}

function fieldKey(value: string): string {
  return value.replace(/\s+/gu, "").toLocaleLowerCase();
}

function semanticAction(method: string, field: string, isEditor: boolean): string {
  if (method === "click" && isEditor) {
    return `打开「${field}」编辑入口`;
  }
  const verbs: Readonly<Record<string, string>> = {
    click: "点击",
    fill: "填写",
    choose: "选择",
    hover: "查看",
    press: "操作",
    scroll: "滚动至",
    read: "读取",
    inspectControl: "查看",
  };
  return `${verbs[method] ?? "操作"}「${field}」`;
}

const stageLabels: Readonly<Record<Stage, string>> = {
  viewing: "正在查看页面",
  deciding: "正在决定下一步",
  acting: "正在操作页面",
  waiting: "正在等待页面条件",
  checking: "正在检查页面结果",
};

const helperLabels: Readonly<Record<string, string>> = {
  snapshot: "查看页面快照",
  observe: "查看页面状态",
  read: "读取控件",
  exists: "检查控件是否存在",
  count: "检查控件数量",
  inspectControl: "查看控件选项",
  click: "点击控件",
  fill: "填写输入框",
  hover: "移动到控件",
  choose: "选择页面选项",
  press: "按下按键",
  scroll: "滚动页面",
  goto: "打开页面",
  waitFor: "等待页面条件",
  expect: "校验页面条件",
  screenshot: "截取页面画面",
};

const observationMethods = new Set([
  "snapshot",
  "observe",
  "read",
  "exists",
  "count",
  "inspectControl",
  "screenshot",
]);
const verificationMethods = new Set(["expect"]);
const waitingMethods = new Set(["waitFor"]);
const mutationMethods = new Set(["click", "fill", "hover", "choose", "press", "scroll", "goto"]);

function safeTarget(method: string, params: readonly unknown[]): string | undefined {
  if (!mutationMethods.has(method)) return undefined;
  const first = params[0];
  const locator =
    method === "press" &&
    params[1] !== null &&
    typeof params[1] === "object" &&
    "target" in params[1]
      ? params[1].target
      : first;
  if (locator && typeof locator === "object" && "role" in locator) {
    const role = locator.role;
    if (typeof role === "string" && /^[a-zA-Z]{1,24}$/u.test(role)) {
      return `目标：${role.toLowerCase()}`;
    }
  }
  return method === "goto" ? "目标：已授权页面" : "目标：页面控件";
}

/** Page-only, best-effort feedback. It never displays script parameters or form values. */
export class ExecutionVisualFeedback {
  private readonly visual: NativeVisualActivitySession;
  private readonly targetPage: VisualTarget;
  private readonly ownerId = randomUUID();
  private readonly epoch = nextExecutionEpoch();
  private readonly title: string;
  private readonly pending = new Set<Promise<unknown>>();
  private readonly labelsByNode = new Map<string, { field: string; isEditor: boolean }>();
  private currentCardRender: Promise<boolean> = Promise.resolve(false);
  private recent: string[] = [];
  private stage: Stage = "viewing";
  private action: string | undefined;
  private target: string | undefined;
  private method: string | undefined;
  private semanticLabel: string | undefined;
  private ended = false;
  private revision = 0;
  private actionRevision = 0;

  constructor(targetPage: VisualTarget, scope: "script" | "workflow" | "read" | "form" | "task") {
    this.targetPage = targetPage;
    this.visual = new NativeVisualActivitySession(targetPage);
    this.title =
      {
        script: "浏览器脚本",
        workflow: "浏览器工作流",
        read: "读取页面资料",
        form: "填写已授权表单",
        task: "浏览器任务",
      }[scope] ?? "浏览器任务";
  }

  private track<T>(promise: Promise<T>): Promise<T> {
    this.pending.add(promise);
    promise.finally(() => this.pending.delete(promise)).catch(() => {});
    return promise;
  }

  private card(): NativeExecutionCard {
    return {
      ownerId: this.ownerId,
      epoch: this.epoch,
      revision: ++this.revision,
      actionRevision: this.actionRevision,
      title: this.title,
      stage: stageLabels[this.stage],
      ...(this.action ? { action: this.action } : {}),
      ...(this.target ? { target: this.target } : {}),
      recent: this.recent,
    };
  }

  private show(mode: "begin" | "update" = "update"): Promise<boolean> {
    if (this.ended) return Promise.resolve(false);
    this.currentCardRender = this.track(
      this.visual.showExecutionCard(this.card(), mode).catch(() => false),
    );
    return this.currentCardRender;
  }

  async begin(): Promise<void> {
    await this.show("begin");
  }

  setStage(stage: Stage): void {
    if (this.ended) return;
    this.stage = stage;
    this.action = undefined;
    this.target = undefined;
    this.method = undefined;
    this.semanticLabel = undefined;
    ++this.actionRevision;
    this.show();
  }

  /** Match only fresh observed controls to safe, explicitly delegated field names. */
  observe(snapshot: Pick<GoalSnapshot, "refs" | "controls">, fieldNames: readonly string[]): void {
    this.labelsByNode.clear();
    const names = fieldNames
      .map(safeFieldName)
      .filter((name): name is string => name !== undefined);
    const ambiguous = new Set<string>();
    for (const ref of snapshot.refs) {
      if (ref.backendNodeId === undefined) continue;
      const control = snapshot.controls?.[ref.ref];
      const observed = [control?.fieldLabel, control?.observedName, ref.name]
        .filter((value): value is string => typeof value === "string")
        .map(fieldKey);
      const matched = names.filter((name) => {
        const key = fieldKey(name);
        return observed.some((label) => label === key || (key.length >= 2 && label.includes(key)));
      });
      if (matched.length !== 1) continue;
      const key = `${ref.frameId ?? "unknown"}:${ref.backendNodeId}`;
      if (this.labelsByNode.has(key)) {
        ambiguous.add(key);
        continue;
      }
      this.labelsByNode.set(key, {
        field: matched[0]!,
        isEditor: /^(?:编辑|修改|展开|edit|change|expand)/iu.test(ref.name.trim()),
      });
    }
    for (const key of ambiguous) this.labelsByNode.delete(key);
  }

  async invoke(driver: BrowserProgramDriver, method: string, params: unknown[]): Promise<unknown> {
    this.stage = observationMethods.has(method)
      ? "viewing"
      : waitingMethods.has(method)
        ? "waiting"
        : verificationMethods.has(method)
          ? "checking"
          : "acting";
    this.method = method;
    this.semanticLabel = undefined;
    ++this.actionRevision;
    this.action = `${helperLabels[method] ?? "处理页面"} · 准备中`;
    this.target = safeTarget(method, params);
    this.show();
    try {
      const result = await driver.invoke(method, params);
      const label = this.semanticLabel ?? helperLabels[method] ?? "页面操作";
      const outcome = mutationMethods.has(method)
        ? driver.lastActionExecuted
          ? driver.lastVerification === "passed"
            ? `${label}已执行并校验`
            : `${label}已执行 · 待验收`
          : `${label}无需执行 · 已检查`
        : verificationMethods.has(method) || waitingMethods.has(method)
          ? `${label}已通过`
          : `${label}已完成`;
      this.recent = [...this.recent, outcome].slice(-3);
      this.action = outcome;
      this.show();
      return result;
    } catch (error) {
      const label = this.semanticLabel ?? helperLabels[method] ?? "页面操作";
      const outcome = driver.lastActionExecuted ? `${label}已发出 · 结果未确认` : `${label}未执行`;
      this.recent = [...this.recent, outcome].slice(-3);
      this.action = outcome;
      this.show();
      throw error;
    }
  }

  focusTarget(event: ResolvedVisualTarget): void {
    if (this.ended) return;
    const actionRevision = this.actionRevision;
    const label =
      this.labelsByNode.get(`${event.frameId}:${event.backendNodeId}`) ??
      this.labelsByNode.get(`unknown:${event.backendNodeId}`);
    if (label && this.method) {
      this.semanticLabel = semanticAction(this.method, label.field, label.isEditor);
      this.action = `${this.semanticLabel} · 准备中`;
      this.target = `字段：${label.field}`;
      this.show();
    }
    if (!this.targetPage.getBoxModelByBackendNodeId) return;
    const cardReady = this.currentCardRender;
    const geometry = this.targetPage
      .getBoxModelByBackendNodeId({
        backendNodeId: event.backendNodeId,
        timeoutMs: 300,
      })
      .then(async (box) => {
        if (this.ended || this.actionRevision !== actionRevision || !box) return;
        const quad = box.border ?? box.content;
        if (!quad || quad.length < 8 || !quad.every(Number.isFinite)) return;
        const xs = [quad[0]!, quad[2]!, quad[4]!, quad[6]!];
        const ys = [quad[1]!, quad[3]!, quad[5]!, quad[7]!];
        const x = Math.min(...xs);
        const y = Math.min(...ys);
        const width = Math.max(...xs) - x;
        const height = Math.max(...ys) - y;
        if (width <= 0 || height <= 0) return;
        await cardReady;
        if (this.ended || this.actionRevision !== actionRevision) return;
        await this.visual.highlightExecutionRect({
          ownerId: this.ownerId,
          epoch: this.epoch,
          actionRevision,
          x,
          y,
          width,
          height,
        });
      })
      .catch(() => {});
    this.track(geometry);
  }

  pointer(event: PointerEvent): void {
    if (this.ended) return;
    this.track(
      this.visual
        .previewExecutionPointer({
          ownerId: this.ownerId,
          epoch: this.epoch,
          actionRevision: this.actionRevision,
          ...event,
        })
        .catch(() => false),
    );
  }

  private async drain(): Promise<void> {
    if (!this.pending.size) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        Promise.allSettled([...this.pending]),
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, 350);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async finish(label: string, tone: "info" | "success" | "error"): Promise<void> {
    if (this.ended) return;
    this.ended = true;
    await this.drain();
    const { action: _action, target: _target, ...card } = this.card();
    await this.visual
      .showExecutionCard({ ...card, stage: label, tone, lingerMs: 1800 }, "complete")
      .catch(() => false);
  }

  async clear(): Promise<void> {
    if (this.ended) return;
    this.ended = true;
    await this.drain();
    await this.visual
      .clearExecutionCard({
        ownerId: this.ownerId,
        epoch: this.epoch,
        revision: ++this.revision,
        actionRevision: this.actionRevision,
      })
      .catch(() => false);
  }
}
