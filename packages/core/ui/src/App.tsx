import { useCallback, useEffect, useRef, useState } from "react";
import { RollUiApi, RollUiApiError } from "./api.ts";
import {
  EDITOR_MODE_CHANGE_STRATEGIES,
  hasPathKeyedEntries,
  isCurrentDraftGeneration,
  isEditorDraftDirty,
  omitPathKeyedEntriesAtOrBelow,
  planEditorModeChange,
  wouldSecretProjectionLoseDraft,
} from "./app-state.ts";
import { AgentEnvironmentEditor } from "./components/AgentEnvironmentEditor.tsx";
import { ApplyDialog } from "./components/ApplyDialog.tsx";
import { CatalogEditor } from "./components/CatalogEditor.tsx";
import { CompanionPanel } from "./components/CompanionPanel.tsx";
import { Navigation } from "./components/Navigation.tsx";
import { ReviewPanel } from "./components/ReviewPanel.tsx";
import { YamlEditor } from "./components/YamlEditor.tsx";
import {
  getCatalogSearchMatches,
  resolveValidationIssueTarget,
  resolveVisibleNavigationTarget,
} from "./lib/catalog-search.ts";
import { isCompanionUnavailableError } from "./lib/companion-state.ts";
import { createConfiguredSecretPathKeys } from "./lib/config-secret.ts";
import { cloneObject, deleteAtPath, setAtPath } from "./lib/config-value.ts";
import type {
  AgentRuntimeStatus,
  AgentActivationResult,
  BootstrapInfo,
  ConfigApplicationPreview,
  ConfigApplicationSnapshot,
  ConfigPath,
  ConfigValidationIssue,
  EditorMode,
  JsonObject,
  NavigationTarget,
  RollConfigCatalog,
  SaveDraft,
} from "./types.ts";

type LoadState =
  | { readonly status: "loading" }
  | { readonly status: "error"; readonly message: string }
  | {
      readonly status: "ready";
      readonly bootstrap: BootstrapInfo;
      readonly catalog: RollConfigCatalog;
      readonly snapshot: ConfigApplicationSnapshot;
    };

type Toast = { readonly tone: "success" | "warning"; readonly message: string };
type BusyAction = "preview" | "save" | "apply";
type WorkspaceView = "config" | "companion";

const api = new RollUiApi();

