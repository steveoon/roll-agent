import { useEffect, useId } from "react";
import { matchesAgentEnvField, matchesAgentIdentity } from "../lib/catalog-search.ts";
import { resolveConfigSecretPresentation } from "../lib/config-secret.ts";
import { formatPath, getAtPath } from "../lib/config-value.ts";
import { describeFieldState, sameConfigValue } from "../lib/field-presentation.ts";
import {
  ENV_REFERENCE_TEMPLATE,
  validateAgentScalarInput,
  validateJsonText,
} from "../lib/input-validation.ts";
import { useRestorableSecretInput } from "../lib/restorable-secret.ts";
import { InlineCode } from "./InlineCode.tsx";
import type { AgentConfigCatalog, AgentEnvCatalogField, ConfigPath, JsonObject } from "../types.ts";

interface AgentEnvironmentEditorProps {
  readonly agent: AgentConfigCatalog;
  readonly persisted: JsonObject;
  readonly baseline: JsonObject;
  readonly searchQuery: string;
  readonly onSet: (path: ConfigPath, value: unknown) => void;
  readonly onDelete: (path: ConfigPath) => void;
  readonly onValidityChange: (path: ConfigPath, message?: string) => void;
  readonly configuredSecretPathKeys: ReadonlySet<string>;
}

export function AgentEnvironmentEditor({
  agent,
  persisted,
  baseline,
  searchQuery,
  onSet,
  onDelete,
  onValidityChange,
  configuredSecretPathKeys,
}: AgentEnvironmentEditorProps) {
  const fields = matchesAgentIdentity(agent, searchQuery)
    ? agent.fields
    : agent.fields.filter((field) => matchesAgentEnvField(field, searchQuery));
  return (
    <section
      className="catalog-object"
      data-config-path={`agents.env.${agent.name}`}
      aria-labelledby={`agent-${agent.name}`}
    >
      <header className="section-heading">
        <div>
          <p className="eyebrow">agents.env.{agent.name}</p>
          <h2 id={`agent-${agent.name}`}>{agent.name}</h2>
        </div>
        <span className={`ownership-badge ${agent.ownership}`}>
          {formatOwnership(agent.ownership)}
        </span>
      </header>
      <p className="section-description">{agent.description}</p>
      <div className="agent-env-notice">
        <strong>如何判断是否已满足</strong>
        <span>
          此处只显示写入 <code>roll.config</code> 的值；Agent 也可能从启动 Roll 的 Shell
          环境或声明默认值获得配置。敏感值建议使用 <code>&#36;&#123;ENV_VAR&#125;</code>。
        </span>
      </div>
      <div className="field-stack">
        {fields.length === 0 && <div className="empty-state">没有匹配的环境变量。</div>}
        {fields.map((field) => {
          const path: ConfigPath = ["agents", "env", agent.name, field.name];
          return (
            <AgentField
              key={field.name}
              field={field}
              path={path}
              value={getAtPath(persisted, path)}
              baselineValue={getAtPath(baseline, path)}
              onSet={(value) => onSet(path, value)}
              onDelete={() => onDelete(path)}
              onValidityChange={onValidityChange}
              configuredSecretPathKeys={configuredSecretPathKeys}
            />
          );
        })}
      </div>
    </section>
  );
}

