export const CHAT_NOTICE_TONES = ["info", "warning"] as const;

export interface ChatNotice {
  readonly text: string;
  readonly tone: (typeof CHAT_NOTICE_TONES)[number];
}
