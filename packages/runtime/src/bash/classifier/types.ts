export type AuditVerdict = "safe" | "reject";

export type FlagAuditor = (argv: readonly string[]) => AuditVerdict;