export function App() {
  const [loadState, setLoadState] = useState<LoadState>({ status: "loading" });
  const [mode, setMode] = useState<EditorMode>("form");
  const [active, setActive] = useState<NavigationTarget>({ type: "roll", key: "llm" });
  const [query, setQuery] = useState("");
  const [persistedDraft, setPersistedDraft] = useState<JsonObject>({});
  const [yamlDraft, setYamlDraft] = useState("");
  const [preview, setPreview] = useState<ConfigApplicationPreview | null>(null);
  const [issues, setIssues] = useState<readonly ConfigValidationIssue[]>([]);
  const [clientIssuesByPath, setClientIssuesByPath] = useState<
    Readonly<Record<string, ConfigValidationIssue>>
  >({});
  const [invalidJsonDraftsByPath, setInvalidJsonDraftsByPath] = useState<
    Readonly<Record<string, string>>
  >({});
  const [busyAction, setBusyAction] = useState<BusyAction | null>(null);
  const [agents, setAgents] = useState<readonly AgentRuntimeStatus[]>([]);
  const [agentsCheckedAt, setAgentsCheckedAt] = useState<string>();
  const [agentsLoading, setAgentsLoading] = useState(false);
  const [agentStatusError, setAgentStatusError] = useState<string>();
  const [applyDialogOpen, setApplyDialogOpen] = useState(false);
  const [activationResult, setActivationResult] = useState<AgentActivationResult>();
  const [toast, setToast] = useState<Toast>();
  const [view, setView] = useState<WorkspaceView>("config");
  const [companionAvailable, setCompanionAvailable] = useState(false);
  const draftGenerationRef = useRef(0);
  const activeActionRef = useRef<BusyAction | null>(null);

  const snapshot = loadState.status === "ready" ? loadState.snapshot : null;
  const dirty =
    snapshot !== null &&
    (isEditorDraftDirty(mode, persistedDraft, yamlDraft, snapshot.persisted, snapshot.yaml) ||
      hasPathKeyedEntries(invalidJsonDraftsByPath));
  const clientIssues = Object.values(clientIssuesByPath);
  const hasClientIssues = clientIssues.length > 0;

  const handleValidityChange = useCallback((path: ConfigPath, message?: string): void => {
    const key = JSON.stringify(path);
    if (message !== undefined) {
      draftGenerationRef.current += 1;
      setPreview(null);
      setApplyDialogOpen(false);
    }
    setClientIssuesByPath((current) => {
      if (message === undefined) {
        if (current[key] === undefined) return current;
        const next = { ...current };
        delete next[key];
        return next;
      }
      const issue = { path: path.map(String).join("."), message };
      if (current[key]?.message === issue.message) return current;
      return { ...current, [key]: issue };
    });
  }, []);

  const handleInvalidJsonDraftChange = useCallback((path: ConfigPath, draft?: string): void => {
    const key = JSON.stringify(path);
    setInvalidJsonDraftsByPath((current) => {
      if (draft === undefined) {
        if (current[key] === undefined) return current;
        const next = { ...current };
        delete next[key];
        return next;
      }
      return current[key] === draft ? current : { ...current, [key]: draft };
    });
  }, []);

  const handleCompanionUnavailable = useCallback(() => {
    setCompanionAvailable(false);
    setView("config");
    setToast({ tone: "warning", message: "当前 roll ui 未启用 Companion 管理。" });
  }, []);

  const loadAgentStatus = useCallback(async () => {
    setAgentsLoading(true);
    setAgentStatusError(undefined);
    try {
      const status = await api.getAgentStatus();
      setAgents(status.agents);
      if (status.checkedAt !== undefined) setAgentsCheckedAt(status.checkedAt);
    } catch (error) {
      const message = describeError(error);
      setAgentStatusError(message);
      setToast({ tone: "warning", message });
    } finally {
      setAgentsLoading(false);
    }
  }, []);

  useEffect(() => {
    let activeRequest = true;
    async function initialize(): Promise<void> {
      try {
        const bootstrap = await api.bootstrap();
        const [catalog, loadedSnapshot, statusResult, companionSupported] = await Promise.all([
          api.getCatalog(),
          api.getConfig(),
          api.getAgentStatus().then(
            (status) => ({ status: "success" as const, value: status }),
            (error: unknown) => ({ status: "error" as const, message: describeError(error) }),
          ),
          api.getCompanionStatus().then(
            () => true,
            (error: unknown) => !isCompanionUnavailableError(error),
          ),
        ]);
        if (!activeRequest) {
          return;
        }
        setCompanionAvailable(companionSupported);
        setPersistedDraft(cloneObject(loadedSnapshot.persisted));
        setYamlDraft(loadedSnapshot.yaml);
        if (loadedSnapshot.repairMode === true) {
          setMode("yaml");
          setIssues(loadedSnapshot.validationIssues ?? []);
          setToast({ tone: "warning", message: "当前配置未通过校验，请在 YAML 模式修复后保存。" });
        }
        if (statusResult.status === "success") {
          setAgents(statusResult.value.agents);
          if (statusResult.value.checkedAt !== undefined) {
            setAgentsCheckedAt(statusResult.value.checkedAt);
          }
        } else {
          setAgentStatusError(statusResult.message);
        }
        const preferredModule = catalog.root.fields.llm !== undefined ? "llm" : undefined;
        const firstModule = Object.keys(catalog.root.fields)[0];
        const initialModule = preferredModule ?? firstModule;
        if (initialModule !== undefined) {
          setActive({ type: "roll", key: initialModule });
        }
        setLoadState({ status: "ready", bootstrap, catalog, snapshot: loadedSnapshot });
      } catch (error) {
        if (activeRequest) setLoadState({ status: "error", message: describeError(error) });
      }
    }
    initialize().catch(() => undefined);
    return () => {
      activeRequest = false;
    };
  }, []);

  useEffect(() => {
    function handleKeydown(event: KeyboardEvent): void {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        document.querySelector<HTMLInputElement>("#config-search")?.focus();
      }
    }
    window.addEventListener("keydown", handleKeydown);
    return () => window.removeEventListener("keydown", handleKeydown);
  }, []);

  useEffect(() => {
    if (toast === undefined) return;
    if (toast.tone === "warning") return;
    const timer = window.setTimeout(() => setToast(undefined), 4_000);
    return () => window.clearTimeout(timer);
  }, [toast]);

  useEffect(() => {
    if (!dirty) return;
    const warnBeforeUnload = (event: BeforeUnloadEvent): void => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warnBeforeUnload);
    return () => window.removeEventListener("beforeunload", warnBeforeUnload);
  }, [dirty]);

  if (loadState.status === "loading") return <LoadingScreen />;
  if (loadState.status === "error") return <ErrorScreen message={loadState.message} />;

  const { bootstrap, catalog, snapshot: currentSnapshot } = loadState;
  const configuredSecretPathKeys = createConfiguredSecretPathKeys(
    currentSnapshot.configuredSecretPaths,
  );
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const searchMatches = getCatalogSearchMatches(catalog, normalizedQuery);
  const visibleActive = resolveVisibleNavigationTarget(active, searchMatches);
  const selectedRollNode =
    visibleActive?.type === "roll" ? catalog.root.fields[visibleActive.key] : undefined;
  const selectedAgent =
    visibleActive?.type === "agent"
      ? catalog.agents.find((agent) => agent.name === visibleActive.name)
      : undefined;

  function markEdited(): void {
    draftGenerationRef.current += 1;
    setPreview(null);
    setIssues([]);
    setActivationResult(undefined);
    setApplyDialogOpen(false);
  }

  function setConfigValue(path: ConfigPath, value: unknown): void {
    setPersistedDraft((current) => setAtPath(current, path, value));
    markEdited();
  }

  function deleteConfigValue(path: ConfigPath): void {
    setPersistedDraft((current) => deleteAtPath(current, path));
    const cleanupPath = typeof path.at(-1) === "number" ? path.slice(0, -1) : path;
    setClientIssuesByPath((current) => omitPathKeyedEntriesAtOrBelow(current, cleanupPath));
    setInvalidJsonDraftsByPath((current) => omitPathKeyedEntriesAtOrBelow(current, cleanupPath));
    markEdited();
  }

  function createDraft(): SaveDraft {
    return mode === "form"
      ? { mode, expectedRevision: currentSnapshot.revision, persisted: persistedDraft }
      : { mode, expectedRevision: currentSnapshot.revision, yaml: yamlDraft };
  }

  function startAction(action: BusyAction): boolean {
    if (activeActionRef.current !== null) return false;
    activeActionRef.current = action;
    setBusyAction(action);
    return true;
  }

  function finishAction(action: BusyAction): void {
    if (activeActionRef.current !== action) return;
    activeActionRef.current = null;
    setBusyAction(null);
  }

  async function runPreview(): Promise<ConfigApplicationPreview | null> {
    if (hasClientIssues) {
      setToast({ tone: "warning", message: "请先修复表单中的无效草稿。" });
      const firstIssue = clientIssues[0];
      if (firstIssue !== undefined) revealValidationIssue(firstIssue);
      return null;
    }
    if (!startAction("preview")) return null;
    const requestGeneration = draftGenerationRef.current;
    const draft = createDraft();
    setIssues([]);
    try {
      const result = await api.previewConfig(draft);
      if (!isCurrentDraftGeneration(requestGeneration, draftGenerationRef.current)) {
        setPreview(null);
        setToast({ tone: "warning", message: "预览期间草稿已变化；旧预览已忽略，请重新预览。" });
        return null;
      }
      setPreview(result);
      return result;
    } catch (error) {
      if (isCurrentDraftGeneration(requestGeneration, draftGenerationRef.current)) {
        handleActionError(error);
      } else {
        setToast({ tone: "warning", message: "草稿已变化；旧预览错误已忽略，请重新预览。" });
      }
      return null;
    } finally {
      finishAction("preview");
    }
  }

  function installSavedResult(
    result: ConfigApplicationPreview,
    requestGeneration: number,
  ): boolean {
    const responseMatchesDraft = isCurrentDraftGeneration(
      requestGeneration,
      draftGenerationRef.current,
    );
    setLoadState((current) =>
      current.status === "ready" ? { ...current, snapshot: result.snapshot } : current,
    );
    if (responseMatchesDraft) {
      setPersistedDraft(cloneObject(result.snapshot.persisted));
      setYamlDraft(result.snapshot.yaml);
      setPreview(null);
      setClientIssuesByPath({});
      setInvalidJsonDraftsByPath({});
    } else {
      setPreview(null);
    }
    setIssues([]);
    setActivationResult(undefined);
    return responseMatchesDraft;
  }

  async function saveOnly(): Promise<ConfigApplicationPreview | null> {
    if (hasClientIssues) {
      setToast({ tone: "warning", message: "请先修复表单中的无效草稿。" });
      const firstIssue = clientIssues[0];
      if (firstIssue !== undefined) revealValidationIssue(firstIssue);
      return null;
    }
    if (!startAction("save")) return null;
    const requestGeneration = draftGenerationRef.current;
    const draft = createDraft();
    setIssues([]);
    try {
      const result = await api.saveConfig(draft);
      const responseMatchesDraft = installSavedResult(result, requestGeneration);
      setToast({
        tone: responseMatchesDraft ? "success" : "warning",
        message: responseMatchesDraft
          ? result.backupPath === undefined
            ? "配置已保存。"
            : `配置已保存，备份：${result.backupPath}`
          : "请求发出时的配置已保存；期间的新修改仍保留，尚未保存。",
      });
      setApplyDialogOpen(false);
      return result;
    } catch (error) {
      if (isCurrentDraftGeneration(requestGeneration, draftGenerationRef.current)) {
        handleActionError(error);
      } else {
        setToast({
          tone: "warning",
          message: `${describeError(error)} 期间的新修改仍保留，请重新预览后保存。`,
        });
      }
      return null;
    } finally {
      finishAction("save");
    }
  }

  async function requestSaveAndApply(): Promise<void> {
    const candidate = preview ?? (await runPreview());
    if (candidate === null) return;
    setApplyDialogOpen(true);
  }

  function discardDraft(): void {
    if (!dirty || !window.confirm("放弃本轮全部修改并恢复到磁盘上的配置？")) return;
    draftGenerationRef.current += 1;
    setPersistedDraft(cloneObject(currentSnapshot.persisted));
    setYamlDraft(currentSnapshot.yaml);
    setPreview(null);
    setIssues([]);
    setClientIssuesByPath({});
    setInvalidJsonDraftsByPath({});
    setApplyDialogOpen(false);
    setToast({ tone: "success", message: "本轮修改已放弃，已恢复到磁盘配置。" });
  }

  function navigateTo(target: NavigationTarget, focusPath?: readonly string[]): void {
    setActive(target);
    setView("config");
    if (focusPath === undefined) return;
    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => focusConfigPath(focusPath.join(".")));
    });
  }

  async function confirmSaveAndApply(): Promise<void> {
    if (!startAction("apply")) return;
    let configWasSaved = false;
    const requestGeneration = draftGenerationRef.current;
    const draft = createDraft();
    setIssues([]);
    try {
      const saved = await api.saveConfig(draft);
      configWasSaved = true;
      const responseMatchesDraft = installSavedResult(saved, requestGeneration);
      const restartEffects = saved.effects.filter((effect) => effect.kind === "restart-agent");
      const activation =
        saved.effects.length > 0 ? await api.applyEffects(saved.effects) : undefined;
      setActivationResult(activation?.result);
      if (activation !== undefined && !activation.applied) {
        throw new Error(activation.message ?? "配置已保存，但运行时应用计划未执行。");
      }
      await loadAgentStatus();
      setApplyDialogOpen(false);
      setToast({
        tone:
          !responseMatchesDraft || activation?.result?.requiresManualAction === true
            ? "warning"
            : "success",
        message: !responseMatchesDraft
          ? "请求发出时的配置已保存并应用；期间的新修改仍保留，尚未保存。"
          : (activation?.message ??
            (restartEffects.length > 0
              ? "配置已保存，运行中的 Agent 已按计划应用。"
              : saved.effects.some((effect) => effect.kind === "manual")
                ? "配置已保存；人工步骤仍需完成。"
                : "配置已保存，后续命令会读取最新配置。")),
      });
    } catch (error) {
      if (configWasSaved) setApplyDialogOpen(false);
      handleActionError(error);
    } finally {
      finishAction("apply");
    }
  }

  async function changeMode(nextMode: EditorMode): Promise<void> {
    if (activeActionRef.current !== null) return;
    const strategy = planEditorModeChange(mode, nextMode, dirty);
    switch (strategy) {
      case EDITOR_MODE_CHANGE_STRATEGIES.noop:
        return;
      case EDITOR_MODE_CHANGE_STRATEGIES.blockYamlDraft:
        setToast({
          tone: "warning",
          message: "YAML 草稿尚未保存。为保留注释与格式，请先保存，再切换到表单模式。",
        });
        return;
      case EDITOR_MODE_CHANGE_STRATEGIES.switchClean:
        setPersistedDraft(cloneObject(currentSnapshot.persisted));
        setYamlDraft(currentSnapshot.yaml);
        setClientIssuesByPath({});
        setInvalidJsonDraftsByPath({});
        setMode(nextMode);
        return;
      case EDITOR_MODE_CHANGE_STRATEGIES.previewFormDraft: {
        const converted = preview ?? (await runPreview());
        if (converted === null) return;
        if (wouldSecretProjectionLoseDraft(persistedDraft, converted.snapshot)) {
          setToast({
            tone: "warning",
            message:
              "表单草稿包含尚未保存的敏感值。为避免脱敏预览覆盖该值，请先保存，再切换到 YAML。",
          });
          return;
        }
        setPersistedDraft(cloneObject(converted.snapshot.persisted));
        setYamlDraft(converted.snapshot.yaml);
        setMode(nextMode);
      }
    }
  }

  function handleActionError(error: unknown): void {
    if (error instanceof RollUiApiError && error.issues.length > 0) {
      setIssues(error.issues);
      const firstIssue = error.issues[0];
      if (firstIssue !== undefined) revealValidationIssue(firstIssue);
    }
    setToast({ tone: "warning", message: describeError(error) });
  }

  function revealValidationIssue(issue: ConfigValidationIssue): void {
    const target = resolveValidationIssueTarget(catalog, issue.path);
    if (target !== undefined) setActive(target);
    setQuery("");
    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => focusConfigPath(issue.path));
    });
  }

  const agentStatusProps = {
    agents,
    loading: agentsLoading,
    ...(agentStatusError !== undefined ? { error: agentStatusError } : {}),
    ...(agentsCheckedAt !== undefined ? { checkedAt: agentsCheckedAt } : {}),
    onRefresh: () => {
      loadAgentStatus().catch(handleActionError);
    },
  };

  const companionView = view === "companion" && companionAvailable;

  return (
    <div className={companionView ? "app-shell companion-view" : "app-shell"}>
      <a className="skip-link" href="#config-editor-main">
        跳到配置编辑区
      </a>
      <h1 className="sr-only">Roll 本地配置控制台</h1>
      <header className="top-bar">
        <div className="brand-block">
          <div className="roll-mark" aria-hidden="true">
            <span>R</span>
          </div>
          <div>
            <strong>ROLL</strong>
            <span>LOCAL CONTROL / CONFIG</span>
          </div>
        </div>
        <div className="document-identity" title={currentSnapshot.configPath}>
          <span className="document-dot" />
          <div>
            <small>ACTIVE DOCUMENT</small>
            <code>{shortenPath(currentSnapshot.configPath)}</code>
          </div>
        </div>
        <div className="top-actions">
          <div className="mode-switch" role="group" aria-label="编辑模式">
            <button
              type="button"
              className={mode === "form" ? "active" : ""}
              aria-pressed={mode === "form"}
              disabled={busyAction !== null}
              onClick={() => {
                changeMode("form").catch(handleActionError);
              }}
            >
              FORM
            </button>
            <button
              type="button"
              className={mode === "yaml" ? "active" : ""}
              aria-pressed={mode === "yaml"}
              disabled={busyAction !== null}
              onClick={() => {
                changeMode("yaml").catch(handleActionError);
              }}
            >
              YAML
            </button>
          </div>
          <button
            className="secondary-button save-button"
            type="button"
            disabled={!dirty || busyAction !== null}
            onClick={discardDraft}
          >
            放弃修改
          </button>
          <button
            className="primary-button save-button"
            type="button"
            disabled={!dirty || busyAction !== null}
            onClick={() => {
              requestSaveAndApply().catch(handleActionError);
            }}
          >
            {busyAction === "preview"
              ? "正在审阅…"
              : busyAction === "apply" || busyAction === "save"
                ? "正在保存…"
                : "审阅并保存"}
          </button>
        </div>
      </header>

      <Navigation
        catalog={catalog}
        active={visibleActive ?? active}
        query={query}
        disabled={mode === "yaml"}
        companionAvailable={companionAvailable}
        companionActive={companionView}
        onQueryChange={setQuery}
        onNavigate={navigateTo}
        onOpenCompanion={() => setView("companion")}
      />

      <main id="config-editor-main" className="editor-main" tabIndex={-1}>
        <div className="editor-scroll-region">
          {companionView ? (
            <CompanionPanel
              api={api}
              onToast={setToast}
              onUnavailable={handleCompanionUnavailable}
            />
          ) : (
            <>
              {currentSnapshot.repairMode === true && (
                <div className="repair-banner" role="alert">
                  <strong>REPAIR MODE</strong>
                  <span>当前 YAML 可解析，但配置校验失败；只有修复为有效配置后才能保存。</span>
                </div>
              )}
              {mode === "yaml" ? (
                <YamlEditor
                  value={yamlDraft}
                  onChange={(value) => {
                    setYamlDraft(value);
                    markEdited();
                  }}
                />
              ) : visibleActive === undefined ? (
                <div className="empty-state" role="status">
                  没有匹配“{query}”的配置。
                </div>
              ) : selectedRollNode !== undefined && visibleActive.type === "roll" ? (
                <CatalogEditor
                  node={selectedRollNode}
                  path={[visibleActive.key]}
                  persisted={persistedDraft}
                  baseline={currentSnapshot.persisted}
                  searchQuery={normalizedQuery}
                  onSet={setConfigValue}
                  onDelete={deleteConfigValue}
                  onValidityChange={handleValidityChange}
                  configuredSecretPathKeys={configuredSecretPathKeys}
                  invalidJsonDraftsByPath={invalidJsonDraftsByPath}
                  onInvalidJsonDraftChange={handleInvalidJsonDraftChange}
                />
              ) : selectedAgent !== undefined ? (
                <AgentEnvironmentEditor
                  agent={selectedAgent}
                  persisted={persistedDraft}
                  baseline={currentSnapshot.persisted}
                  searchQuery={normalizedQuery}
                  onSet={setConfigValue}
                  onDelete={deleteConfigValue}
                  onValidityChange={handleValidityChange}
                  configuredSecretPathKeys={configuredSecretPathKeys}
                />
              ) : (
                <div className="empty-state">请选择一个配置模块。</div>
              )}
            </>
          )}
        </div>
        <footer className="editor-footer">
          <span>SCHEMA v{catalog.schemaVersion}</span>
          <span>REV {currentSnapshot.revision.slice(0, 8)}</span>
          <span>{currentSnapshot.existed ? "ON DISK" : "NEW FILE"}</span>
          {bootstrap.version !== undefined && <span>ROLL {bootstrap.version}</span>}
        </footer>
      </main>

      {!companionView && (
        <ReviewPanel
          dirty={dirty}
          preview={preview}
          catalog={catalog}
          before={currentSnapshot.persisted}
          issues={[...issues, ...clientIssues]}
          busy={busyAction !== null}
          agentStatus={agentStatusProps}
          onPreview={() => {
            runPreview().catch(handleActionError);
          }}
          onIssueSelect={revealValidationIssue}
          {...(activationResult !== undefined ? { activationResult } : {})}
        />
      )}

      <ApplyDialog
        open={applyDialogOpen}
        effects={preview?.effects ?? []}
        busy={busyAction === "apply" || busyAction === "save"}
        onCancel={() => setApplyDialogOpen(false)}
        onSaveOnly={() => {
          saveOnly().catch(handleActionError);
        }}
        onConfirm={() => {
          confirmSaveAndApply().catch(handleActionError);
        }}
      />

      {toast !== undefined && (
        <div
          className={`toast ${toast.tone}`}
          role={toast.tone === "warning" ? "alert" : "status"}
          aria-live={toast.tone === "warning" ? "assertive" : "polite"}
        >
          <span>{toast.tone === "success" ? "✓" : "!"}</span>
          <p>{toast.message}</p>
          <button type="button" aria-label="关闭通知" onClick={() => setToast(undefined)}>
            ×
          </button>
        </div>
      )}
    </div>
  );
}

