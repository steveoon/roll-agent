/**
 * BOSS直聘 CSS/aria 选择器常量。
 *
 * DOM 结构变更时只需更新此文件。
 */
export const ZHIPIN_SELECTORS = {
  login: {
    qrCode: ".login-scan-code img, .qr-code-box img",
    loginSuccess: ".user-nav, .header-user-info",
    switchQrLogin: ".switch-tip, .qr-login-btn",
  },
  messageList: {
    container: ".chat-list, .message-list",
    item: ".chat-item, .message-item",
    candidateName: ".chat-item .name, .message-item .title",
    lastMessage: ".chat-item .last-msg, .message-item .desc",
    unreadBadge: ".chat-item .badge, .message-item .unread-count",
    timestamp: ".chat-item .time, .message-item .time",
  },
  chat: {
    input: ".chat-input textarea, .message-input textarea, [contenteditable='true']",
    sendButton: ".btn-send, .send-btn, button[type='submit']",
    messageItem: ".chat-message, .message-content",
    messageText: ".chat-message .text, .message-content .text",
  },
  candidateProfile: {
    panel: ".candidate-info, .resume-info, .geek-info",
    name: ".candidate-info .name, .geek-info .name",
    age: ".candidate-info .age, .geek-info .age",
    gender: ".candidate-info .gender, .geek-info .gender",
    experience: ".candidate-info .experience, .geek-info .work-exp",
    education: ".candidate-info .education, .geek-info .edu",
    expectedSalary: ".candidate-info .salary, .geek-info .expect-salary",
    expectedPosition: ".candidate-info .position, .geek-info .expect-position",
    activeTime: ".candidate-info .active-time, .geek-info .active",
  },
} as const;
