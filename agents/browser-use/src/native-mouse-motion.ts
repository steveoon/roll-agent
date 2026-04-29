import type { NativeCdpController, NativeCdpMouseEventInput } from "@roll-agent/browser";

export type NativeMousePoint = {
  readonly x: number;
  readonly y: number;
};

export type NativeMouseMotionPreview = {
  readonly points: readonly NativeMousePoint[];
  readonly durationMs: number;
};

export type NativeMouseClickPreview = {
  readonly point: NativeMousePoint;
  readonly durationMs: number;
};

export type NativeMouseMotionObserver = {
  previewMouseMotion(preview: NativeMouseMotionPreview): Promise<void>;
  previewMouseClick?(preview: NativeMouseClickPreview): Promise<void>;
};

export type NativeMouseMotionControllerOptions = {
  readonly sleep?: (ms: number) => Promise<void>;
  readonly stepDelayMs?: number;
};

export type NativeMouseMoveOptions = {
  readonly button?: NativeCdpMouseEventInput["button"];
  readonly buttons?: number;
  readonly motionObserver?: NativeMouseMotionObserver;
  readonly stepDelayMs?: number;
};

export type NativeMouseClickOptions = {
  readonly button?: NativeCdpMouseEventInput["button"];
  readonly clickCount?: number;
  readonly motionObserver?: NativeMouseMotionObserver;
  readonly preClickDelayMs?: number;
  readonly pressDurationMs?: number;
  readonly settleMs?: number;
};

export type NativeMouseDragOptions = {
  readonly motionObserver?: NativeMouseMotionObserver;
  readonly pressDurationMs?: number;
  readonly stepDelayMs?: number;
};

type NativeMouseDispatcher = Pick<NativeCdpController, "dispatchMouseEvent">;

const DEFAULT_STEP_DELAY_MS = 28;
const DEFAULT_PRESS_DURATION_MS = 90;
const DEFAULT_SETTLE_MS = 250;
const DEFAULT_CLICK_PREVIEW_DURATION_MS = 620;
const SHORT_DISTANCE_PX = 8;
const MAX_PATH_STEPS = 32;
const MIN_PATH_STEPS = 8;

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function normalizeDelay(ms: number | undefined, fallback: number): number {
  return Math.max(0, Math.floor(ms ?? fallback));
}

function toSafePoint(point: NativeMousePoint): NativeMousePoint {
  return {
    x: Math.round(Number.isFinite(point.x) ? point.x : 0),
    y: Math.round(Number.isFinite(point.y) ? point.y : 0),
  };
}

function distanceBetween(from: NativeMousePoint, to: NativeMousePoint): number {
  return Math.hypot(to.x - from.x, to.y - from.y);
}

