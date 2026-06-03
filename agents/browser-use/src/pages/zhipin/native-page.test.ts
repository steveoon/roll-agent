import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { NativeCdpController, NativeCdpMouseEventInput } from "@roll-agent/browser";
import { ZhipinNativePagePort } from "./native-page.ts";

function createPort(
  evaluateJson: (expression: string) => Promise<unknown>,
  controllerOverrides: Partial<
    Pick<NativeCdpController, "dispatchMouseEvent" | "dispatchKeyEvent" | "insertText">
  > = {},
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
  it("accepts a chat reload target from the realtime page URL", async () => {
    const port = createPort(async (expression) => {
      assert.equal(expression, "location.href");
      return "https://www.zhipin.com/web/chat/index";
    });

    assert.deepEqual(await port.inspectChatReloadTarget(), {
      ok: true,
      url: "https://www.zhipin.com/web/chat/index",
    });
  });

  it("rejects a chat reload target when the realtime page URL is no longer chat", async () => {
    const port = createPort(async (expression) => {
      assert.equal(expression, "location.href");
      return "https://www.zhipin.com/web/user/safe/verify";
    });

    const result = await port.inspectChatReloadTarget();

    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.url, "https://www.zhipin.com/web/user/safe/verify");
      assert.equal(result.skippedReason, "not_chat_page");
      assert.match(result.error, /不是沟通页/);
    }
  });

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

  it("opens a chat through native candidate matching and mouse input", async () => {
    const mouseInputs: NativeCdpMouseEventInput[] = [];
    const port = createPort(
      async (expression) => {
        if (expression.includes("location.href.includes")) {
          return true;
        }
        if (expression.includes("items.map((item, idx)")) {
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
          ];
        }
        if (expression.includes("const expected =")) {
          assert.match(expression, /conversation-1/);
          return { found: true, x: 88, y: 216 };
        }
        if (expression.includes('const selected = document.querySelector(".geek-item.selected")')) {
          return {
            conversationId: "conversation-1",
            candidateId: "geek-1",
            candidateName: "李四",
          };
        }
        if (expression.includes('const rootSelectors = [".chat-conversation"')) {
          return { candidateName: "李四" };
        }
        return false;
      },
      {
        async dispatchMouseEvent(input) {
          mouseInputs.push(input);
        },
      },
    );

    const result = await port.openChat({
      conversationId: "conversation-1",
      candidateName: undefined,
      index: undefined,
    });

    assert.equal(result.found, true);
    assert.equal(result.conversationId, "conversation-1");
    assert.equal(mouseInputs.filter((input) => input.type === "mouseMoved").length > 1, true);
    assert.equal(mouseInputs.at(-2)?.type, "mousePressed");
    assert.equal(mouseInputs.at(-1)?.type, "mouseReleased");
    assert.equal(mouseInputs.at(-1)?.x, 88);
    assert.equal(mouseInputs.at(-1)?.y, 216);
  });

  it("resets to the chat-list top before scanning for an explicit chat target", async () => {
    let scrollTop = 520;
    const maxScrollTop = 1040;
    const mouseInputs: NativeCdpMouseEventInput[] = [];
    const visibleWindows: string[] = [];

    const port = createPort(
      async (expression) => {
        if (expression.includes("location.href.includes")) {
          return true;
        }
        if (expression.includes("const expected =")) {
          assert.equal(scrollTop, 0);
          assert.match(expression, /conversation-1/);
          return { found: true, x: 88, y: 216 };
        }
        if (
          expression.includes('.user-list.b-scroll-stable [role=\\"listitem\\"]') &&
          !expression.includes('const surface = "chat-list"')
        ) {
          visibleWindows.push(scrollTop === 0 ? "top" : "lower");
          return scrollTop === 0
            ? [
                {
                  conversationId: "conversation-1",
                  candidateId: "geek-1",
                  name: "李四",
                  index: 0,
                  position: "后端工程师",
                  hasUnread: true,
                  unreadCount: 1,
                  lastMessageTime: "15:41",
                  messagePreview: "方便聊聊吗",
                },
              ]
            : [
                {
                  conversationId: "conversation-lower",
                  candidateId: "geek-lower",
                  name: "王五",
                  index: 0,
                  position: "前端工程师",
                  hasUnread: true,
                  unreadCount: 1,
                  lastMessageTime: "昨天",
                  messagePreview: "可以沟通",
                },
              ];
        }
        if (expression.includes("nativeWheelTarget")) {
          return { found: true, x: 96, y: 240 };
        }
        if (expression.includes('const surface = "chat-list"')) {
          return {
            containerFound: true,
            containerLabel: "user-list.b-scroll-stable",
            scrollTop,
            scrollHeight: 2096,
            clientHeight: 1056,
            itemCount: 40,
            atStart: scrollTop <= 0,
            atEnd: scrollTop >= maxScrollTop,
          };
        }
        if (expression.includes('const selected = document.querySelector(".geek-item.selected")')) {
          return {
            conversationId: "conversation-1",
            candidateId: "geek-1",
            candidateName: "李四",
          };
        }
        if (expression.includes('const rootSelectors = [".chat-conversation"')) {
          return { candidateName: "李四" };
        }
        return false;
      },
      {
        async dispatchMouseEvent(input) {
          mouseInputs.push(input);
          if (input.type !== "mouseWheel") return;
          scrollTop = Math.max(0, Math.min(maxScrollTop, scrollTop + (input.deltaY ?? 0)));
        },
      },
    );

    const result = await port.openChat({
      conversationId: "conversation-1",
      candidateName: undefined,
      index: undefined,
      maxScrolls: 2,
    });

    assert.equal(result.found, true);
    assert.equal(result.conversationId, "conversation-1");
    assert.deepEqual(visibleWindows, ["lower", "top"]);
    assert.equal(
      mouseInputs.some((input) => input.type === "mouseWheel" && (input.deltaY ?? 0) < 0),
      true,
    );
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

  it("clicks a recommend greet button without Playwright locators or DOM markers", async () => {
    const mouseInputs: NativeCdpMouseEventInput[] = [];
    const port = createPort(
      async (expression) => {
        assert.doesNotMatch(expression, /data-roll/);
        if (expression.includes("hasGreetButton")) {
          assert.match(expression, /\.candidate-card-wrap/);
          return {
            found: true,
            cardSelector: ".candidate-card-wrap",
            candidateId: "candidate-1",
            name: "赵慧珍",
            hasGreetButton: true,
          };
        }
        if (expression.includes("button.btn.btn-greet")) {
          return { found: true, x: 160, y: 260 };
        }
        return false;
      },
      {
        async dispatchMouseEvent(input) {
          mouseInputs.push(input);
        },
      },
    );

    const result = await port.clickRecommendGreet(0);

    assert.equal(result.clicked, true);
    assert.equal(result.candidateId, "candidate-1");
    assert.equal(mouseInputs.filter((input) => input.type === "mouseMoved").length > 1, true);
    assert.equal(mouseInputs.at(-2)?.type, "mousePressed");
    assert.equal(mouseInputs.at(-1)?.type, "mouseReleased");
    assert.equal(mouseInputs.at(-1)?.x, 160);
    assert.equal(mouseInputs.at(-1)?.y, 260);
  });

  it("lists recommend jobs without selecting another job", async () => {
    let selectorOpen = false;
    const mouseInputs: NativeCdpMouseEventInput[] = [];
    const port = createPort(
      async (expression) => {
        if (expression.includes("recommendUrlMarkers")) {
          return true;
        }
        if (expression.includes(".candidate-card-wrap")) {
          return true;
        }
        if (expression.includes("currentLabel") && expression.includes(".job-selecter-wrap")) {
          return {
            found: true,
            isOpen: selectorOpen,
            currentLabel: "服务员 _ 上海 5-6K",
            currentValue: "job-1",
            options: [
              {
                index: 0,
                value: "job-1",
                label: "服务员 _ 上海 5-6K",
                isCurrent: true,
              },
              {
                index: 1,
                value: "job-2",
                label: "后厨 _ 上海 6-7K",
                isCurrent: false,
              },
            ],
          };
        }
        if (expression.includes(".ui-dropmenu-label")) {
          return { found: true, x: 620, y: 100 };
        }
        assert.doesNotMatch(expression, /\.job-list \.job-item/);
        return false;
      },
      {
        async dispatchMouseEvent(input) {
          mouseInputs.push(input);
          if (input.type === "mouseReleased" && input.x === 620) {
            selectorOpen = true;
          }
        },
      },
    );

    const result = await port.listRecommendJobs();

    assert.equal(result.success, true);
    assert.equal(result.status, "listed");
    assert.equal(result.availableCount, 2);
    assert.equal(result.canSwitch, true);
    assert.equal(result.current?.value, "job-1");
    assert.equal(result.options[1]?.value, "job-2");
    assert.equal(mouseInputs.filter((input) => input.type === "mousePressed").length, 1);
  });

  it("does not report canSwitch when the only recommend job has no current marker", async () => {
    let selectorOpen = false;
    const port = createPort(
      async (expression) => {
        if (expression.includes("recommendUrlMarkers")) {
          return true;
        }
        if (expression.includes(".candidate-card-wrap")) {
          return true;
        }
        if (expression.includes("currentLabel") && expression.includes(".job-selecter-wrap")) {
          return {
            found: true,
            isOpen: selectorOpen,
            currentLabel: "",
            currentValue: "",
            options: [
              {
                index: 0,
                value: "job-1",
                label: "服务员 _ 上海 5-6K",
                isCurrent: false,
              },
            ],
          };
        }
        if (expression.includes(".ui-dropmenu-label")) {
          return { found: true, x: 620, y: 100 };
        }
        return false;
      },
      {
        async dispatchMouseEvent(input) {
          if (input.type === "mouseReleased" && input.x === 620) {
            selectorOpen = true;
          }
        },
      },
    );

    const result = await port.listRecommendJobs();

    assert.equal(result.success, true);
    assert.equal(result.availableCount, 1);
    assert.equal(result.canSwitch, false);
    assert.equal(result.current, undefined);
  });

  it("selects a recommend job by stable job value", async () => {
    let selectorOpen = false;
    let selectedValue = "job-1";
    const mouseInputs: NativeCdpMouseEventInput[] = [];
    const port = createPort(
      async (expression) => {
        if (expression.includes("recommendUrlMarkers")) {
          return true;
        }
        if (expression.includes(".candidate-card-wrap")) {
          return true;
        }
        if (expression.includes("currentLabel") && expression.includes(".job-selecter-wrap")) {
          return {
            found: true,
            isOpen: selectorOpen,
            currentLabel: selectedValue === "job-2" ? "后厨 _ 上海 6-7K" : "服务员 _ 上海 5-6K",
            currentValue: selectedValue,
            options: [
              {
                index: 0,
                value: "job-1",
                label: "服务员 _ 上海 5-6K",
                isCurrent: selectedValue === "job-1",
              },
              {
                index: 1,
                value: "job-2",
                label: "后厨 _ 上海 6-7K",
                isCurrent: selectedValue === "job-2",
              },
            ],
          };
        }
        if (expression.includes(".ui-dropmenu-label")) {
          return { found: true, x: 620, y: 100 };
        }
        if (expression.includes(".job-list .job-item")) {
          selectedValue = "job-2";
          return { found: true, x: 660, y: 220 };
        }
        return false;
      },
      {
        async dispatchMouseEvent(input) {
          mouseInputs.push(input);
          if (input.type === "mouseReleased" && input.x === 620) {
            selectorOpen = true;
          }
        },
      },
    );

    const result = await port.selectRecommendJob({ jobValue: "job-2" });

    assert.equal(result.success, true);
    assert.equal(result.status, "selected");
    assert.equal(result.selected?.value, "job-2");
    assert.equal(result.current?.value, "job-2");
    assert.equal(mouseInputs.filter((input) => input.type === "mousePressed").length, 2);
  });

  it("force-clicks the current recommend job when requested", async () => {
    let selectorOpen = false;
    const clickedTargets: string[] = [];
    const port = createPort(
      async (expression) => {
        if (expression.includes("recommendUrlMarkers")) {
          return true;
        }
        if (expression.includes(".candidate-card-wrap")) {
          return true;
        }
        if (expression.includes("currentLabel") && expression.includes(".job-selecter-wrap")) {
          return {
            found: true,
            isOpen: selectorOpen,
            currentLabel: "服务员 _ 上海 5-6K",
            currentValue: "job-1",
            options: [
              {
                index: 0,
                value: "job-1",
                label: "服务员 _ 上海 5-6K",
                isCurrent: true,
              },
            ],
          };
        }
        if (expression.includes(".ui-dropmenu-label")) {
          clickedTargets.push("label");
          return { found: true, x: 620, y: 100 };
        }
        if (expression.includes(".job-list .job-item")) {
          clickedTargets.push("job");
          return { found: true, x: 660, y: 220 };
        }
        return false;
      },
      {
        async dispatchMouseEvent(input) {
          if (input.type === "mouseReleased" && input.x === 620) {
            selectorOpen = true;
          }
        },
      },
    );

    const result = await port.selectRecommendJob({ jobValue: "job-1", forceClick: true });

    assert.equal(result.success, true);
    assert.equal(result.status, "selected");
    assert.deepEqual(clickedTargets, ["label", "job"]);
  });

  it("sends chat replies through native focus, key events, insertText, and native send click", async () => {
    const keyInputs: Array<Record<string, unknown>> = [];
    const inserted: string[] = [];
    const mouseInputs: NativeCdpMouseEventInput[] = [];
    const evalExpressions: string[] = [];
    const port = createPort(
      async (expression) => {
        evalExpressions.push(expression);
        if (expression.includes("#boss-chat-editor-input")) {
          return { found: true, x: 400, y: 700 };
        }
        if (expression.includes(".submit-content")) {
          return { found: true, x: 860, y: 720 };
        }
        return false;
      },
      {
        async dispatchMouseEvent(input) {
          mouseInputs.push(input);
        },
        async dispatchKeyEvent(input) {
          keyInputs.push(input);
        },
        async insertText(text) {
          inserted.push(text);
        },
      },
    );

    const result = await port.sendChatReply("您好，方便沟通吗");

    assert.equal(result.success, true);
    assert.deepEqual(inserted, ["您好，方便沟通吗"]);
    assert.equal(
      keyInputs.some((input) => input["key"] === "Backspace"),
      true,
    );
    assert.equal(
      evalExpressions.some((expression) => expression.includes("isContentEditable")),
      true,
    );
    assert.equal(
      keyInputs.every((input) => input["modifiers"] === undefined),
      true,
    );
    assert.equal(mouseInputs.filter((input) => input.type === "mousePressed").length, 2);
  });

  it("exchanges WeChat through native button and confirm clicks", async () => {
    let phase = 0;
    const mouseInputs: NativeCdpMouseEventInput[] = [];
    const port = createPort(
      async (expression) => {
        if (expression.includes("operate-exchange-left")) {
          phase = 1;
          return { found: true, x: 720, y: 640 };
        }
        if (expression.includes("exchange-tooltip") && expression.includes("return true")) {
          return true;
        }
        if (expression.includes("boss-btn-primary")) {
          phase = 2;
          return { found: true, x: 760, y: 520 };
        }
        if (expression.includes("message-card-top-wrap")) {
          return "wxid_12345";
        }
        return false;
      },
      {
        async dispatchMouseEvent(input) {
          mouseInputs.push(input);
        },
      },
    );

    const result = await port.exchangeWechat();

    assert.equal(result.success, true);
    assert.equal(result.wechatNumber, "wxid_12345");
    assert.equal(phase, 2);
    assert.equal(mouseInputs.filter((input) => input.type === "mousePressed").length, 2);
  });

  it("clicks sidebar sections through narrow native targets", async () => {
    const dispatched: Array<Record<string, unknown>> = [];
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
            assert.match(expression, /web\/chat\/recommend/);
            return { found: true, x: 36, y: 72 };
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

    const clicked = await port.clickSidebarSection("recommend");

    assert.equal(clicked, true);
    assert.equal(dispatched.filter((input) => input["type"] === "mouseMoved").length > 1, true);
    assert.deepEqual(dispatched.at(-2), {
      type: "mousePressed",
      x: 36,
      y: 72,
      button: "left",
      buttons: 1,
      clickCount: 1,
    });
    assert.deepEqual(dispatched.at(-1), {
      type: "mouseReleased",
      x: 36,
      y: 72,
      button: "left",
      buttons: 0,
      clickCount: 1,
    });
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