function LoadingScreen() {
  return (
    <main className="boot-screen" aria-busy="true">
      <div className="boot-mark">
        <span>R</span>
      </div>
      <p className="eyebrow">ROLL / LOCAL CONTROL</p>
      <h1>正在建立本地安全会话</h1>
      <div className="boot-progress">
        <span />
      </div>
      <code>127.0.0.1 · one-time bootstrap</code>
    </main>
  );
}

function ErrorScreen({ message }: { readonly message: string }) {
  return (
    <main className="boot-screen error-screen">
      <div className="boot-mark error">
        <span>!</span>
      </div>
      <p className="eyebrow">SESSION UNAVAILABLE</p>
      <h1>无法打开配置控制台</h1>
      <p>{message}</p>
      <button className="primary-button" type="button" onClick={() => window.location.reload()}>
        重新连接
      </button>
      <small>
        如果一次性链接已使用，请停止后重新执行 <code>roll ui</code>。
      </small>
    </main>
  );
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function focusConfigPath(path: string): void {
  const candidates = validationPathCandidates(path);
  const fields = [...document.querySelectorAll<HTMLElement>("[data-config-path]")];
  const field = candidates
    .map((candidate) => fields.find((element) => element.dataset["configPath"] === candidate))
    .find((element) => element !== undefined);
  if (field === undefined) return;
  const focusTarget = field.querySelector<HTMLElement>(
    'input:not(:disabled), select:not(:disabled), textarea:not(:disabled), button:not(:disabled), [tabindex="0"]',
  );
  field.scrollIntoView({
    block: "center",
    behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth",
  });
  focusTarget?.focus({ preventScroll: true });
}

function validationPathCandidates(path: string): readonly string[] {
  const parts = path.split(".").filter((part) => part.length > 0);
  return parts.map((_, index) => parts.slice(0, parts.length - index).join("."));
}

function shortenPath(path: string): string {
  if (path.length <= 54) return path;
  const parts = path.split("/");
  return `…/${parts.slice(-3).join("/")}`;
}