function easeInOutCubic(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

function createInitialPointNearTarget(target: NativeMousePoint): NativeMousePoint {
  const horizontalOffset = target.x >= 96 ? -72 : 72;
  const verticalOffset = target.y >= 72 ? -36 : 36;
  return {
    x: Math.max(1, target.x + horizontalOffset),
    y: Math.max(1, target.y + verticalOffset),
  };
}

function createControlSign(from: NativeMousePoint, to: NativeMousePoint): number {
  return Math.round(from.x + from.y + to.x + to.y) % 2 === 0 ? 1 : -1;
}

function createPathPoints(
  from: NativeMousePoint,
  to: NativeMousePoint,
): readonly NativeMousePoint[] {
  const distance = distanceBetween(from, to);
  if (distance <= SHORT_DISTANCE_PX) {
    return [from, to];
  }

  const stepCount = clamp(Math.round(distance / 30), MIN_PATH_STEPS, MAX_PATH_STEPS);
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const normalLength = Math.max(distance, 1);
  const normalX = -dy / normalLength;
  const normalY = dx / normalLength;
  const curve = clamp(distance * 0.08, 4, 28) * createControlSign(from, to);
  const points: NativeMousePoint[] = [from];

  for (let step = 1; step < stepCount; step += 1) {
    const t = step / stepCount;
    const eased = easeInOutCubic(t);
    const arc = Math.sin(Math.PI * t) * curve;
    const microJitter =
      Math.sin((from.x + to.y + step * 17) * 0.13) * Math.min(1.8, distance / 180);
    points.push({
      x: Math.round(from.x + dx * eased + normalX * (arc + microJitter)),
      y: Math.round(from.y + dy * eased + normalY * (arc + microJitter)),
    });
  }

  points.push(to);
  return points;
}

export function createNativeMousePath(
  currentPoint: NativeMousePoint | undefined,
  targetPoint: NativeMousePoint,
): readonly NativeMousePoint[] {
  const target = toSafePoint(targetPoint);
  const from =
    currentPoint === undefined ? createInitialPointNearTarget(target) : toSafePoint(currentPoint);
  return createPathPoints(from, target);
}

export class NativeMouseMotionController {
  private readonly dispatcher: NativeMouseDispatcher;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly defaultStepDelayMs: number;
  private lastPoint: NativeMousePoint | undefined;

  constructor(dispatcher: NativeMouseDispatcher, options: NativeMouseMotionControllerOptions = {}) {
    this.dispatcher = dispatcher;
    this.sleep = options.sleep ?? defaultSleep;
    this.defaultStepDelayMs = normalizeDelay(options.stepDelayMs, DEFAULT_STEP_DELAY_MS);
  }

  reset(point?: NativeMousePoint): void {
    this.lastPoint = point === undefined ? undefined : toSafePoint(point);
  }

  async moveTo(
    targetPoint: NativeMousePoint,
    options: NativeMouseMoveOptions = {},
  ): Promise<NativeMouseMotionPreview> {
    const stepDelayMs = normalizeDelay(options.stepDelayMs, this.defaultStepDelayMs);
    const points = createNativeMousePath(this.lastPoint, targetPoint);
    const durationMs = Math.max(points.length - 1, 0) * stepDelayMs;

    await options.motionObserver?.previewMouseMotion({ points, durationMs });

    for (let index = 0; index < points.length; index += 1) {
      const point = points[index];
      if (point === undefined) {
        continue;
      }

      await this.dispatcher.dispatchMouseEvent({
        type: "mouseMoved",
        x: point.x,
        y: point.y,
        ...(options.button !== undefined ? { button: options.button } : {}),
        buttons: options.buttons ?? 0,
      });

      if (index < points.length - 1 && stepDelayMs > 0) {
        await this.sleep(stepDelayMs);
      }
    }

    this.lastPoint = toSafePoint(targetPoint);
    return { points, durationMs };
  }

  async click(targetPoint: NativeMousePoint, options: NativeMouseClickOptions = {}): Promise<void> {
    const button = options.button ?? "left";
    const clickCount = options.clickCount ?? 1;
    await this.moveTo(targetPoint, {
      button: "none",
      buttons: 0,
      ...(options.motionObserver !== undefined ? { motionObserver: options.motionObserver } : {}),
    });

    await this.delayIfPositive(options.preClickDelayMs);
    await options.motionObserver?.previewMouseClick?.({
      point: toSafePoint(targetPoint),
      durationMs: DEFAULT_CLICK_PREVIEW_DURATION_MS,
    });
    await this.dispatcher.dispatchMouseEvent({
      type: "mousePressed",
      x: Math.round(targetPoint.x),
      y: Math.round(targetPoint.y),
      button,
      buttons: button === "left" ? 1 : 0,
      clickCount,
    });
    await this.delayIfPositive(options.pressDurationMs ?? DEFAULT_PRESS_DURATION_MS);
    await this.dispatcher.dispatchMouseEvent({
      type: "mouseReleased",
      x: Math.round(targetPoint.x),
      y: Math.round(targetPoint.y),
      button,
      buttons: 0,
      clickCount,
    });
    await this.delayIfPositive(options.settleMs ?? DEFAULT_SETTLE_MS);
    this.lastPoint = toSafePoint(targetPoint);
  }

  async drag(
    fromPoint: NativeMousePoint,
    toPoint: NativeMousePoint,
    options: NativeMouseDragOptions = {},
  ): Promise<void> {
    await this.moveTo(fromPoint, {
      button: "none",
      buttons: 0,
      ...(options.motionObserver !== undefined ? { motionObserver: options.motionObserver } : {}),
      ...(options.stepDelayMs !== undefined ? { stepDelayMs: options.stepDelayMs } : {}),
    });
    await this.dispatcher.dispatchMouseEvent({
      type: "mousePressed",
      x: Math.round(fromPoint.x),
      y: Math.round(fromPoint.y),
      button: "left",
      buttons: 1,
      clickCount: 1,
    });
    await this.delayIfPositive(options.pressDurationMs ?? DEFAULT_PRESS_DURATION_MS);
    this.reset(fromPoint);
    await this.moveTo(toPoint, {
      button: "left",
      buttons: 1,
      ...(options.motionObserver !== undefined ? { motionObserver: options.motionObserver } : {}),
      ...(options.stepDelayMs !== undefined ? { stepDelayMs: options.stepDelayMs } : {}),
    });
    await this.dispatcher.dispatchMouseEvent({
      type: "mouseReleased",
      x: Math.round(toPoint.x),
      y: Math.round(toPoint.y),
      button: "left",
      buttons: 0,
      clickCount: 1,
    });
    this.lastPoint = toSafePoint(toPoint);
  }

  private async delayIfPositive(ms: number | undefined): Promise<void> {
    const delayMs = Math.max(0, Math.floor(ms ?? 0));
    if (delayMs > 0) {
      await this.sleep(delayMs);
    }
  }
}
