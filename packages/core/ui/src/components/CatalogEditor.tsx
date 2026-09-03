import { useEffect, useId, useMemo, useState } from "react";
import {
  defaultValueForNode,
  formatPath,
  getAtPath,
  isRecord,
  matchesCatalogSearch,
} from "../lib/config-value.ts";
import {
  findConfiguredSecretSentinelAtOrBelow,
  resolveConfigSecretPresentation,
} from "../lib/config-secret.ts";
import {
  ENV_REFERENCE_TEMPLATE,
  validateEnvironmentReference,
  validateNumberInput,
} from "../lib/input-validation.ts";
import {
  describeFieldState,
  formatConfigValue,
  sameConfigValue,
} from "../lib/field-presentation.ts";
import { availableRecordKeyOptions, formatRecordKeyOption } from "../lib/record-key-options.ts";
import { useRestorableSecretInput } from "../lib/restorable-secret.ts";
import { InlineCode } from "./InlineCode.tsx";
import type {
  ConfigArrayCatalogNode,
  ConfigCatalogNode,
  ConfigEnumCatalogNode,
  ConfigLeafCatalogNode,
  ConfigNumberCatalogNode,
  ConfigObjectCatalogNode,
  ConfigPath,
  ConfigRecordCatalogNode,
  JsonObject,
} from "../types.ts";

interface CatalogEditorProps {
  readonly node: ConfigCatalogNode;
  readonly path: ConfigPath;
  readonly persisted: JsonObject;
  readonly baseline: JsonObject;
  readonly searchQuery: string;
  readonly onSet: (path: ConfigPath, value: unknown) => void;
  readonly onDelete: (path: ConfigPath) => void;
  readonly onValidityChange: (path: ConfigPath, message?: string) => void;
  readonly configuredSecretPathKeys: ReadonlySet<string>;
  readonly invalidJsonDraftsByPath: Readonly<Record<string, string>>;
  readonly onInvalidJsonDraftChange: (path: ConfigPath, draft?: string) => void;
}

export function CatalogEditor(props: CatalogEditorProps) {
  if (!matchesCatalogSearch(props.node, props.searchQuery)) return null;
  const value = getAtPath(props.persisted, props.path);
  const baselineValue = getAtPath(props.baseline, props.path);
  const invalidJsonDraft = props.invalidJsonDraftsByPath[JSON.stringify(props.path)];
  switch (props.node.kind) {
    case "object":
      return <ObjectEditor {...props} node={props.node} value={value} />;
    case "record":
      return <RecordEditor {...props} node={props.node} value={value} />;
    case "array":
      return <ArrayEditor {...props} node={props.node} value={value} />;
    case "enum":
    case "string":
    case "number":
    case "boolean":
    case "unknown":
      return (
        <PrimitiveField
          node={props.node}
          path={props.path}
          value={value}
          baselineValue={baselineValue}
          present={value !== undefined}
          disabled={props.node.readOnly}
          onValue={(next) => props.onSet(props.path, next)}
          onUnset={() => props.onDelete(props.path)}
          onUndo={() =>
            baselineValue === undefined
              ? props.onDelete(props.path)
              : props.onSet(props.path, structuredClone(baselineValue))
          }
          onValidityChange={props.onValidityChange}
          configuredSecretPathKeys={props.configuredSecretPathKeys}
          {...(invalidJsonDraft !== undefined ? { invalidJsonDraft } : {})}
          onInvalidJsonDraftChange={props.onInvalidJsonDraftChange}
        />
      );
  }
}

interface ObjectEditorProps extends CatalogEditorProps {
  readonly node: ConfigObjectCatalogNode;
  readonly value: unknown;
}