function AgentField({
  field,
  path,
  value,
  baselineValue,
  onSet,
  onDelete,
  onValidityChange,
  configuredSecretPathKeys,
}: {
  readonly field: AgentEnvCatalogField;
  readonly path: ConfigPath;
  readonly value: unknown;
  readonly baselineValue: unknown;
  readonly onSet: (value: unknown) => void;
  readonly onDelete: () => void;
  readonly onValidityChange: (path: ConfigPath, message?: string) => void;
  readonly configuredSecretPathKeys: ReadonlySet<string>;
}) {
  const inputId = useId();
  const present = value !== undefined;
  const changed = !sameConfigValue(value, baselineValue);
  const secretPresentation = resolveConfigSecretPresentation(
    field.secret,
    path,
    configuredSecretPathKeys,
    value,
  );
  const configuredSecret = secretPresentation.configured;
  const state = describeFieldState({
    present,
    value,
    ...(field.defaultValue !== undefined ? { defaultValue: field.defaultValue } : {}),
    configuredSecret,
    secret: secretPresentation.secret,
    required: false,
    widget: field.widget,
    path,
  });
  const visibleValue = configuredSecret ? "" : typeof value === "string" ? value : "";
  const placeholder = configuredSecret
    ? "已配置 · 输入新值以替换"
    : (field.example ?? field.defaultValue ?? "未设置");

  return (
    <article
      className={`primitive-field${present ? " is-persisted" : " is-inherited"}${field.configurable ? "" : " is-derived"}`}
      data-config-path={validationPath(path)}
    >
      <div className="primitive-copy">
        {field.configurable ? (
          <label className="field-title" htmlFor={inputId}>
            {field.title}
            {field.required && <span className="required-mark">Agent 需要</span>}
          </label>
        ) : (
          <span className="field-title">
            {field.title}
            {field.required && <span className="required-mark">Agent 需要</span>}
          </span>
        )}
        <code className="field-path">{field.name}</code>
        {field.description !== undefined && (
          <p>
            <InlineCode text={field.description} />
          </p>
        )}
      </div>
      <div className="field-control">
        {field.configurable ? (
          <AgentFieldControl
            id={inputId}
            field={field}
            value={visibleValue}
            present={present}
            configuredSecret={configuredSecret}
            effectiveSecret={secretPresentation.secret}
            placeholder={placeholder}
            onSet={onSet}
            onDelete={onDelete}
            path={path}
            onValidityChange={onValidityChange}
          />
        ) : (
          <div className="derived-field" id={inputId}>
            <span>由 Roll 配置派生</span>
            <code>{field.sourcePath?.join(".") ?? formatPath(path)}</code>
          </div>
        )}
        {field.configurable && (
          <small className="field-input-note">
            配置文件：{present ? state.currentLabel : "未写入（可能由启动环境或声明默认值提供）"}
          </small>
        )}
        <div className="field-meta-row">
          <span
            className={`source-chip ${field.configurable ? (changed || present ? "persisted" : "default") : "derived"}`}
          >
            {!field.configurable
              ? "由 Roll 配置派生"
              : changed
                ? "本轮已修改"
                : present
                  ? state.sourceLabel
                  : field.required
                    ? "需由配置或启动环境提供"
                    : "可选 / 未配置"}
          </span>
          {(changed || present) && field.configurable && (
            <button
              type="button"
              className="text-button"
              onClick={() => {
                if (changed) {
                  if (baselineValue === undefined) onDelete();
                  else onSet(structuredClone(baselineValue));
                  return;
                }
                onDelete();
              }}
            >
              {changed ? "撤销本项" : state.resetLabel}
            </button>
          )}
        </div>
        {field.configurable &&
          (field.example !== undefined || field.defaultValue !== undefined) && (
            <details>
              <summary className="text-button">查看输入示例与默认值</summary>
              {field.defaultValue !== undefined && (
                <div className="field-input-note">声明默认值：{field.defaultValue}</div>
              )}
              {field.example !== undefined && (
                <div className="field-input-note">示例：{field.example}</div>
              )}
            </details>
          )}
      </div>
    </article>
  );
}

