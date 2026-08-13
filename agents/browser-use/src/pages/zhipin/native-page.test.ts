import assert from "node:assert/strict";
import { describe, it, type TestContext } from "node:test";
import type {
  BrowserContextManager,
  BrowserInspectablePage,
  BrowserRuntime,
  NativeCdpController,
  NativeCdpMouseEventInput,
} from "@roll-agent/browser";
import { StructuredToolError } from "@roll-agent/sdk";
import {
  parseZhipinCandidateProfileTokens,
  openZhipinNativePagePort,
  ZhipinNativePagePort,
} from "./native-page.ts";
import { ZHIPIN_ACCESS_RESTRICTED_CODE } from "./risk-page.ts";
import { ZHIPIN_SELECTORS } from "./selectors.ts";

const VIRTUAL_ELAPSED = {
  scrollsChatListWhileWaiting: 792,
  opensChatThroughNativeMatching: 814,
  resetsToChatListTop: 1158,
  scrollsCandidatesThroughSurface: 644,
  fallsBackToNativeWheel: 644,
  scrollsOverflowHiddenChatList: 345,
  preservesNativeWheelSuccess: 345,
  clicksRecommendGreetButton: 564,
  listsRecommendJobs: 2164,
  doesNotReportCanSwitch: 2164,
  selectsRecommendJobByValue: 2728,
  forceClicksCurrentRecommendJob: 2728,
  appliesCityDistrictLocationFilter: 3284,
  sendsChatReplies: 2374,
  exchangesWechat: 2928,
  clicksSidebarSections: 564,
} as const;

function enableHumanRhythmClock(t: TestContext): void {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 0 });
}

