import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  composeResumeCanvasArea,
  resolveRecommendTargetKind,
  resolveResumeCandidateIdentity,
  resolveResumeCardSelector,
  ZHIPIN_RESUME_CANVAS_SELECTOR,
  ZHIPIN_RESUME_CARD_FALLBACK_SELECTOR,
  ZHIPIN_RESUME_CARD_LIST_SELECTOR,
  ZHIPIN_RESUME_CARD_PRIMARY_SELECTOR,
  ZHIPIN_RESUME_CLOSE_ELEMENT_SELECTORS,
  ZHIPIN_RESUME_CLOSE_SCOPE_SELECTOR,
  ZHIPIN_RESUME_DIALOG_SELECTOR,
  ZHIPIN_RESUME_IFRAME_SELECTOR,
  ZHIPIN_RESUME_RECOMMEND_FRAME_NAME,
  ZHIPIN_RESUME_RECOMMEND_FRAME_SELECTOR,
  ZHIPIN_RESUME_RECOMMEND_FRAME_URL_MARKER,
} from "./resume-dom-contract.ts";

describe("zhipin resume DOM contract", () => {
  it("records recommend frame target priority", () => {
    assert.equal(ZHIPIN_RESUME_RECOMMEND_FRAME_NAME, "recommendFrame");
    assert.equal(ZHIPIN_RESUME_RECOMMEND_FRAME_URL_MARKER, "recommend");
    assert.equal(ZHIPIN_RESUME_RECOMMEND_FRAME_SELECTOR, "#recommendFrame");
    assert.equal(
      resolveRecommendTargetKind({
        hasNamedRecommendFrame: true,
        hasRecommendUrlFrame: true,
      }),
      "named-frame",
    );
    assert.equal(
      resolveRecommendTargetKind({
        hasNamedRecommendFrame: false,
        hasRecommendUrlFrame: true,
      }),
      "recommend-url-frame",
    );
    assert.equal(
      resolveRecommendTargetKind({
        hasNamedRecommendFrame: false,
        hasRecommendUrlFrame: false,
      }),
      "main-page",
    );
  });

  it("records resume candidate card selector priority", () => {
    assert.equal(ZHIPIN_RESUME_CARD_PRIMARY_SELECTOR, ".candidate-card-wrap");
    assert.equal(ZHIPIN_RESUME_CARD_FALLBACK_SELECTOR, "[data-geek], .geek-item");
    assert.equal(ZHIPIN_RESUME_CARD_LIST_SELECTOR, ".candidate-card-wrap, [data-geek], .geek-item");
    assert.equal(resolveResumeCardSelector(1), ".candidate-card-wrap");
    assert.equal(resolveResumeCardSelector(0), "[data-geek], .geek-item");
  });

  it("records candidate identity extraction precedence", () => {
    assert.deepEqual(
      resolveResumeCandidateIdentity({
        ownDataGeek: " own-id ",
        childDataGeek: "child-id",
        nameText: " 张三 ",
      }),
      { candidateId: "own-id", name: "张三" },
    );
    assert.deepEqual(
      resolveResumeCandidateIdentity({
        ownDataGeek: null,
        childDataGeek: " child-id ",
        nameText: " 李四 ",
      }),
      { candidateId: "child-id", name: "李四" },
    );
  });

  it("scopes close button search to visible dialog containers", () => {
    assert.equal(
      ZHIPIN_RESUME_CLOSE_SCOPE_SELECTOR,
      `${ZHIPIN_RESUME_DIALOG_SELECTOR}, .recommendV2`,
    );
    assert.deepEqual(
      [...ZHIPIN_RESUME_CLOSE_ELEMENT_SELECTORS],
      [".boss-popup__close", ".close-btn", ".dialog-close", ".modal-close"],
    );
  });

  it("records resume iframe and canvas path", () => {
    assert.equal(ZHIPIN_RESUME_IFRAME_SELECTOR, 'iframe[src*="c-resume"]');
    assert.equal(ZHIPIN_RESUME_CANVAS_SELECTOR, "canvas#resume, div#resume canvas");
  });

  it("composes screenshot area from nested frame and canvas rects", () => {
    assert.deepEqual(
      composeResumeCanvasArea({
        recommendFrameRect: { x: 100.4, y: 50.2 },
        resumeFrameRect: { x: 10.3, y: 20.4 },
        canvasRect: { x: 4.4, y: 6.5, width: 300.2, height: 480.8 },
      }),
      { x: 115, y: 77, width: 300, height: 481 },
    );
  });
});
