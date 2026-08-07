import { Buffer } from "node:buffer";

/** Builds a PowerShell expression without interpolating untrusted text into command syntax. */
export function createPowerShellUtf8StringExpression(value: string): string {
  const encoded = Buffer.from(value, "utf8").toString("base64");
  return `[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}'))`;
}