function ObjectEditor({
  node,
  path,
  persisted,
  baseline,
  searchQuery,
  onSet,
  onDelete,
  onValidityChange,
  configuredSecretPathKeys,
  invalidJsonDraftsByPath,
  onInvalidJsonDraftChange,
}: ObjectEditorProps) {
  const fields = Object.entries(node.fields).filter(([, child]) =>
    matchesCatalogSearch(child, searchQuery),
  );
  const sectionChanged = !sameConfigValue(getAtPath(persisted, path), getAtPath(baseline, path));
  return (
    <section
      className="catalog-object"
      data-config-path={validationPath(path)}
      aria-labelledby={`section-${pathKey(path)}`}
    >
      <header className="section-heading">
        <div>
          <p className="eyebrow">{formatPath(path)}</p>
          <h2 id={`section-${pathKey(path)}`}>{node.title}</h2>
        </div>
        <span className="section-count">
          {sectionChanged ? "有未保存修改" : `${String(fields.length).padStart(2, "0")} 组设置`}
        </span>
      </header>
      {(node.description !== undefined || node.defaultBehavior !== undefined) && (
        <p className="section-description">
          <InlineCode text={[node.description, node.defaultBehavior].filter(Boolean).join(" ")} />
        </p>
      )}
      <div className="field-stack">
        {fields.map(([key, child]) => (
          <CatalogEditor
            key={key}
            node={child}
            path={[...path, key]}
            persisted={persisted}
            baseline={baseline}
            searchQuery={searchQuery}
            onSet={onSet}
            onDelete={onDelete}
            onValidityChange={onValidityChange}
            configuredSecretPathKeys={configuredSecretPathKeys}
            invalidJsonDraftsByPath={invalidJsonDraftsByPath}
            onInvalidJsonDraftChange={onInvalidJsonDraftChange}
          />
        ))}
      </div>
    </section>
  );
}

interface RecordEditorProps extends CatalogEditorProps {
  readonly node: ConfigRecordCatalogNode;
  readonly value: unknown;
}

function RecordEditor({
  node,
  path,
  persisted,
  baseline,
  searchQuery,
  onSet,
  onDelete,
  onValidityChange,
  configuredSecretPathKeys,
  invalidJsonDraftsByPath,
  onInvalidJsonDraftChange,
  value,
}: RecordEditorProps) {
  const entries = isRecord(value) ? Object.entries(value) : [];
  const baselineValue = getAtPath(baseline, path);
  const changed = !sameConfigValue(value, baselineValue);
  const [newKey, setNewKey] = useState("");
  const normalizedNewKey = newKey.trim();
  const canAdd = normalizedNewKey.length > 0 && !entries.some(([key]) => key === normalizedNewKey);
  const keyOptions = node.keyOptions;
  const selectableKeys =
    keyOptions === undefined
      ? undefined
      : availableRecordKeyOptions(
          keyOptions,
          entries.map(([key]) => key),
        );

  function addEntry(): void {
    if (!canAdd) return;
    onSet([...path, normalizedNewKey], defaultValueForNode(node.value));
    setNewKey("");
  }

  function renameEntry(previousKey: string, nextKey: string): string | undefined {
    const normalized = nextKey.trim();
    if (
      normalized.length === 0 ||
      normalized === previousKey ||
      entries.some(([key]) => key === normalized)
    ) {
      return undefined;
    }
    const previousPath = [...path, previousKey];
    const configuredSecretPath = findConfiguredSecretSentinelAtOrBelow(
      persisted,
      previousPath,
      configuredSecretPathKeys,
    );
    if (configuredSecretPath !== undefined) {
      return `不能重命名：${formatPath(configuredSecretPath)} 保留了已配置的敏感值。请先清除该字段，再重命名并重新配置。`;
    }
    const previousValue = getAtPath(persisted, [...path, previousKey]);
    onSet([...path, normalized], previousValue);
    onDelete(previousPath);
    return undefined;
  }

  return (
    <article className="compound-field" data-config-path={validationPath(path)}>
      <FieldHeader
        node={node}
        path={path}
        changed={changed}
        onUndo={() =>
          baselineValue === undefined ? onDelete(path) : onSet(path, structuredClone(baselineValue))
        }
      />
      <div className="record-list">
        {entries.length === 0 && (
          <div className="empty-inline">
            <span>暂无条目</span>
            <small>添加一个命名条目后即可配置内部字段。</small>
          </div>
        )}
        {entries.map(([key]) => (
          <div className="record-entry" key={key}>
            <div className="record-entry-header">
              <RecordKey
                currentKey={key}
                existingKeys={entries.map(([entryKey]) => entryKey)}
                onRename={(nextKey) => renameEntry(key, nextKey)}
              />
              <button
                className="icon-button danger-action"
                type="button"
                aria-label={`删除 ${key}`}
                title={`删除 ${key}`}
                onClick={() => onDelete([...path, key])}
              >
                ×
              </button>
            </div>
            <div className="record-entry-body">
              <CatalogEditor
                node={node.value}
                path={[...path, key]}
                persisted={persisted}
                baseline={baseline}
                searchQuery={searchQuery}
                onSet={onSet}
                onDelete={onDelete}
                onValidityChange={onValidityChange}
                configuredSecretPathKeys={configuredSecretPathKeys}
                invalidJsonDraftsByPath={invalidJsonDraftsByPath}
                onInvalidJsonDraftChange={onInvalidJsonDraftChange}
              />
            </div>
          </div>
        ))}
      </div>
      {selectableKeys === undefined ? (
        <div className="record-add-row">
          <label>
            <span className="sr-only">新条目名称</span>
            <input
              value={newKey}
              placeholder={`输入${node.title}的名称`}
              onChange={(event) => setNewKey(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  addEntry();
                }
              }}
            />
          </label>
          <button className="secondary-button" type="button" disabled={!canAdd} onClick={addEntry}>
            ＋ 添加命名配置
          </button>
        </div>
      ) : selectableKeys.length === 0 ? (
        <small className="field-input-note">可选的{node.title}已全部添加</small>
      ) : (
        <div className="record-add-row">
          <label>
            <span className="sr-only">选择要添加的{node.title}</span>
            <select value={newKey} onChange={(event) => setNewKey(event.target.value)}>
              <option value="">选择要添加的{node.title}…</option>
              {selectableKeys.map((option) => (
                <option key={option.value} value={option.value}>
                  {formatRecordKeyOption(option)}
                </option>
              ))}
            </select>
          </label>
          <button className="secondary-button" type="button" disabled={!canAdd} onClick={addEntry}>
            ＋ 添加
          </button>
        </div>
      )}
    </article>
  );
}

