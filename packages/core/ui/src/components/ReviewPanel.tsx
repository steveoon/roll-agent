import { formatConfigValue } from "../lib/field-presentation.ts";
import { formatPath, getAtPath } from "../lib/config-value.ts";
import type {
  AgentEnvCatalogField,
  AgentActivationResult,
  ConfigCatalogNode,
  ConfigActivationEffect,
  ConfigApplicationPreview,
  ConfigPath,
  ConfigValidationIssue,
  JsonObject,
  RollConfigCatalog,
} from "../types.ts";
import { SECRET_SENTINEL } from "../types.ts";
import { AgentStatusCards, type AgentStatusCardsProps } from "./AgentStatusCards.tsx";

interface ReviewPanelProps {
  readonly dirty: boolean;
  readonly preview: ConfigApplicationPreview | null;
  readonly catalog: RollConfigCatalog;
  readonly before: JsonObject;
  readonly issues: readonly ConfigValidationIssue[];
  readonly busy: boolean;
  readonly agentStatus: AgentStatusCardsProps;
  readonly onPreview: () => void;
  readonly onIssueSelect: (issue: ConfigValidationIssue) => void;
  readonly activationResult?: AgentActivationResult;
}

export function ReviewPanel({
  dirty,
  preview,
  catalog,
  before,
  issues,
  busy,
  agentStatus,
  onPreview,
  onIssueSelect,
  activationResult,
}: ReviewPanelProps) {
  return (
    <aside className="review-panel" aria-label="变更预览与运行状态">
      <section className="review-section" aria-labelledby="review-title">
        <div className="panel-heading-row">
          <div>
            <p className="eyebrow">PRE-FLIGHT</p>
            <h2 id="review-title">变更审阅</h2>
          </div>
          <span className={`change-counter ${dirty ? "dirty" : "clean"}`}>
            {dirty ? "UNSAVED" : "CLEAN"}
          </span>
        </div>

        {issues.length > 0 && (
          <div className="validation-block" role="alert">
            <strong>校验未通过</strong>
            <ul>
              {issues.map((issue, index) => (
                <li key={`${issue.path}-${String(index)}`}>
                  <button
                    type="button"
                    className="validation-issue-button"
                    onClick={() => onIssueSelect(issue)}
                  >
                    {issue.path.length > 0 && <code>{issue.path}</code>}
                    <span>{issue.message}</span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}

        {preview === null ? (
          <div className="preview-placeholder">
            <div className="preview-glyph" aria-hidden="true">
              ±
            </div>
            <strong>{dirty ? "有尚未预览的修改" : "尚无变更"}</strong>
            <p>预览会运行与 CLI 相同的 schema 校验，并列出生效方式。</p>
            <button
              type="button"
              className="secondary-button full-width"
              disabled={!dirty || busy}
              onClick={onPreview}
            >
              {busy ? "正在校验…" : "生成变更预览"}
            </button>
          </div>
        ) : (
          <>
            <PreviewSummary preview={preview} />
            <SemanticChangeList preview={preview} catalog={catalog} before={before} />
            <DiffView preview={preview} />
            <EffectList effects={preview.effects} />
          </>
        )}
        {activationResult !== undefined && <ActivationResultView result={activationResult} />}
      </section>
      <AgentStatusCards {...agentStatus} />
    </aside>
  );
}

function SemanticChangeList({
  preview,
  catalog,
  before,
}: {
  readonly preview: ConfigApplicationPreview;
  readonly catalog: RollConfigCatalog;
  readonly before: JsonObject;
}) {
  return (
    <div className="effect-list">
      <p className="mini-heading">WHAT WILL CHANGE</p>
      {preview.changedPaths.map((path) => {
        const field = resolveCatalogField(catalog, path);
        const effect = preview.effects.find((candidate) =>
          candidate.paths.some((candidatePath) => samePath(candidatePath, path)),
        );
        const title = field?.title ?? String(path.at(-1) ?? "配置项");
        return (
          <article
            className={`effect-card ${effect?.kind ?? "next-command"}`}
            key={formatPath(path)}
          >
            <div className="effect-card-title">
              <span aria-hidden="true">→</span>
              <strong>{title}</strong>
            </div>
            <p>
              {formatFieldValue(getAtPath(before, path), field, path)} →{" "}
              {formatFieldValue(getAtPath(preview.snapshot.persisted, path), field, path)}
            </p>
            <details>
              <summary>{formatPath(path)}</summary>
              {effect !== undefined && <p>{effect.description}</p>}
            </details>
          </article>
        );
      })}
    </div>
  );
}

type CatalogField = ConfigCatalogNode | AgentEnvCatalogField;

function resolveCatalogField(
  catalog: RollConfigCatalog,
  path: ConfigPath,
): CatalogField | undefined {
  if (path[0] === "agents" && path[1] === "env" && typeof path[2] === "string") {
    const agent = catalog.agents.find((candidate) => candidate.name === path[2]);
    return typeof path[3] === "string"
      ? agent?.fields.find((field) => field.name === path[3])
      : undefined;
  }

  let node: ConfigCatalogNode = catalog.root;
  let index = 0;
  while (index < path.length) {
    if (node.kind === "object") {
      const segment = path[index];
      if (typeof segment !== "string") return undefined;
      const child: ConfigCatalogNode | undefined = node.fields[segment];
      if (child === undefined) return undefined;
      node = child;
      index += 1;
      continue;
    }
    if (node.kind === "record" || node.kind === "array") {
      node = node.kind === "record" ? node.value : node.item;
      index += 1;
      continue;
    }
    return undefined;
  }
  return node;
}

function formatFieldValue(
  value: unknown,
  field: CatalogField | undefined,
  path: ConfigPath,
): string {
  const fallback = field?.defaultValue;
  const effectiveValue = value === undefined ? fallback : value;
  return formatConfigValue(effectiveValue, {
    path,
    ...(field !== undefined ? { widget: field.widget, secret: field.secret } : {}),
    configuredSecret: effectiveValue === SECRET_SENTINEL,
  });
}

function samePath(left: ConfigPath, right: ConfigPath): boolean {
  return left.length === right.length && left.every((segment, index) => segment === right[index]);
}

function ActivationResultView({ result }: { readonly result: AgentActivationResult }) {
  return (
    <div className={`activation-result ${result.success ? "success" : "failed"}`}>
      <p className="mini-heading">LAST ACTIVATION RESULT</p>
      <strong>
        {result.success
          ? result.requiresManualAction
            ? "配置已处理，仍有人工步骤"
            : "配置已成功应用"
          : "至少一个 Agent 应用失败"}
      </strong>
      <ul>
        {result.items.map((item, index) => (
          <li key={`${item.status}-${item.effect.title}-${String(index)}`}>
            <span>{item.status}</span>
            <p>{item.message}</p>
          </li>
        ))}
      </ul>
    </div>
  );
}

function PreviewSummary({ preview }: { readonly preview: ConfigApplicationPreview }) {
  const additions = preview.diff.filter((line) => line.kind === "add").length;
  const removals = preview.diff.filter((line) => line.kind === "remove").length;
  return (
    <div className="preview-summary">
      <div>
        <span>CHANGED PATHS</span>
        <strong>{String(preview.changedPaths.length).padStart(2, "0")}</strong>
      </div>
      <div className="add-count">
        <span>ADDED LINES</span>
        <strong>+{additions}</strong>
      </div>
      <div className="remove-count">
        <span>REMOVED LINES</span>
        <strong>−{removals}</strong>
      </div>
    </div>
  );
}

function DiffView({ preview }: { readonly preview: ConfigApplicationPreview }) {
  const meaningful = preview.diff.filter((line) => line.kind !== "context");
  return (
    <details className="diff-block" open={meaningful.length <= 20}>
      <summary>
        YAML DIFF <span>{meaningful.length} lines</span>
      </summary>
      <div className="diff-code" role="region" aria-label="YAML 变更内容" tabIndex={0}>
        {preview.diff.map((line, index) => (
          <div className={`diff-line ${line.kind}`} key={`${line.kind}-${String(index)}`}>
            <span aria-hidden="true">
              {line.kind === "add" ? "+" : line.kind === "remove" ? "−" : " "}
            </span>
            <code>{line.text.length === 0 ? " " : line.text}</code>
          </div>
        ))}
      </div>
    </details>
  );
}

function EffectList({ effects }: { readonly effects: readonly ConfigActivationEffect[] }) {
  return (
    <div className="effect-list">
      <p className="mini-heading">ACTIVATION PLAN</p>
      {effects.length === 0 && <div className="empty-inline">保存后无需额外操作。</div>}
      {effects.map((effect) => (
        <article className={`effect-card ${effect.kind}`} key={`${effect.kind}-${effect.title}`}>
          <div className="effect-card-title">
            <span aria-hidden="true">{effectIcon(effect.kind)}</span>
            <strong>{effect.title}</strong>
            {effect.requiresConfirmation && <em>CONFIRM</em>}
          </div>
          <p>{effect.description}</p>
          <details>
            <summary>{effect.paths.length} 个配置路径</summary>
            <ul>
              {effect.paths.map((path) => (
                <li key={formatPath(path)}>
                  <code>{formatPath(path)}</code>
                </li>
              ))}
            </ul>
          </details>
        </article>
      ))}
    </div>
  );
}

function effectIcon(kind: ConfigActivationEffect["kind"]): string {
  switch (kind) {
    case "restart-agent":
      return "↻";
    case "manual":
      return "!";
    case "next-chat":
      return "↗";
    case "next-command":
      return "→";
  }
}
