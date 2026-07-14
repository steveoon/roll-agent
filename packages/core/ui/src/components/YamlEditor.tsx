import { useMemo, useRef } from "react";

interface YamlEditorProps {
  readonly value: string;
  readonly onChange: (value: string) => void;
}

export function YamlEditor({ value, onChange }: YamlEditorProps) {
  const lineRailRef = useRef<HTMLPreElement>(null);
  const lines = useMemo(
    () =>
      value
        .split("\n")
        .map((_, index) => String(index + 1))
        .join("\n"),
    [value],
  );
  return (
    <section className="yaml-workspace" aria-labelledby="yaml-editor-title">
      <header className="section-heading">
        <div>
          <p className="eyebrow">RAW DOCUMENT</p>
          <h2 id="yaml-editor-title">YAML 编辑器</h2>
        </div>
        <span className="section-count">{value.split("\n").length} lines</span>
      </header>
      <p className="section-description">
        保留注释、锚点与 <code>&#36;&#123;ENV_VAR&#125;</code> 引用；敏感明文会显示为安全占位符。
      </p>
      <div className="yaml-editor-shell">
        <pre ref={lineRailRef} className="yaml-line-rail" aria-hidden="true">
          {lines}
        </pre>
        <label className="sr-only" htmlFor="yaml-source">
          roll.config.yaml 内容
        </label>
        <textarea
          id="yaml-source"
          value={value}
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          onScroll={(event) => {
            if (lineRailRef.current !== null) {
              lineRailRef.current.scrollTop = event.currentTarget.scrollTop;
            }
          }}
          onChange={(event) => onChange(event.target.value)}
        />
      </div>
    </section>
  );
}