interface RecordKeyProps {
  readonly currentKey: string;
  readonly existingKeys: readonly string[];
  readonly onRename: (key: string) => string | undefined;
}

function RecordKey({ currentKey, existingKeys, onRename }: RecordKeyProps) {
  const [draft, setDraft] = useState(currentKey);
  const [renameError, setRenameError] = useState<string>();
  const errorId = useId();
  const invalid =
    draft.trim().length === 0 ||
    existingKeys.some((key) => key !== currentKey && key === draft.trim());
  useEffect(() => {
    setDraft(currentKey);
    setRenameError(undefined);
  }, [currentKey]);
  return (
    <label className="record-key" onClick={(event) => event.stopPropagation()}>
      <span className="record-key-mark">KEY</span>
      <span>
        <input
          value={draft}
          aria-invalid={invalid || renameError !== undefined}
          aria-describedby={renameError === undefined ? undefined : errorId}
          aria-label={`${currentKey} 的条目名称`}
          onChange={(event) => {
            setDraft(event.target.value);
            setRenameError(undefined);
          }}
          onBlur={() => {
            if (!invalid) setRenameError(onRename(draft));
            else setDraft(currentKey);
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter") event.currentTarget.blur();
            if (event.key === "Escape") {
              setDraft(currentKey);
              setRenameError(undefined);
              event.currentTarget.blur();
            }
          }}
        />
        {renameError !== undefined && (
          <small className="input-error" id={errorId} role="alert">
            {renameError}
          </small>
        )}
      </span>
    </label>
  );
}

interface ArrayEditorProps extends CatalogEditorProps {
  readonly node: ConfigArrayCatalogNode;
  readonly value: unknown;
}

