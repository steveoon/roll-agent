import type { AppOutputRejection } from "@roll-agent/protocol";

// Application DTOs are not evidence previews: image/data, pagination tokens and SKU codes
// are valid business values. Only explicit credential fields and strong credential formats
// cause rejection. This deliberately does not change the existing evidence redactor.
const CREDENTIAL_FIELDS = new Set([
  "password",
  "passwd",
  "apikey",
  "apisecret",
  "clientsecret",
  "privatekey",
  "secret",
  "devicecredential",
  "signingkey",
  "sessionkey",
  "密码",
  "口令",
  "密钥",
  "私钥",
  "authorization",
  "cookie",
  "setcookie",
  "accesstoken",
  "refreshtoken",
  "authtoken",
]);
const CREDENTIAL_VALUE =
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\bBearer\s+[A-Za-z0-9._~+/-]{24,}=*|\b(?:sk|rk|pk)-(?:proj-)?[A-Za-z0-9_-]{32,}\b|\b(?:github_pat_[A-Za-z0-9_]{22,}|gh[pousr]_[A-Za-z0-9]{36,})\b|\bxox[baprs]-[A-Za-z0-9-]{24,}\b|\bAKIA[0-9A-Z]{16}\b|\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{16,}\b/u;

export function inspectAppOutputContent(value: unknown): AppOutputRejection | undefined {
  if (typeof value === "string") {
    return CREDENTIAL_VALUE.test(value)
      ? { status: "rejected", reason: "credential_value" }
      : undefined;
  }
  if (Array.isArray(value)) {
    for (const child of value) {
      const issue = inspectAppOutputContent(child);
      if (issue) return issue;
    }
  } else if (typeof value === "object" && value !== null) {
    for (const [key, child] of Object.entries(value)) {
      const field = key.toLowerCase().replace(/[-_\s]/gu, "");
      if (CREDENTIAL_FIELDS.has(field) && child !== null && child !== "") {
        // The diagnostic contains only an allowlisted field category, never a value/path.
        return { status: "rejected", reason: "credential_field", field };
      }
      const issue = inspectAppOutputContent(child);
      if (issue) return issue;
    }
  }
  return undefined;
}