function AgentFieldControl({
  id,
  field,
  value,
  present,
  configuredSecret,
  effectiveSecret,
  placeholder,
  onSet,
  onDelete,
  path,
  onValidityChange,
}: {
  readonly id: string;
  readonly field: AgentEnvCatalogField;
  readonly value: string;
  readonly present: boolean;
  readonly configuredSecret: boolean;
  readonly effectiveSecret: boolean;
  readonly placeholder: string;
  readonly onSet: (value: unknown) => void;
  readonly onDelete: () => void;
  readonly path: ConfigPath;
  readonly onValidityChange: (path: ConfigPath, message?: string) => void;
}) {
  const resolveSecretInput = useRestorableSecretInput(configuredSecret, present);
  const normalized = value.toLowerCase();
  const hasTypedBooleanValue = !present || normalized === "true" || normalized === "false";
  const hasTypedNumberValue = value.length === 0 || Number.isFinite(Number(value));
  const jsonError =
    field.type === "json" ? validateJsonText(value, present && !configuredSecret) : undefined;
  const scalarError =
    !configuredSecret && (field.type === "boolean" || field.type === "number")
      ? validateAgentScalarInput(field.type, value)
      : undefined;
  const pathName = validationPath(path);
  useEffect(() => {
    if (field.type === "json" || field.type === "boolean" || field.type === "number") {
      onValidityChange(path, jsonError ?? scalarError);
    }
  }, [field.type, jsonError, scalarError, pathName, onValidityChange]);
  if (field.type === "boolean" && hasTypedBooleanValue) {
    const selection = !present ? "inherit" : normalized === "true" ? "true" : "false";
    return (
      <div className="tri-toggle" role="group" aria-label={`${field.title} 选择`}>
        <button
          type="button"
          className={selection === "inherit" ? "active" : ""}
          aria-pressed={selection === "inherit"}
          onClick={() => {
            onValidityChange(path, undefined);
            onDelete();
          }}
        >
          {field.defaultValue === undefined ? "未写入" : `默认 · ${field.defaultValue}`}
        </button>
        <button
          id={id}
          type="button"
          className={selection === "true" ? "active" : ""}
          aria-pressed={selection === "true"}
          onClick={() => {
            onValidityChange(path, undefined);
            onSet("true");
          }}
        >
          开
        </button>
        <button
          type="button"
          className={selection === "false" ? "active" : ""}
          aria-pressed={selection === "false"}
          onClick={() => {
            onValidityChange(path, undefined);
            onSet("false");
          }}
        >
          关
        </button>
        <button
          type="button"
          className="env-reference-button"
          title="使用环境变量引用"
          aria-label={`为${field.title}使用环境变量引用`}
          onClick={() => {
            onValidityChange(path, undefined);
            onSet(ENV_REFERENCE_TEMPLATE);
          }}
        >
          ENV
        </button>
      </div>
    );
  }
  if (field.widget === "textarea") {
    const errorId = `${id}-error`;
    return (
      <div className="json-control">
        <textarea
          id={id}
          name={pathName}
          rows={5}
          value={value}
          placeholder={placeholder}
          spellCheck={false}
          autoComplete={effectiveSecret ? "new-password" : "off"}
          aria-invalid={jsonError !== undefined}
          aria-describedby={jsonError === undefined ? undefined : errorId}
          onChange={(event) => {
            const next = event.target.value;
            const nextValue = effectiveSecret ? resolveSecretInput(next) : next;
            onValidityChange(
              path,
              field.type === "json" ? validateJsonText(next, next.length > 0) : undefined,
            );
            onSet(nextValue);
          }}
        />
        {jsonError !== undefined && (
          <small className="input-error" id={errorId}>
            {jsonError}
          </small>
        )}
      </div>
    );
  }
  const useNumberInput = field.type === "number" && hasTypedNumberValue;
  const scalarErrorId = `${id}-error`;
  const input = (
    <input
      id={id}
      name={pathName}
      type={
        effectiveSecret
          ? "password"
          : useNumberInput
            ? "number"
            : field.type === "url"
              ? "url"
              : "text"
      }
      inputMode={useNumberInput ? "decimal" : undefined}
      value={value}
      placeholder={placeholder}
      autoComplete={effectiveSecret ? "new-password" : "off"}
      spellCheck={false}
      aria-invalid={scalarError !== undefined}
      aria-describedby={scalarError === undefined ? undefined : scalarErrorId}
      onChange={(event) => {
        const next = event.target.value;
        if (field.type === "boolean" || field.type === "number") {
          onValidityChange(path, validateAgentScalarInput(field.type, next));
        }
        onSet(effectiveSecret ? resolveSecretInput(next) : next);
      }}
    />
  );
  const scalarInput =
    scalarError === undefined ? (
      input
    ) : (
      <div className="raw-value-control">
        {input}
        <small className="input-error" id={scalarErrorId}>
          {scalarError}
        </small>
      </div>
    );
  return field.type === "number" ? (
    <div className="agent-number-control">
      <div className="config-value-control">
        {scalarInput}
        <button
          type="button"
          className="env-reference-button"
          title="使用环境变量引用"
          aria-label={`为${field.title}使用环境变量引用`}
          onClick={() => {
            onValidityChange(path, undefined);
            onSet(ENV_REFERENCE_TEMPLATE);
          }}
        >
          ENV
        </button>
      </div>
      <small className="field-input-note">
        固定值或完整的 <code>&#36;&#123;ENV_VAR&#125;</code> 引用
      </small>
    </div>
  ) : (
    scalarInput
  );
}

function formatOwnership(ownership: AgentConfigCatalog["ownership"]): string {
  switch (ownership) {
    case "core-managed":
      return "CORE MANAGED";
    case "external-managed":
      return "EXTERNAL";
    case "on-demand":
      return "ON DEMAND";
  }
}

function validationPath(path: ConfigPath): string {
  return path.map(String).join(".");
}