function ArrayEditor({
  node,
  path,
  persisted,
  baseline,
  searchQuery,
  onSet,
  onDelete,
  onValidityChange,
  configuredSecretPathKeys,
  invalidJsonDraftsByPath,
  onInvalidJsonDraftChange,
  value,
}: ArrayEditorProps) {
  const items = Array.isArray(value) ? value : [];
  const baselineValue = getAtPath(baseline, path);
  const changed = !sameConfigValue(value, baselineValue);
  function removeItem(index: number): void {
    onDelete([...path, index]);
  }
  return (
    <article className="compound-field" data-config-path={validationPath(path)}>
      <FieldHeader
        node={node}
        path={path}
        changed={changed}
        onUndo={() =>
          baselineValue === undefined ? onDelete(path) : onSet(path, structuredClone(baselineValue))
        }
      />
      <div className="array-list">
        {items.length === 0 && <div className="empty-inline">当前使用空列表。</div>}
        {items.map((_, index) => (
          <div className="array-item" key={`${formatPath(path)}-${String(index)}`}>
            <span className="array-index">{String(index + 1).padStart(2, "0")}</span>
            <div className="array-item-content">
              <CatalogEditor
                node={node.item}
                path={[...path, index]}
                persisted={persisted}
                baseline={baseline}
                searchQuery={searchQuery}
                onSet={onSet}
                onDelete={onDelete}
                onValidityChange={onValidityChange}
                configuredSecretPathKeys={configuredSecretPathKeys}
                invalidJsonDraftsByPath={invalidJsonDraftsByPath}
                onInvalidJsonDraftChange={onInvalidJsonDraftChange}
              />
            </div>
            <button
              className="icon-button danger-action"
              type="button"
              aria-label={`删除第 ${String(index + 1)} 项`}
              title="删除此项"
              onClick={() => removeItem(index)}
            >
              ×
            </button>
          </div>
        ))}
      </div>
      <button
        className="secondary-button"
        type="button"
        onClick={() => onSet(path, [...items, defaultValueForNode(node.item)])}
      >
        ＋ 添加{node.item.title === "*" ? "一项" : node.item.title}
      </button>
    </article>
  );
}

type PrimitiveNode = ConfigLeafCatalogNode | ConfigEnumCatalogNode | ConfigNumberCatalogNode;

interface PrimitiveFieldProps {
  readonly node: PrimitiveNode;
  readonly path: ConfigPath;
  readonly value: unknown;
  readonly baselineValue: unknown;
  readonly present: boolean;
  readonly disabled?: boolean;
  readonly onValue: (value: unknown) => void;
  readonly onUnset: () => void;
  readonly onUndo: () => void;
  readonly onValidityChange: (path: ConfigPath, message?: string) => void;
  readonly configuredSecretPathKeys: ReadonlySet<string>;
  readonly invalidJsonDraft?: string;
  readonly onInvalidJsonDraftChange: (path: ConfigPath, draft?: string) => void;
}

export function PrimitiveField({
  node,
  path,
  value,
  baselineValue,
  present,
  disabled = false,
  onValue,
  onUnset,
  onUndo,
  onValidityChange,
  configuredSecretPathKeys,
  invalidJsonDraft,
  onInvalidJsonDraftChange,
}: PrimitiveFieldProps) {
  const inputId = useId();
  const secretPresentation = resolveConfigSecretPresentation(
    node.secret,
    path,
    configuredSecretPathKeys,
    value,
  );
  const configuredSecret = secretPresentation.configured;
  const changed = invalidJsonDraft !== undefined || !sameConfigValue(value, baselineValue);
  const state = describeFieldState({
    present,
    value,
    ...(node.defaultValue !== undefined ? { defaultValue: node.defaultValue } : {}),
    configuredSecret,
    secret: secretPresentation.secret,
    required: node.persistedRequired,
    widget: node.widget,
    path,
  });
  const placeholder = configuredSecret
    ? "已配置 · 输入新值以替换"
    : node.defaultValue !== undefined
      ? `默认：${formatConfigValue(node.defaultValue, { widget: node.widget, path })}`
      : `输入${node.title}`;
  return (
    <article
      className={`primitive-field${present ? " is-persisted" : " is-inherited"}${disabled ? " is-derived" : ""}`}
      data-config-path={validationPath(path)}
    >
      <div className="primitive-copy">
        <label htmlFor={inputId} className="field-title">
          {node.title}
          {node.persistedRequired && <span className="required-mark">必须设置</span>}
        </label>
        <code className="field-path">{formatPath(path)}</code>
        {node.description !== undefined && (
          <p>
            <InlineCode text={node.description} />
          </p>
        )}
      </div>
      <div className="field-control">
        <PrimitiveControl
          id={inputId}
          node={node}
          value={value}
          present={present}
          disabled={disabled}
          placeholder={placeholder}
          configuredSecret={configuredSecret}
          effectiveSecret={secretPresentation.secret}
          onValue={onValue}
          onUnset={onUnset}
          path={path}
          onValidityChange={onValidityChange}
          {...(invalidJsonDraft !== undefined ? { invalidJsonDraft } : {})}
          onInvalidJsonDraftChange={onInvalidJsonDraftChange}
        />
        <small className="field-input-note">
          {disabled
            ? `当前生效：${state.currentLabel} · Web UI 不提供修改，请使用 roll config set 并按生效提示完成人工步骤`
            : `当前生效：${state.currentLabel}`}
        </small>
        <div className="field-meta-row">
          <span
            className={`source-chip ${disabled ? "derived" : changed || present ? "persisted" : "default"}`}
          >
            {disabled ? "仅支持 CLI 修改" : changed ? "本轮已修改" : state.sourceLabel}
          </span>
          {(changed || present) && !disabled && (
            <button className="text-button" type="button" onClick={changed ? onUndo : onUnset}>
              {changed ? "撤销本项" : state.resetLabel}
            </button>
          )}
        </div>
        <FieldHelp node={node} />
      </div>
    </article>
  );
}

