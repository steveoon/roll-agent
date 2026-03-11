export interface AgentContext {
  readonly llm: {
    readonly generateText: (prompt: string) => Promise<string>;
  };
  readonly logger: {
    readonly info: (message: string) => void;
    readonly error: (message: string) => void;
  };
}
