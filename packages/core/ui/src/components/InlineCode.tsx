interface InlineCodeProps {
  readonly text: string;
}

/** Renders the shared guidance convention for short `inline code` fragments without HTML input. */
export function InlineCode({ text }: InlineCodeProps) {
  return (
    <>
      {text
        .split("`")
        .map((part, index) =>
          index % 2 === 1 ? <code key={`${part}-${String(index)}`}>{part}</code> : part,
        )}
    </>
  );
}