interface PrimitiveControlProps {
  readonly id: string;
  readonly node: PrimitiveNode;
  readonly value: unknown;
  readonly present: boolean;
  readonly disabled: boolean;
  readonly placeholder: string;
  readonly configuredSecret: boolean;
  readonly effectiveSecret: boolean;
  readonly onValue: (value: unknown) => void;
  readonly onUnset: () => void;
  readonly path: ConfigPath;
  readonly onValidityChange: (path: ConfigPath, message?: string) => void;
  readonly invalidJsonDraft?: string;
  readonly onInvalidJsonDraftChange: (path: ConfigPath, draft?: string) => void;
}

function PrimitiveControl(props: PrimitiveControlProps) {
  const { node } = props;
  const resolveSecretInput = useRestorableSecretInput(props.configuredSecret, props.present);
  const rawTypedValue =
    typeof props.value === "string" &&
    (node.kind === "boolean" ||
      node.kind === "number" ||
      (node.kind === "enum" && !node.options.includes(props.value)));
  if (rawTypedValue) return <RawTypedValueControl {...props} />;
  switch (node.kind) {
    case "boolean":
      return <BooleanControl {...props} />;
    case "enum":
      return <EnumControl {...props} node={node} />;
    case "number":
      return <NumberControl {...props} node={node} />;
    case "unknown":
      return <JsonControl {...props} />;
    case "string":
      return (
        <input
          id={props.id}
          name={validationPath(props.path)}
          type={props.effectiveSecret ? "password" : node.widget === "url" ? "url" : "text"}
          value={props.configuredSecret ? "" : typeof props.value === "string" ? props.value : ""}
          placeholder={props.placeholder}
          autoComplete={props.effectiveSecret ? "new-password" : "off"}
          spellCheck={false}
          disabled={props.disabled}
          onChange={(event) =>
            props.onValue(
              props.effectiveSecret ? resolveSecretInput(event.target.value) : event.target.value,
            )
          }
        />
      );
  }
}

function RawTypedValueControl({
  id,
  node,
  value,
  disabled,
  placeholder,
  effectiveSecret,
  onValue,
  onUnset,
  path,
  onValidityChange,
}: PrimitiveControlProps) {
  const rawValue = typeof value === "string" ? value : "";
  const error =
    node.kind === "enum"
      ? validateEnvironmentReference(rawValue)
      : node.kind === "number"
        ? "Roll 数字字段仅支持固定值"
        : "Roll 布尔字段仅支持固定值";
  useEffect(() => {
    onValidityChange(path, error);
  }, [error, path, onValidityChange]);
  return (
    <div className="raw-value-control">
      <input
        id={id}
        name={validationPath(path)}
        type={effectiveSecret ? "password" : "text"}
        value={rawValue}
        placeholder={placeholder}
        disabled={disabled}
        spellCheck={false}
        autoComplete={effectiveSecret ? "new-password" : "off"}
        aria-invalid={error !== undefined}
        aria-describedby={error === undefined ? undefined : `${id}-error`}
        onChange={(event) => {
          const next = event.target.value;
          if (next.length === 0) {
            onValidityChange(path, undefined);
            onUnset();
          } else if (node.kind === "number" && Number.isFinite(Number(next))) {
            onValidityChange(path, validateNumberInput(next, node.constraints));
            onValue(Number(next));
          } else if (node.kind === "boolean" && (next === "true" || next === "false")) {
            onValidityChange(path, undefined);
            onValue(next === "true");
          } else {
            onValidityChange(
              path,
              node.kind === "enum"
                ? validateEnvironmentReference(next)
                : node.kind === "number"
                  ? "Roll 数字字段仅支持固定值"
                  : "Roll 布尔字段仅支持固定值",
            );
            onValue(next);
          }
        }}
      />
      {error !== undefined && (
        <small className="input-error" id={`${id}-error`}>
          {error}
        </small>
      )}
    </div>
  );
}

