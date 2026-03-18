/**
 * 鱼泡 CSS/aria 选择器常量。
 *
 * DOM 结构变更时只需更新此文件。
 */
export const YUPAO_SELECTORS = {
  login: {
    qrCode: ".login-qr img, .qr-code img",
    loginSuccess: ".user-info, .header-user",
  },
  messageList: {
    container: ".chat-list, .msg-list",
    item: ".chat-item, .msg-item",
    candidateName: ".chat-item .name, .msg-item .name",
    lastMessage: ".chat-item .msg, .msg-item .content",
    unreadBadge: ".chat-item .unread, .msg-item .badge",
    timestamp: ".chat-item .time, .msg-item .time",
  },
  chat: {
    input: ".chat-input textarea, .msg-input textarea",
    sendButton: ".btn-send, .send-btn",
    messageItem: ".chat-msg, .msg-bubble",
    messageText: ".chat-msg .text, .msg-bubble .text",
  },
} as const;
