import { getCatalogSearchMatches, getCatalogSearchResults } from "../lib/catalog-search.ts";
import type { NavigationTarget, RollConfigCatalog } from "../types.ts";

interface NavigationProps {
  readonly catalog: RollConfigCatalog;
  readonly active: NavigationTarget;
  readonly query: string;
  readonly disabled: boolean;
  readonly onQueryChange: (query: string) => void;
  readonly onNavigate: (target: NavigationTarget, focusPath?: readonly string[]) => void;
}

export function Navigation({
  catalog,
  active,
  query,
  disabled,
  onQueryChange,
  onNavigate,
}: NavigationProps) {
  const { rollModules, agents: agentModules } = getCatalogSearchMatches(catalog, query);
  const searchResults = getCatalogSearchResults(catalog, query);
  const searching = query.trim().length > 0;
  return (
    <nav className="side-navigation" aria-label="配置模块">
      <div className="search-box">
        <span aria-hidden="true">⌕</span>
        <label className="sr-only" htmlFor="config-search">
          搜索配置
        </label>
        <input
          id="config-search"
          name="config-search"
          type="search"
          value={query}
          placeholder={disabled ? "切换到 FORM 后搜索" : "搜索用途 / 配置名 / key…"}
          autoComplete="off"
          disabled={disabled}
          onChange={(event) => onQueryChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape") onQueryChange("");
          }}
        />
        <kbd>⌘/Ctrl K</kbd>
      </div>

      <div className="nav-scroll-region">
        {searching ? (
          <>
            <NavSectionLabel label="SEARCH RESULTS" count={searchResults.length} />
            <div className="nav-list">
              {searchResults.map((result, index) => (
                <button
                  key={`${result.path.join(".")}-${String(index)}`}
                  type="button"
                  disabled={disabled}
                  title={result.path.join(".")}
                  onClick={() => onNavigate(result.target, result.focusPath)}
                >
                  <span className="nav-index">{String(index + 1).padStart(2, "0")}</span>
                  <span>
                    <strong>{result.title}</strong>
                    <small>{result.description ?? result.path.join(".")}</small>
                  </span>
                  <span className="nav-arrow" aria-hidden="true">
                    →
                  </span>
                </button>
              ))}
            </div>
            {searchResults.length === 0 && (
              <div className="nav-empty">没有匹配“{query}”的配置项。</div>
            )}
          </>
        ) : (
          <>
            <NavSectionLabel label="ROLL CORE" count={rollModules.length} />
            <div className="nav-list">
              {rollModules.map(([key, node], index) => {
                const target: NavigationTarget = { type: "roll", key };
                return (
                  <button
                    key={key}
                    className={isActive(active, target) ? "active" : ""}
                    type="button"
                    disabled={disabled}
                    aria-current={isActive(active, target) ? "page" : undefined}
                    onClick={() => onNavigate(target)}
                  >
                    <span className="nav-index">{String(index + 1).padStart(2, "0")}</span>
                    <span>
                      <strong>{node.title}</strong>
                      <small>{key}</small>
                    </span>
                    <span className="nav-arrow" aria-hidden="true">
                      →
                    </span>
                  </button>
                );
              })}
            </div>

            <NavSectionLabel label="SUBAGENT ENV" count={agentModules.length} />
            <div className="nav-list agent-nav-list">
              {agentModules.map((agent, index) => {
                const target: NavigationTarget = { type: "agent", name: agent.name };
                return (
                  <button
                    key={agent.name}
                    className={isActive(active, target) ? "active" : ""}
                    type="button"
                    disabled={disabled}
                    aria-current={isActive(active, target) ? "page" : undefined}
                    onClick={() => onNavigate(target)}
                  >
                    <span className="nav-index">A{String(index + 1).padStart(2, "0")}</span>
                    <span>
                      <strong>{agent.name}</strong>
                      <small>{formatOwnership(agent.ownership)}</small>
                    </span>
                    <span className="nav-arrow" aria-hidden="true">
                      →
                    </span>
                  </button>
                );
              })}
            </div>

            {rollModules.length === 0 && agentModules.length === 0 && (
              <div className="nav-empty">没有可配置的模块。</div>
            )}
          </>
        )}
      </div>
      <div className="nav-footnote">
        <span className="status-light" />
        <span>LOCAL ONLY</span>
        <small>127.0.0.1</small>
      </div>
    </nav>
  );
}

function NavSectionLabel({ label, count }: { readonly label: string; readonly count: number }) {
  return (
    <div className="nav-section-label">
      <span>{label}</span>
      <span>{String(count).padStart(2, "0")}</span>
    </div>
  );
}

function isActive(current: NavigationTarget, target: NavigationTarget): boolean {
  return (
    current.type === target.type &&
    (current.type === "roll" && target.type === "roll"
      ? current.key === target.key
      : current.type === "agent" && target.type === "agent" && current.name === target.name)
  );
}

function formatOwnership(ownership: string): string {
  return ownership.replace("-", " ").toUpperCase();
}
