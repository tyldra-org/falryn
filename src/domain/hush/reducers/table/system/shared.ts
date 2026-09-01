export type SourceLines = Readonly<{
  lines: readonly string[];
  trailingNewline: boolean;
}>;

export function splitSource(source: string): SourceLines {
  const trailingNewline = source.endsWith("\n");
  const lines = source.split("\n");
  if (trailingNewline) {
    lines.pop();
  }
  return { lines, trailingNewline };
}

export function renderLines(lines: readonly string[], trailingNewline: boolean): string {
  const rendered = lines.join("\n");
  return trailingNewline ? `${rendered}\n` : rendered;
}

export function renderRows(rows: readonly (readonly string[])[], trailingNewline: boolean): string {
  return renderLines(
    rows.map((row) => row.join("\t")),
    trailingNewline,
  );
}
