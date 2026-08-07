import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  appendCompanionLogText,
  COMPANION_ACTION_PATHS,
  describeCompanionAction,
  describeCompanionPhase,
  describeCompanionWorkspaceDraft,
  getCompanionActionAvailability,
  isCompanionUnavailableError,
  limitCompanionLogLines,
} from "./companion-state.ts";
import type { CompanionStatus } from "../types.ts";

const ENROLLED_RUNNING: CompanionStatus = {
  phase: "running",
  enabled: true,
  enrolled: true,
  runtimeOnline: true,
  relayProfile: "roll-cloud-v1",
  cwd: "/Users/tester/projects/roll",
};

describe("companion action availability", () => {
  it("offers only enrollment before the host is bound", () => {
    const availability = getCompanionActionAvailability(
      { ...ENROLLED_RUNNING, enrolled: false, enabled: false, phase: "stopped" },
      false,
    );

    assert.equal(availability.enroll, true);
    assert.equal(availability.start, false);
    assert.equal(availability.stop, false);
    assert.equal(availability.unenroll, false);
    assert.equal(availability["service-install"], false);
    assert.equal(availability.workspace, false);
  });

  it("mirrors the application guards for a disabled enrollment", () => {
    const availability = getCompanionActionAvailability(
      { ...ENROLLED_RUNNING, enabled: false, phase: "stopped" },
      false,
    );

    assert.equal(availability.enroll, false);
    assert.equal(availability.enable, true);
    assert.equal(availability.disable, false);
    assert.equal(availability.start, false);
    assert.equal(availability.restart, false);
    assert.equal(availability["service-install"], false);
    assert.equal(availability["service-uninstall"], true);
    assert.equal(availability.stop, true);
    assert.equal(availability.unenroll, true);
  });

  it("enables the full lifecycle for an enabled enrollment", () => {
    const availability = getCompanionActionAvailability(ENROLLED_RUNNING, false);

    assert.equal(availability.start, true);
    assert.equal(availability.restart, true);
    assert.equal(availability.disable, true);
    assert.equal(availability.enable, false);
    assert.equal(availability["service-install"], true);
  });

  it("disables every action while a mutation is in flight or the status is unknown", () => {
    for (const availability of [
      getCompanionActionAvailability(ENROLLED_RUNNING, true),
      getCompanionActionAvailability(undefined, false),
    ]) {
      assert.deepEqual(
        Object.values(availability).filter((enabled) => enabled),
        [],
      );
    }
  });

  it("keeps one HTTP path per action", () => {
    assert.deepEqual(Object.keys(COMPANION_ACTION_PATHS).sort(), [
      "disable",
      "enable",
      "enroll",
      "restart",
      "service-install",
      "service-uninstall",
      "start",
      "stop",
      "unenroll",
      "workspace",
    ]);
    assert.equal(COMPANION_ACTION_PATHS["service-install"], "/api/companion/service/install");
    assert.equal(new Set(Object.values(COMPANION_ACTION_PATHS)).size, 10);
  });
});

describe("companion presentation", () => {
  it("maps every phase to a label and tone", () => {
    assert.deepEqual(describeCompanionPhase("running"), { label: "运行中", tone: "ok" });
    assert.deepEqual(describeCompanionPhase("stopped"), { label: "已停止", tone: "off" });
    assert.equal(describeCompanionPhase("recovering").tone, "warn");
  });

  it("warns about the long stop budget and confirms destructive actions", () => {
    assert.match(describeCompanionAction("stop").progress, /1 分钟/u);
    assert.match(describeCompanionAction("restart").progress, /1 分钟/u);
    assert.equal(describeCompanionAction("start").progress.includes("1 分钟"), false);
    assert.notEqual(describeCompanionAction("unenroll").confirm, undefined);
    assert.notEqual(describeCompanionAction("service-uninstall").confirm, undefined);
    assert.equal(describeCompanionAction("start").confirm, undefined);
  });

  it("rejects relative workspace drafts and accepts absolute ones", () => {
    assert.notEqual(describeCompanionWorkspaceDraft(""), undefined);
    assert.notEqual(describeCompanionWorkspaceDraft("projects/app"), undefined);
    assert.notEqual(describeCompanionWorkspaceDraft("~/projects/app"), undefined);
    assert.equal(describeCompanionWorkspaceDraft("/Users/tester/app"), undefined);
    assert.equal(describeCompanionWorkspaceDraft("C:\\Users\\tester\\app"), undefined);
    assert.equal(describeCompanionWorkspaceDraft("  /Users/tester/app  "), undefined);
  });
});

describe("companion log buffering", () => {
  it("keeps only the newest lines when the tail grows past the cap", () => {
    const text = Array.from({ length: 10 }, (_, index) => `line-${String(index)}`).join("\n");

    assert.equal(limitCompanionLogLines(text, 3), "line-7\nline-8\nline-9");
    assert.equal(limitCompanionLogLines(text, 10), text);
  });

  it("appends streamed chunks and preserves trailing newlines", () => {
    assert.equal(appendCompanionLogText("a\n", "b\n", 10), "a\nb\n");
    assert.equal(appendCompanionLogText("", "first\nsecond\n", 10), "first\nsecond\n");
    assert.equal(appendCompanionLogText("a\nb\nc\n", "d\n", 2), "d\n");
  });
});

describe("companion availability detection", () => {
  it("recognizes only the companion_unavailable 404 as an unsupported host", () => {
    assert.equal(isCompanionUnavailableError(createApiError(404, "companion_unavailable")), true);
    assert.equal(isCompanionUnavailableError(createApiError(404, "not_found")), false);
    assert.equal(isCompanionUnavailableError(createApiError(500, "companion_unavailable")), false);
    assert.equal(isCompanionUnavailableError(new Error("offline")), false);
    assert.equal(isCompanionUnavailableError(undefined), false);
  });
});

function createApiError(status: number, code: string): Error {
  return Object.assign(new Error("request failed"), { status, code });
}