async function settleWithMockTimers<T>(t: TestContext, promise: Promise<T>): Promise<T> {
  let settled = false;
  const tracked = promise.finally(() => {
    settled = true;
  });
  for (let guard = 0; guard < 10_000; guard += 1) {
    if (settled) {
      return await tracked;
    }
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    if (!settled) {
      t.mock.timers.runAll();
    }
  }
  return assert.fail("mock-timer driver did not settle within 10000 rounds");
}

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
  it("normalizes graduation-year student labels instead of treating them as work years", () => {
    assert.deepEqual(parseZhipinCandidateProfileTokens(["吴开越", "19岁", "28年应届生", "本科"]), {
      age: "19岁",
      experience: "应届生",
      education: "本科",
    });
    assert.deepEqual(parseZhipinCandidateProfileTokens(["郭淑彬 20岁 25年应届生 本科"]), {
      age: "20岁",
      experience: "应届生",
      education: "本科",
    });
  });

  it("keeps real work-experience labels from candidate profile tokens", () => {
    assert.deepEqual(
      parseZhipinCandidateProfileTokens(["任文", "50岁", "10年以上", "初中及以下"]),
      {
        age: "50岁",
        experience: "10年以上",
        education: "初中及以下",
      },
    );
    assert.deepEqual(parseZhipinCandidateProfileTokens(["杨桃", "31岁", "10年以上", "中专/中技"]), {
      age: "31岁",
      experience: "10年以上",
      education: "中专/中技",
    });
    assert.deepEqual(
      parseZhipinCandidateProfileTokens(["任文 50岁 10年以上 初中及以下 牛人来源说明：应届生渠道"]),
      {
        age: "50岁",
        experience: "10年以上",
        education: "初中及以下",
      },
    );
  });

  it("drops impossible bare work years when age makes them implausible", () => {
    assert.deepEqual(parseZhipinCandidateProfileTokens(["郭淑彬", "20岁", "25年", "本科"]), {
      age: "20岁",
      experience: "",
      education: "本科",
    });
  });

  it("ignores graduation-year labels instead of treating them as work years", () => {
    assert.deepEqual(parseZhipinCandidateProfileTokens(["陈竞", "38岁", "06年毕业", "大专"]), {
      age: "38岁",
      experience: "",
      education: "大专",
    });
    assert.deepEqual(parseZhipinCandidateProfileTokens(["陈竞 38岁 06年毕业 大专"]), {
      age: "38岁",
      experience: "",
      education: "大专",
    });
    assert.deepEqual(parseZhipinCandidateProfileTokens(["李华", "26岁", "2020年毕业", "本科"]), {
      age: "26岁",
      experience: "",
      education: "本科",
    });
  });

  it("strips leading zeros from bare work-year labels", () => {
    assert.deepEqual(parseZhipinCandidateProfileTokens(["陈竞", "38岁", "06年", "大专"]), {
      age: "38岁",
      experience: "6年",
      education: "大专",
    });
  });

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

  it("waits for delayed native chat-list DOM readiness", async (t) => {
    t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 0 });
    let readinessChecks = 0;
    const port = createPort(async (expression) => {
      if (expression.startsWith("document.querySelector(")) {
        return true;
      }
      if (expression.includes("items.map((item, idx)")) {
        readinessChecks += 1;
        return readinessChecks >= 3
          ? [
              {
                conversationId: "conversation-1",
                candidateId: "geek-1",
                name: "李四",
                index: 0,
                position: "后端工程师",
                hasUnread: true,
                unreadCount: 1,
                lastMessageTime: "刚刚",
                messagePreview: "方便聊聊吗",
              },
            ]
          : [];
      }
      return false;
    });

    const readyPromise = port.waitForChatListReady(
      { expectedConversationId: "conversation-1" },
      1_000,
    );
    for (let step = 0; step < 4; step += 1) {
      await new Promise<void>((resolve) => setImmediate(resolve));
      t.mock.timers.tick(250);
    }

    assert.equal(await readyPromise, true);
    assert.equal(readinessChecks, 3);
  });

  it("takes a final chat-list snapshot when hydration reaches the timeout boundary", async (t) => {
    t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 0 });
    let readinessChecks = 0;
    const port = createPort(async (expression) => {
      if (expression.startsWith("document.querySelector(")) {
        return true;
      }
      if (expression.includes("items.map((item, idx)")) {
        readinessChecks += 1;
        return readinessChecks >= 2
          ? [
              {
                conversationId: "conversation-at-deadline",
                candidateId: "geek-at-deadline",
                name: "边界候选人",
                index: 0,
                position: "后端工程师",
                hasUnread: true,
                unreadCount: 1,
                lastMessageTime: "刚刚",
                messagePreview: "方便聊聊吗",
              },
            ]
          : [];
      }
      return false;
    });

    const readyPromise = port.waitForChatListReady(
      { expectedConversationId: "conversation-at-deadline" },
      250,
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    t.mock.timers.tick(250);

    assert.equal(await readyPromise, true);
    assert.equal(readinessChecks, 2);
  });

  it("accepts a visible target after the chat-list selector wait reaches its deadline", async (t) => {
    t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 0 });
    let candidateReads = 0;
    const port = createPort(async (expression) => {
      if (expression.startsWith("document.querySelector(")) {
        return false;
      }
      if (expression.includes("items.map((item, idx)")) {
        candidateReads += 1;
        return [
          {
            conversationId: "conversation-after-selector-timeout",
            candidateId: "geek-after-selector-timeout",
            name: "边界候选人",
            index: 0,
            position: "后端工程师",
            hasUnread: true,
            unreadCount: 1,
            lastMessageTime: "刚刚",
            messagePreview: "方便聊聊吗",
          },
        ];
      }
      return false;
    });

    const readyPromise = port.waitForChatListReady(
      { expectedConversationId: "conversation-after-selector-timeout" },
      250,
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    t.mock.timers.tick(250);

    assert.equal(await readyPromise, true);
    assert.equal(candidateReads, 1);
  });

  it("scrolls the native chat list while waiting for an offscreen conversation", async (t) => {
    enableHumanRhythmClock(t);
    let scrollTop = 0;
    const maxScrollTop = 520;
    const mouseInputs: NativeCdpMouseEventInput[] = [];
    const port = createPort(
      async (expression) => {
        if (expression.startsWith("document.querySelector(")) {
          return true;
        }
        if (
          expression.includes('.user-list.b-scroll-stable [role=\\"listitem\\"]') &&
          !expression.includes('const surface = "chat-list"')
        ) {
          return [
            {
              conversationId: scrollTop > 0 ? "conversation-target" : "conversation-top",
              candidateId: scrollTop > 0 ? "geek-target" : "geek-top",
              name: scrollTop > 0 ? "目标候选人" : "首屏候选人",
              index: 0,
              position: "后端工程师",
              hasUnread: true,
              unreadCount: 1,
              lastMessageTime: "刚刚",
              messagePreview: "方便聊聊吗",
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
            scrollHeight: 1_040,
            clientHeight: 520,
            itemCount: 20,
            atStart: scrollTop <= 0,
            atEnd: scrollTop >= maxScrollTop,
          };
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

    const ready = await settleWithMockTimers(
      t,
      port.waitForChatListReady({ expectedConversationId: "conversation-target" }, 2_000),
    );

    assert.equal(ready, true);
    assert.equal(
      mouseInputs.some((input) => input.type === "mouseWheel" && (input.deltaY ?? 0) > 0),
      true,
    );
    assert.equal(Date.now(), VIRTUAL_ELAPSED.scrollsChatListWhileWaiting);
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

  it("opens a chat through native candidate matching and mouse input", async (t) => {
    enableHumanRhythmClock(t);
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

    const result = await settleWithMockTimers(
      t,
      port.openChat({
        conversationId: "conversation-1",
        candidateName: undefined,
        index: undefined,
      }),
    );

    assert.equal(result.found, true);
    assert.equal(result.conversationId, "conversation-1");
    assert.equal(mouseInputs.filter((input) => input.type === "mouseMoved").length > 1, true);
    assert.equal(mouseInputs.at(-2)?.type, "mousePressed");
    assert.equal(mouseInputs.at(-1)?.type, "mouseReleased");
    assert.equal(mouseInputs.at(-1)?.x, 88);
    assert.equal(mouseInputs.at(-1)?.y, 216);
    assert.equal(Date.now(), VIRTUAL_ELAPSED.opensChatThroughNativeMatching);
  });

  it("diagnoses hidden-page state when the native chat panel does not synchronize", async (t) => {
    t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 0 });
    let clickCount = 0;
    const port = createPort(async (expression) => {
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
            hasUnread: true,
            unreadCount: 1,
            lastMessageTime: "刚刚",
            messagePreview: "方便聊聊吗",
          },
        ];
      }
      if (expression.includes("const expected =")) {
        clickCount += 1;
        return { found: true, x: 88, y: 216 };
      }
      if (expression.includes('const selected = document.querySelector(".geek-item.selected")')) {
        return {
          conversationId: "conversation-stale",
          candidateId: "geek-stale",
          candidateName: "王五",
        };
      }
      if (expression.includes('const rootSelectors = [".chat-conversation"')) {
        return { candidateName: "王五" };
      }
      if (expression === "document.visibilityState") {
        return "hidden";
      }
      return false;
    });

    const resultPromise = port.openChat({
      conversationId: "conversation-1",
      candidateName: undefined,
      index: undefined,
    });
    for (let step = 0; step < 80; step += 1) {
      await new Promise<void>((resolve) => setImmediate(resolve));
      t.mock.timers.tick(250);
    }
    const result = await resultPromise;

    assert.equal(result.found, false);
    assert.equal(clickCount, 2);
    assert.match(result.error ?? "", /document\.visibilityState=hidden/);
    assert.match(result.error ?? "", /expectedConversationId=conversation-1/);
    assert.match(result.error ?? "", /selectedConversationId=conversation-stale/);
    assert.match(result.error ?? "", /activePanelCandidateName=王五/);
    assert.match(result.error ?? "", /其他 macOS Space/);
  });

  it("resets to the chat-list top before scanning for an explicit chat target", async (t) => {
    enableHumanRhythmClock(t);
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

    const result = await settleWithMockTimers(
      t,
      port.openChat({
        conversationId: "conversation-1",
        candidateName: undefined,
        index: undefined,
        maxScrolls: 2,
      }),
    );

    assert.equal(result.found, true);
    assert.equal(result.conversationId, "conversation-1");
    assert.deepEqual(visibleWindows, ["lower", "top"]);
    assert.equal(
      mouseInputs.some((input) => input.type === "mouseWheel" && (input.deltaY ?? 0) < 0),
      true,
    );
    assert.equal(Date.now(), VIRTUAL_ELAPSED.resetsToChatListTop);
  });

  it("scrolls chat candidates through the chat-list surface container resolution", async (t) => {
    enableHumanRhythmClock(t);
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

    const candidates = await settleWithMockTimers(
      t,
      port.readChatCandidates({
        autoScroll: true,
        maxScrolls: 1,
        targetCount: 2,
      }),
    );

    assert.equal(candidates.length, 2);
    assert.equal(surfaceEvaluations, 2);
    assert.equal(Date.now(), VIRTUAL_ELAPSED.scrollsCandidatesThroughSurface);
  });

  it("falls back to native mouse wheel when chat-list has items but no scrollable node", async (t) => {
    enableHumanRhythmClock(t);
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

    const candidates = await settleWithMockTimers(
      t,
      port.readChatCandidates({
        autoScroll: true,
        maxScrolls: 1,
        targetCount: 2,
      }),
    );

    assert.equal(candidates.length, 2);
    const wheelEvent = wheelInputs.find((input) => input.type === "mouseWheel");
    assert.equal(wheelInputs[0]?.type, "mouseMoved");
    assert.equal(wheelEvent?.x, 96);
    assert.equal(wheelEvent?.y, 240);
    assert.equal(wheelEvent?.deltaY, 520);
    assert.equal(Date.now(), VIRTUAL_ELAPSED.fallsBackToNativeWheel);
  });

  it("scrolls overflow-hidden chat-list through native wheel and preserves native scroll metrics", async (t) => {
    enableHumanRhythmClock(t);
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

    const result = await settleWithMockTimers(
      t,
      port.scrollSurface("chat-list", { steps: 1, settleMs: 1 }),
    );

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
    assert.equal(Date.now(), VIRTUAL_ELAPSED.scrollsOverflowHiddenChatList);
  });

  it("preserves native wheel success when the settled chat-list snapshot still lacks scroll metrics", async (t) => {
    enableHumanRhythmClock(t);
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

    const result = await settleWithMockTimers(
      t,
      port.scrollSurface("chat-list", { steps: 1, settleMs: 1 }),
    );

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
    assert.equal(Date.now(), VIRTUAL_ELAPSED.preservesNativeWheelSuccess);
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

  it("clicks a recommend greet button without Playwright locators or DOM markers", async (t) => {
    enableHumanRhythmClock(t);
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

    const result = await settleWithMockTimers(t, port.clickRecommendGreet(0));

    assert.equal(result.clicked, true);
    assert.equal(result.candidateId, "candidate-1");
    assert.equal(mouseInputs.filter((input) => input.type === "mouseMoved").length > 1, true);
    assert.equal(mouseInputs.at(-2)?.type, "mousePressed");
    assert.equal(mouseInputs.at(-1)?.type, "mouseReleased");
    assert.equal(mouseInputs.at(-1)?.x, 160);
    assert.equal(mouseInputs.at(-1)?.y, 260);
    assert.equal(Date.now(), VIRTUAL_ELAPSED.clicksRecommendGreetButton);
  });

  it("lists recommend jobs without selecting another job", async (t) => {
    enableHumanRhythmClock(t);
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

    const result = await settleWithMockTimers(t, port.listRecommendJobs());

    assert.equal(result.success, true);
    assert.equal(result.status, "listed");
    assert.equal(result.availableCount, 2);
    assert.equal(result.canSwitch, true);
    assert.equal(result.current?.value, "job-1");
    assert.equal(result.options[1]?.value, "job-2");
    assert.equal(mouseInputs.filter((input) => input.type === "mousePressed").length, 1);
    assert.equal(Date.now(), VIRTUAL_ELAPSED.listsRecommendJobs);
  });

  it("does not report canSwitch when the only recommend job has no current marker", async (t) => {
    enableHumanRhythmClock(t);
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

    const result = await settleWithMockTimers(t, port.listRecommendJobs());

    assert.equal(result.success, true);
    assert.equal(result.availableCount, 1);
    assert.equal(result.canSwitch, false);
    assert.equal(result.current, undefined);
    assert.equal(Date.now(), VIRTUAL_ELAPSED.doesNotReportCanSwitch);
  });

  it("selects a recommend job by stable job value", async (t) => {
    enableHumanRhythmClock(t);
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

    const result = await settleWithMockTimers(t, port.selectRecommendJob({ jobValue: "job-2" }));

    assert.equal(result.success, true);
    assert.equal(result.status, "selected");
    assert.equal(result.selected?.value, "job-2");
    assert.equal(result.current?.value, "job-2");
    assert.equal(mouseInputs.filter((input) => input.type === "mousePressed").length, 2);
    assert.equal(Date.now(), VIRTUAL_ELAPSED.selectsRecommendJobByValue);
  });

  it("force-clicks the current recommend job when requested", async (t) => {
    enableHumanRhythmClock(t);
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

    const result = await settleWithMockTimers(
      t,
      port.selectRecommendJob({ jobValue: "job-1", forceClick: true }),
    );

    assert.equal(result.success, true);
    assert.equal(result.status, "selected");
    assert.deepEqual(clickedTargets, ["label", "job"]);
    assert.equal(Date.now(), VIRTUAL_ELAPSED.forceClicksCurrentRecommendJob);
  });

  it("applies a city and district location filter without opening the standard filter panel", async (t) => {
    enableHumanRhythmClock(t);
    let locationPanelOpen = false;
    const clickedTargets: string[] = [];
    const evaluatedExpressions: string[] = [];
    const port = createPort(
      async (expression) => {
        evaluatedExpressions.push(expression);
        if (expression.includes(".candidate-card-wrap")) {
          return true;
        }
        if (
          expression.includes("roots.some") &&
          expression.includes("仅推荐期望城市为本城市的牛人")
        ) {
          return locationPanelOpen;
        }
        if (expression.includes("const expectedCity")) {
          return { found: true, x: 900, y: 70 };
        }
        if (expression.includes('rawValue = "上海市"')) {
          assert.match(expression, /上海市/);
          return { found: true, x: 850, y: 120 };
        }
        if (expression.includes('rawValue = "浦东新区"')) {
          assert.match(expression, /浦东新区/);
          assert.match(expression, /text\.includes\(expected\)/);
          assert.match(expression, /\.check-area-warp, \.check-area-top/);
          assert.match(expression, /rect\.width >= 240/);
          assert.match(expression, /rect\.width <= 900/);
          assert.match(expression, /rect\.height <= 520/);
          return { found: true, x: 1040, y: 260 };
        }
        if (expression.includes('normalize(element.textContent) === "确认"')) {
          return { found: true, x: 1290, y: 370 };
        }
        if (expression.includes(ZHIPIN_SELECTORS.recommend.filterButton)) {
          return "筛选";
        }
        return false;
      },
      {
        async dispatchMouseEvent(input) {
          if (input.type !== "mouseReleased") return;
          if (input.x === 900) {
            locationPanelOpen = true;
            clickedTargets.push("open-location");
          } else if (input.x === 850) {
            clickedTargets.push("city");
          } else if (input.x === 1040) {
            clickedTargets.push("district");
          } else if (input.x === 1290) {
            locationPanelOpen = false;
            clickedTargets.push("confirm");
          }
        },
      },
    );

    const result = await settleWithMockTimers(
      t,
      port.applyRecommendFilter({
        applyMode: "patch",
        location: {
          city: "上海市",
          district: "浦东新区",
        },
        optionSelections: [],
      }),
    );

    assert.equal(result.status, "applied");
    assert.deepEqual(result.applied?.location, {
      city: "上海市",
      district: "浦东新区",
    });
    assert.deepEqual(clickedTargets, ["open-location", "city", "district", "confirm"]);
    assert.equal(
      evaluatedExpressions.some((expression) => expression.includes("filterPanel")),
      false,
    );
    assert.equal(Date.now(), VIRTUAL_ELAPSED.appliesCityDistrictLocationFilter);
  });

  it("sends chat replies through native focus, key events, insertText, and native send click", async (t) => {
    enableHumanRhythmClock(t);
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

    const result = await settleWithMockTimers(t, port.sendChatReply("您好，方便沟通吗"));

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
    assert.equal(Date.now(), VIRTUAL_ELAPSED.sendsChatReplies);
  });

  it("exchanges WeChat through native button and confirm clicks", async (t) => {
    enableHumanRhythmClock(t);
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

    const result = await settleWithMockTimers(t, port.exchangeWechat());

    assert.equal(result.success, true);
    assert.equal(result.wechatNumber, "wxid_12345");
    assert.equal(phase, 2);
    assert.equal(mouseInputs.filter((input) => input.type === "mousePressed").length, 2);
    assert.equal(Date.now(), VIRTUAL_ELAPSED.exchangesWechat);
  });

  it("clicks sidebar sections through narrow native targets", async (t) => {
    enableHumanRhythmClock(t);
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

    const clicked = await settleWithMockTimers(t, port.clickSidebarSection("recommend"));

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
    assert.equal(Date.now(), VIRTUAL_ELAPSED.clicksSidebarSections);
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

const BLOCKED_PAGE: BrowserInspectablePage = {
  targetId: "target-boss",
  type: "page",
  title: "访问受限",
  url: "https://www.zhipin.com/web/passport/zp/403.html?code=31",
};

const CHAT_PAGE: BrowserInspectablePage = {
  targetId: "target-boss",
  type: "page",
  title: "BOSS直聘",
  url: "https://www.zhipin.com/web/chat/index",
};

function createCtxManager(
  pages: readonly BrowserInspectablePage[],
  selectedTargetId = "target-boss",
): BrowserContextManager {
  return {
    isNativePageSelected(targetId: string) {
      return targetId === selectedTargetId;
    },
    async listNativePages() {
      return [...pages];
    },
  } as unknown as BrowserContextManager;
}

function createRuntime(options: {
  readonly evaluateJson?: (expression: string) => Promise<unknown>;
  readonly onConnect?: () => void;
  readonly onClose?: () => void;
}): BrowserRuntime {
  return {
    async connectNativePage() {
      options.onConnect?.();
      return {
        evaluateJson: options.evaluateJson ?? (async () => CHAT_PAGE.url),
        async getFrameTree() {
          return {
            frame: {
              id: "main-frame",
              url: CHAT_PAGE.url,
            },
          };
        },
        async createIsolatedWorld() {
          return 7;
        },
        async dispatchMouseEvent(_input: NativeCdpMouseEventInput) {},
        async bringToFront() {},
        close() {
          options.onClose?.();
        },
      } as unknown as NativeCdpController;
    },
  } as unknown as BrowserRuntime;
}

describe("openZhipinNativePagePort risk gate", () => {
  it("throws zhipin_access_restricted before connect when the listed URL is a 403 page", async () => {
    let connected = false;
    await assert.rejects(
      () =>
        openZhipinNativePagePort(
          {},
          {
            ctxManager: createCtxManager([BLOCKED_PAGE]),
            runtime: createRuntime({
              onConnect: () => {
                connected = true;
              },
            }),
          },
        ),
      (error: unknown) => {
        assert.ok(error instanceof StructuredToolError);
        assert.equal(error.payload.code, ZHIPIN_ACCESS_RESTRICTED_CODE);
        assert.match(error.message, /换 browserInstance\/profile 均无效/u);
        return true;
      },
    );
    assert.equal(connected, false);
  });

  it("does not treat a 403 tab as a missing chat page when requireChatPage is set", async () => {
    await assert.rejects(
      () =>
        openZhipinNativePagePort(
          { requireChatPage: true },
          {
            ctxManager: createCtxManager([BLOCKED_PAGE]),
            runtime: createRuntime({}),
          },
        ),
      (error: unknown) => {
        assert.ok(error instanceof StructuredToolError);
        assert.equal(error.payload.code, ZHIPIN_ACCESS_RESTRICTED_CODE);
        return true;
      },
    );
  });

  it("connects a 403 page when skipRiskGate is true", async () => {
    let connected = false;
    const port = await openZhipinNativePagePort(
      { skipRiskGate: true },
      {
        ctxManager: createCtxManager([BLOCKED_PAGE]),
        runtime: createRuntime({
          onConnect: () => {
            connected = true;
          },
        }),
      },
    );
    assert.equal(connected, true);
    port.close();
  });

  it("throws after connect when inspectPage shows a risk URL the list still had as chat", async () => {
    let closed = false;
    await assert.rejects(
      () =>
        openZhipinNativePagePort(
          {},
          {
            ctxManager: createCtxManager([CHAT_PAGE]),
            runtime: createRuntime({
              evaluateJson: async (expression) => {
                if (expression === "location.href") {
                  return BLOCKED_PAGE.url;
                }
                if (expression === "document.title") {
                  return BLOCKED_PAGE.title;
                }
                return CHAT_PAGE.url;
              },
              onClose: () => {
                closed = true;
              },
            }),
          },
        ),
      (error: unknown) => {
        assert.ok(error instanceof StructuredToolError);
        assert.equal(error.payload.code, ZHIPIN_ACCESS_RESTRICTED_CODE);
        return true;
      },
    );
    assert.equal(closed, true);
  });

  it("fails closed with a plain error when the live URL cannot be read", async () => {
    let closed = false;
    await assert.rejects(
      () =>
        openZhipinNativePagePort(
          {},
          {
            ctxManager: createCtxManager([CHAT_PAGE]),
            runtime: createRuntime({
              evaluateJson: async () => {
                throw new Error("CDP detached");
              },
              onClose: () => {
                closed = true;
              },
            }),
          },
        ),
      (error: unknown) => {
        assert.ok(error instanceof Error && !(error instanceof StructuredToolError));
        assert.match(error.message, /无法读取当前页面地址/u);
        return true;
      },
    );
    assert.equal(closed, true);
  });
});