function NumberControl(props: PrimitiveControlProps & { readonly node: ConfigNumberCatalogNode }) {
  const value = typeof props.value === "number" ? String(props.value) : "";
  const error = validateNumberInput(value, props.node.constraints);
  const descriptionId = `${props.id}-number-note`;
  const errorId = `${props.id}-error`;
  return (
    <div className="number-control">
      <div className="input-with-unit">
        <input
          id={props.id}
          name={validationPath(props.path)}
          type="number"
          inputMode={props.node.constraints.integer ? "numeric" : "decimal"}
          value={value}
          min={props.node.constraints.minimum}
          max={props.node.constraints.maximum}
          step={props.node.constraints.integer ? 1 : "any"}
          placeholder={props.placeholder}
          disabled={props.disabled}
          autoComplete="off"
          aria-invalid={error !== undefined}
          aria-describedby={error === undefined ? descriptionId : `${descriptionId} ${errorId}`}
          onChange={(event) => {
            const next = event.target.value;
            const nextError = validateNumberInput(next, props.node.constraints);
            props.onValidityChange(props.path, nextError);
            if (next.length === 0) props.onUnset();
            else if (Number.isFinite(Number(next))) props.onValue(Number(next));
          }}
        />
        {props.node.widget === "duration" && <span>ms</span>}
      </div>
      <small className="field-input-note" id={descriptionId}>
        {formatNumberConstraints(props.node.constraints)} · 仅支持固定值
      </small>
      {error !== undefined && (
        <small className="input-error" id={errorId}>
          {error}
        </small>
      )}
    </div>
  );
}

function BooleanControl({
  id,
  node,
  value,
  present,
  disabled,
  onValue,
  onUnset,
  path,
  onValidityChange,
}: PrimitiveControlProps) {
  const selection = !present ? "inherit" : value === true ? "true" : "false";
  return (
    <div className="boolean-control">
      <div className="tri-toggle" role="group" aria-label={`${node.title} 布尔值选择`}>
        <button
          type="button"
          className={selection === "inherit" ? "active" : ""}
          aria-pressed={selection === "inherit"}
          disabled={disabled}
          onClick={() => {
            onValidityChange(path, undefined);
            onUnset();
          }}
        >
          {typeof node.defaultValue === "boolean"
            ? `默认 · ${node.defaultValue ? "开" : "关"}`
            : "未设置"}
        </button>
        <button
          type="button"
          id={id}
          className={selection === "true" ? "active" : ""}
          aria-pressed={selection === "true"}
          disabled={disabled}
          onClick={() => {
            onValidityChange(path, undefined);
            onValue(true);
          }}
        >
          开
        </button>
        <button
          type="button"
          className={selection === "false" ? "active" : ""}
          aria-pressed={selection === "false"}
          disabled={disabled}
          onClick={() => {
            onValidityChange(path, undefined);
            onValue(false);
          }}
        >
          关
        </button>
      </div>
      <small className="field-input-note">仅支持固定值</small>
    </div>
  );
}

function EnumControl({
  id,
  node,
  value,
  present,
  disabled,
  onValue,
  onUnset,
  path,
  onValidityChange,
}: PrimitiveControlProps & { readonly node: ConfigEnumCatalogNode }) {
  return (
    <div className="config-value-control">
      <select
        id={id}
        name={validationPath(path)}
        value={present && typeof value === "string" ? value : "__inherit__"}
        disabled={disabled}
        autoComplete="off"
        onChange={(event) => {
          onValidityChange(path, undefined);
          if (event.target.value === "__inherit__") onUnset();
          else onValue(event.target.value);
        }}
      >
        <option value="__inherit__">
          {node.defaultValue === undefined
            ? "未设置"
            : `使用默认值（${String(node.defaultValue)}）`}
        </option>
        {node.options.map((option) => (
          <option key={option} value={option}>
            {option}
          </option>
        ))}
      </select>
      <button
        type="button"
        className="env-reference-button"
        disabled={disabled}
        title="使用环境变量引用"
        aria-label={`为${node.title}使用环境变量引用`}
        onClick={() => {
          onValidityChange(path, undefined);
          onValue(ENV_REFERENCE_TEMPLATE);
        }}
      >
        ENV
      </button>
    </div>
  );
}

