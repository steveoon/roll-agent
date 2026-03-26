/**
 * Pipeline 运行期间（spinner 活跃时）抑制中间日志，调试信息改走 diagnostics。
 *
 * 注意：当前使用模块级标志，仅适用于串行调用场景（stdio MCP）。
 * 若需并发安全，应改为 AsyncLocalStorage。
 */
let _suppress = false;

export function setSuppressVerboseLogs(value: boolean): void {
  _suppress = value;
}

export function verboseLog(...args: unknown[]): void {
  if (!_suppress) console.error(...args);
}
