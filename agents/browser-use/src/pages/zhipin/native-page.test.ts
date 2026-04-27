import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { NativeCdpController, NativeCdpMouseEventInput } from "@roll-agent/browser";
import { ZhipinNativePagePort } from "./native-page.ts";

function createPort(
  evaluateJson: (expression: string) => Promise<unknown>,
  controllerOverrides: Partial<Pick<NativeCdpController, "dispatchMouseEvent">> = {},
): ZhipinNativePagePort {
  return new ZhipinNativePagePort({
    target: {
      targetId: "target-boss",
      type: "page",
      title: "BOSS直聘",
      url: "https://www.zhipin.com/web/chat/index",
      webSocketDebuggerUrl: "ws://127.0.0.1/devtools/page/target-boss",
    },
    controller: {
      evaluateJson,
      async getFrameTree() {
        return {
          frame: {
            id: "main-frame",
            url: "https://www.zhipin.com/web/chat/index",
          },
        };
      },
      async createIsolatedWorld() {
        return 7;
      },
      async dispatchMouseEvent(_input: NativeCdpMouseEventInput) {},
      async bringToFront() {},
      close() {},
      ...controllerOverrides,
    } as unknown as NativeCdpController,
  });
}

describe("ZhipinNativePagePort", () => {
  it("reads chat candidates from the native chat item DOM expression", async () => {
    const port = createPort(async (expression) => {
      assert.match(expression, /\.user-list\.b-scroll-stable \[role=\\"listitem\\"\], \.geek-item/);
      return [
        {
          conversationId: "conversation-1",
          candidateId: "geek-1",
          name: "李四",
          index: 0,
          position: "后端工程师",
          hasUnread: true,
          unreadCount: 3,
          lastMessageTime: "昨天",
          messagePreview: "方便聊聊吗",
        },
      ];
    });

    const candidates = await port.readChatCandidates({ autoScroll: false });

    assert.deepEqual(candidates, [
      {
        conversationId: "conversation-1",
        candidateId: "geek-1",
        name: "李四",
        index: 0,
        position: "后端工程师",
        hasUnread: true,
        unreadCount: 3,
        lastMessageTime: "昨天",
        messagePreview: "方便聊聊吗",
      },
    ]);
  });

  it("scrolls chat candidates through the chat-list surface container resolution", async () => {
    let readCount = 0;
    let surfaceEvaluations = 0;
    const port = createPort(async (expression) => {
      if (
        expression.includes('.user-list.b-scroll-stable [role=\\"listitem\\"]') &&
        !expression.includes('const surface = "chat-list"')
      ) {
        readCount += 1;
        return [
          {
            conversationId: "conversation-1",
            candidateId: "geek-1",
            name: "李四",
            index: 0,
            position: "后端工程师",
            hasUnread: false,
            unreadCount: 0,
            lastMessageTime: "昨天",
            messagePreview: "方便聊聊吗",
          },
          ...(readCount > 1
            ? [
                {
                  conversationId: "conversation-2",
                  candidateId: "geek-2",
                  name: "王五",
                  index: 1,
                  position: "前端工程师",
                  hasUnread: true,
                  unreadCount: 1,
                  lastMessageTime: "今天",
                  messagePreview: "可以沟通",
                },
              ]
            : []),
        ];
      }

      if (expression.includes("nativeWheelTarget")) {
        return { found: true, x: 96, y: 240 };
      }

      if (expression.includes('const surface = "chat-list"')) {
        surfaceEvaluations += 1;
        assert.match(expression, /\.user-list\.b-scroll-stable/);
        assert.match(expression, /\.chat-user \.user-container/);
        assert.match(expression, /item-ancestor/);
        assert.doesNotMatch(expression, /\?\? targets\[0\]/);
        assert.doesNotMatch(expression, /querySelector\("\.chat-list-wrap, \.geek-item"\)/);
        assert.match(expression, /isVisible/);
        return expression.includes("explicitDistance")
          ? {
              containerFound: true,
              containerLabel: "item-ancestor",
              scrollTop: 425,
              scrollHeight: 1000,
              clientHeight: 500,
              itemCount: 1,
              atStart: false,
              atEnd: false,
            }
          : {
              containerFound: true,
              containerLabel: "item-ancestor",
              scrollTop: 0,
              scrollHeight: 1000,
              clientHeight: 500,
              itemCount: 1,
              atStart: true,
              atEnd: false,
            };
      }

      return false;
    });

    const candidates = await port.readChatCandidates({
      autoScroll: true,
      maxScrolls: 1,
      targetCount: 2,
    });

    assert.equal(candidates.length, 2);
    assert.equal(surfaceEvaluations, 2);
  });

  it("falls back to native mouse wheel when chat-list has items but no scrollable node", async () => {
    let readCount = 0;
    const wheelInputs: NativeCdpMouseEventInput[] = [];
    const port = createPort(
      async (expression) => {
        if (
          expression.includes('.user-list.b-scroll-stable [role=\\"listitem\\"]') &&
          !expression.includes('const surface = "chat-list"')
        ) {
          readCount += 1;
          return [
            {
              conversationId: "conversation-1",
              candidateId: "geek-1",
              name: "李四",
              index: 0,
              position: "后端工程师",
              hasUnread: false,
              unreadCount: 0,
              lastMessageTime: "昨天",
              messagePreview: "方便聊聊吗",
            },
            ...(readCount > 1
              ? [
                  {
                    conversationId: "conversation-2",
                    candidateId: "geek-2",
                    name: "王五",
                    index: 1,
                    position: "前端工程师",
                    hasUnread: true,
                    unreadCount: 1,
                    lastMessageTime: "今天",
                    messagePreview: "可以沟通",
                  },
                ]
              : []),
          ];
        }

        if (expression.includes("nativeWheelTarget")) {
          return { found: true, x: 96, y: 240 };
        }

        if (expression.includes('const surface = "chat-list"')) {
          return {
            containerFound: false,
            containerLabel: "user-list.b-scroll-stable",
            scrollTop: 0,
            scrollHeight: 0,
            clientHeight: 0,
            itemCount: 41,
            atStart: true,
            atEnd: true,
          };
        }

        return false;
      },
      {
        async dispatchMouseEvent(input) {
          wheelInputs.push(input);
        },
      },
    );

    const candidates = await port.readChatCandidates({
      autoScroll: true,
      maxScrolls: 1,
      targetCount: 2,
    });

    assert.equal(candidates.length, 2);
    const wheelEvent = wheelInputs.find((input) => input.type === "mouseWheel");
    assert.equal(wheelInputs[0]?.type, "mouseMoved");
    assert.equal(wheelEvent?.x, 96);
    assert.equal(wheelEvent?.y, 240);
    assert.equal(wheelEvent?.deltaY, 520);
  });

  it("scrolls overflow-hidden chat-list through native wheel and preserves native scroll metrics", async () => {
    let surfaceEvaluations = 0;
    const wheelInputs: NativeCdpMouseEventInput[] = [];
    const port = createPort(
      async (expression) => {
        if (expression.includes("nativeWheelTarget")) {
          return { found: true, x: 96, y: 240 };
        }

        if (expression.includes('const surface = "chat-list"')) {
          surfaceEvaluations += 1;
          return {
            containerFound: true,
            containerLabel: "user-list.b-scroll-stable",
            scrollTop: surfaceEvaluations === 1 ? 0 : 520,
            scrollHeight: 7830,
            clientHeight: 1056,
            itemCount: 81,
            atStart: surfaceEvaluations === 1,
            atEnd: false,
          };
        }

        return false;
      },
      {
        async dispatchMouseEvent(input) {
          wheelInputs.push(input);
        },
      },
    );

    const result = await port.scrollSurface("chat-list", { steps: 1, settleMs: 1 });

    assert.equal(result.success, true);
    assert.equal(result.stepsCompleted, 1);
    assert.equal(result.before.containerLabel, "user-list.b-scroll-stable");
    assert.equal(result.after.containerFound, true);
    assert.equal(result.after.scrollTop, 520);
    assert.equal(result.after.atEnd, false);
    assert.equal(wheelInputs[0]?.type, "mouseMoved");
    assert.equal(
      wheelInputs.some((input) => input.type === "mouseWheel"),
      true,
    );
  });

  it("preserves native wheel success when the settled chat-list snapshot still lacks scroll metrics", async () => {
    let surfaceEvaluations = 0;
    const wheelInputs: NativeCdpMouseEventInput[] = [];
    const port = createPort(
      async (expression) => {
        if (expression.includes("nativeWheelTarget")) {
          return { found: true, x: 96, y: 240 };
        }

        if (expression.includes('const surface = "chat-list"')) {
          surfaceEvaluations += 1;
          return {
            containerFound: false,
            containerLabel: "user-list.b-scroll-stable",
            scrollTop: 0,
            scrollHeight: 0,
            clientHeight: 0,
            itemCount: 81,
            atStart: true,
            atEnd: true,
          };
        }

        return false;
      },
      {
        async dispatchMouseEvent(input) {
          wheelInputs.push(input);
        },
      },
    );

    const result = await port.scrollSurface("chat-list", { steps: 1, settleMs: 1 });

    assert.equal(result.success, true);
    assert.equal(result.stepsCompleted, 1);
    assert.equal(result.before.containerFound, false);
    assert.equal(result.after.containerFound, true);
    assert.equal(result.after.containerLabel, "user-list.b-scroll-stable");
    assert.equal(result.after.atEnd, false);
    assert.equal(surfaceEvaluations, 3);
    assert.equal(wheelInputs[0]?.type, "mouseMoved");
    assert.equal(
      wheelInputs.some((input) => input.type === "mouseWheel"),
      true,
    );
  });

  it("reads username evidence from native DOM expression", async () => {
    const port = createPort(async (expression) => {
      assert.match(expression, /user-name/);
      return [
        {
          text: "王五",
          strategy: "css-fallback",
          priority: 4,
          source: ".user-name",
        },
      ];
    });

    const evidence = await port.readUsernameEvidence();

    assert.deepEqual(evidence, [
      {
        text: "王五",
        strategy: "css-fallback",
        priority: 4,
        source: ".user-name",
      },
    ]);
  });

  it("does not treat chat-list .geek-item as recommend surface evidence", async () => {
    const port = createPort(async (expression) => {
      assert.match(expression, /hasRecommendUrl/);
      assert.match(expression, /href\.includes\("\/web\/chat\/index"\)/);
      assert.doesNotMatch(
        expression,
        /querySelector\("\.candidate-card-wrap, \[data-geek\], \.geek-item"\)/,
      );
      assert.doesNotMatch(expression, /recommend-list-wrap/);
      return false;
    });

    assert.equal(await port.isRecommendSurfaceOpen(), false);
  });

  it("keeps recommend surface detection aligned with url and frame evidence", async () => {
    const port = createPort(async (expression) => {
      assert.match(expression, /\/web\/chat\/recommend/);
      assert.doesNotMatch(expression, /\/web\/geek\/recommend/);
      assert.match(expression, /#recommendFrame/);
      assert.match(expression, /iframe\[name=\\"recommendFrame\\"\]/);
      assert.match(expression, /iframe\[src\*=\\"recommend\\"\]/);
      return true;
    });

    assert.equal(await port.isRecommendSurfaceOpen(), true);
  });

  it("waits for native recommend list cards separately from recommend surface readiness", async () => {
    let cardChecks = 0;
    const port = createPort(async (expression) => {
      if (
        expression.includes("document.querySelector") &&
        expression.includes(".candidate-card-wrap")
      ) {
        assert.match(expression, /\.candidate-card-wrap, \[data-geek\], \.geek-item/);
        cardChecks += 1;
        return cardChecks >= 2;
      }

      assert.match(expression, /hasRecommendUrl/);
      return true;
    });

    assert.equal(await port.waitForRecommendList(1_000), true);
    assert.equal(cardChecks, 2);
  });

  it("does not treat recommend URL alone as a loaded native recommend list", async () => {
    const port = createPort(async (expression) => {
      if (expression.includes("root.querySelector")) {
        return false;
      }

      assert.match(expression, /hasRecommendUrl/);
      return true;
    });

    assert.equal(await port.waitForRecommendList(1), false);
  });

  it("waits for native recommend list cards inside the recommend frame", async () => {
    const contextIds: number[] = [];
    const port = new ZhipinNativePagePort({
      target: {
        targetId: "target-boss",
        type: "page",
        title: "BOSS直聘",
        url: "https://www.zhipin.com/web/chat/recommend",
        webSocketDebuggerUrl: "ws://127.0.0.1/devtools/page/target-boss",
      },
      controller: {
        async evaluateJson(expression: string, options?: { readonly contextId?: number }) {
          if (expression.includes("hasRecommendUrl")) {
            return true;
          }
          if (options?.contextId !== undefined) {
            contextIds.push(options.contextId);
            return true;
          }
          return false;
        },
        async getFrameTree() {
          return {
            frame: {
              id: "main-frame",
              url: "https://www.zhipin.com/web/chat/recommend",
            },
            childFrames: [
              {
                frame: {
                  id: "recommend-frame",
                  name: "recommendFrame",
                  parentId: "main-frame",
                  url: "https://www.zhipin.com/web/chat/recommend/frame",
                },
              },
            ],
          };
        },
        async createIsolatedWorld(frameId: string) {
          assert.equal(frameId, "recommend-frame");
          return 99;
        },
        close() {},
      } as unknown as NativeCdpController,
    });

    assert.equal(await port.waitForRecommendList(1_000), true);
    assert.deepEqual(contextIds, [99]);
  });

  it("reads recommend candidates from the recommend frame when the main document has no cards", async () => {
    const port = new ZhipinNativePagePort({
      target: {
        targetId: "target-boss",
        type: "page",
        title: "BOSS直聘",
        url: "https://www.zhipin.com/web/chat/recommend",
        webSocketDebuggerUrl: "ws://127.0.0.1/devtools/page/target-boss",
      },
      controller: {
        async evaluateJson(expression: string, options?: { readonly contextId?: number }) {
          const inFrame = options?.contextId === 99;
          if (expression.includes("items.map")) {
            return inFrame
              ? [
                  {
                    candidateId: "candidate-frame-1",
                    name: "周六",
                    age: "25岁",
                    experience: "3年",
                    education: "本科",
                    workStatus: "在职",
                    company: "花卷科技",
                    currentPosition: "前端工程师",
                    expectedLocation: "上海",
                    expectedPosition: "前端工程师",
                    expectedSalary: "20-30K",
                    tags: ["React"],
                    buttonText: "打招呼",
                  },
                ]
              : [];
          }
          if (expression.includes("containerFound")) {
            return {
              containerFound: inFrame,
              containerLabel: inFrame ? "recommend-list" : "document",
              scrollTop: 0,
              scrollHeight: inFrame ? 1000 : 600,
              clientHeight: 600,
              itemCount: inFrame ? 1 : 0,
              atStart: true,
              atEnd: false,
            };
          }
          if (expression.includes("hasRecommendUrl")) {
            return true;
          }
          return false;
        },
        async getFrameTree() {
          return {
            frame: {
              id: "main-frame",
              url: "https://www.zhipin.com/web/chat/recommend",
            },
            childFrames: [
              {
                frame: {
                  id: "recommend-frame",
                  name: "recommendFrame",
                  parentId: "main-frame",
                  url: "https://www.zhipin.com/web/chat/recommend/frame",
                },
              },
            ],
          };
        },
        async createIsolatedWorld(frameId: string) {
          assert.equal(frameId, "recommend-frame");
          return 99;
        },
        close() {},
      } as unknown as NativeCdpController,
    });

    const result = await port.readRecommendCandidates({ autoScroll: false });

    assert.equal(result.success, true);
    assert.equal(result.uniqueCount, 1);
    assert.equal(result.items[0]?.candidateId, "candidate-frame-1");
  });

  it("clicks sidebar sections through narrow native targets", async () => {
    const dispatched: Array<Record<string, unknown>> = [];
    const resolved: Array<Record<string, unknown>> = [];
    const port = new ZhipinNativePagePort({
      target: {
        targetId: "target-boss",
        type: "page",
        title: "BOSS直聘",
        url: "https://www.zhipin.com/web/chat/index",
        webSocketDebuggerUrl: "ws://127.0.0.1/devtools/page/target-boss",
      },
      controller: {
        locator(selector: string) {
          assert.match(selector, /web\/chat\/recommend/);
          return {
            async click() {
              return { success: false };
            },
          };
        },
        async evaluateJson(expression: string) {
          if (expression.includes("querySelectorAll(selector)")) {
            return { found: false };
          }
          assert.match(expression, /interactiveTargets/);
          assert.match(expression, /exactTextTargets/);
          assert.doesNotMatch(
            expression,
            /sidebar\.querySelectorAll\('a, button, \[role="link"\], \[role="button"\], span, div'\)/,
          );
          return { found: true, x: 36, y: 72 };
        },
        async dispatchMouseEvent(input: Record<string, unknown>) {
          dispatched.push(input);
        },
        close() {},
      } as unknown as NativeCdpController,
    });

    const clicked = await port.clickSidebarSection("recommend", {
      onTargetResolved: async (target) => {
        resolved.push(target);
      },
    });

    assert.equal(clicked, true);
    assert.deepEqual(resolved, [{ found: true, x: 36, y: 72 }]);
    assert.deepEqual(dispatched, [
      { type: "mouseMoved", x: 36, y: 72, buttons: 0 },
      { type: "mousePressed", x: 36, y: 72, button: "left", buttons: 1, clickCount: 1 },
      { type: "mouseReleased", x: 36, y: 72, button: "left", buttons: 0, clickCount: 1 },
    ]);
  });

  it("gates recommend surface detection on not being on the chat URL", async () => {
    const port = createPort(async (expression) => {
      assert.match(expression, /href\.includes\("\/web\/chat\/index"\)/);
      return false;
    });

    assert.equal(await port.isRecommendSurfaceOpen(), false);
  });

  it("fails closed for recommend candidates when not on a recommend surface", async () => {
    const port = createPort(async (expression) => {
      if (expression.includes("containerFound")) {
        return {
          containerFound: false,
          containerLabel: "",
          scrollTop: 0,
          scrollHeight: 0,
          clientHeight: 0,
          itemCount: 0,
          atStart: true,
          atEnd: true,
        };
      }
      assert.match(expression, /return \[\];/);
      return [];
    });

    const result = await port.readRecommendCandidates({ autoScroll: false });

    assert.equal(result.success, false);
    assert.deepEqual(result.items, []);
    assert.equal(result.before.containerFound, false);
  });
});