function JsonControl({
  id,
  value,
  disabled,
  placeholder,
  path,
  onValue,
  onValidityChange,
  invalidJsonDraft,
  onInvalidJsonDraftChange,
}: PrimitiveControlProps) {
  const serialized = useMemo(() => stringifyJsonValue(value), [value]);
  const draft = invalidJsonDraft ?? serialized;
  const error = invalidJsonDraft === undefined ? undefined : "请输入有效 JSON";
  return (
    <div className="json-control">
      <textarea
        id={id}
        name={validationPath(path)}
        rows={5}
        value={draft}
        placeholder={placeholder}
        disabled={disabled}
        aria-invalid={error !== undefined}
        aria-describedby={error === undefined ? undefined : `${id}-error`}
        onChange={(event) => {
          const next = event.target.value;
          try {
            onValue(JSON.parse(next));
            onInvalidJsonDraftChange(path, undefined);
            onValidityChange(path, undefined);
          } catch {
            onInvalidJsonDraftChange(path, next);
            onValidityChange(path, "请输入有效 JSON");
          }
        }}
      />
      {error !== undefined && (
        <small className="input-error" id={`${id}-error`}>
          {error}
        </small>
      )}
    </div>
  );
}

function formatNumberConstraints(constraints: ConfigNumberCatalogNode["constraints"]): string {
  const range: string[] = [];
  if (constraints.minimum !== undefined) {
    range.push(`${constraints.exclusiveMinimum ? ">" : "≥"} ${String(constraints.minimum)}`);
  }
  if (constraints.maximum !== undefined) {
    range.push(`${constraints.exclusiveMaximum ? "<" : "≤"} ${String(constraints.maximum)}`);
  }
  if (constraints.integer) range.push("整数");
  return range.length === 0 ? "任意有限数字" : range.join(" · ");
}

function FieldHeader({
  node,
  path,
  changed,
  onUndo,
}: {
  readonly node: ConfigCatalogNode;
  readonly path: ConfigPath;
  readonly changed: boolean;
  readonly onUndo: () => void;
}) {
  return (
    <div className="compound-heading">
      <div>
        <h3>{node.title}</h3>
        <code>{formatPath(path)}</code>
      </div>
      <div>
        {(node.description !== undefined || node.defaultBehavior !== undefined) && (
          <p>
            <InlineCode text={[node.description, node.defaultBehavior].filter(Boolean).join(" ")} />
          </p>
        )}
        {changed && (
          <button type="button" className="text-button" onClick={onUndo}>
            撤销本组修改
          </button>
        )}
      </div>
    </div>
  );
}

function FieldHelp({ node }: { readonly node: PrimitiveNode }) {
  if (
    node.defaultBehavior === undefined &&
    node.example === undefined &&
    node.setupCommand === undefined
  ) {
    return null;
  }
  return (
    <details>
      <summary className="text-button">查看默认行为与配置示例</summary>
      {node.defaultBehavior !== undefined && (
        <div className="field-input-note">
          不修改时：
          <InlineCode text={node.defaultBehavior} />
        </div>
      )}
      {node.example !== undefined && (
        <div className="field-input-note">
          YAML 示例：<code>{node.example.replaceAll("\n", " · ")}</code>
        </div>
      )}
      {node.setupCommand !== undefined && (
        <div className="field-input-note">
          也可以运行：<code>{node.setupCommand}</code>
        </div>
      )}
    </details>
  );
}

function stringifyJsonValue(value: unknown): string {
  if (value === undefined) return "";
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return "";
  }
}

function pathKey(path: ConfigPath): string {
  return path
    .map(String)
    .join("-")
    .replaceAll(/[^a-zA-Z0-9_-]/gu, "_");
}

function validationPath(path: ConfigPath): string {
  return path.map(String).join(".");
}
