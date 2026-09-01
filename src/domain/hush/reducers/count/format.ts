/** Complete, command-aware compaction for `wc` count rows. */

type WcCommandShape = Readonly<{
  defaultColumns: boolean;
  operands: readonly string[];
  columns: number;
}>;

type WcRow = Readonly<{
  counts: readonly string[];
  label: string | null;
}>;

const LONG_COLUMN_FLAGS: Readonly<Record<string, string>> = {
  "--bytes": "c",
  "--chars": "m",
  "--lines": "l",
  "--max-line-length": "L",
  "--words": "w",
};
const SHORT_COLUMN_FLAGS = new Set(["c", "l", "m", "w", "L"]);

export function formatWcOutput(source: string, commandTokens: readonly string[]): string | null {
  const shape = wcCommandShape(commandTokens);
  if (shape === null) {
    return null;
  }
  const trailingNewline = source.endsWith("\n");
  const lines = source.split("\n");
  if (trailingNewline) {
    lines.pop();
  }
  if (lines.length === 0) {
    return null;
  }
  const rows = lines.map((line) => parseWcRow(line, shape.columns));
  if (rows.some((row) => row === null)) {
    return null;
  }
  const completeRows = rows.filter((row): row is WcRow => row !== null);
  if (!rowsMatchOperands(completeRows, shape.operands)) {
    return null;
  }

  const formatted = completeRows.map((row, index) => {
    const counts = formatCounts(row.counts, shape.defaultColumns);
    if (shape.operands.length <= 1) {
      return counts;
    }
    if (index === shape.operands.length) {
      return `Σ ${counts}`;
    }
    return `${counts} ${baseName(shape.operands[index] ?? "")}`;
  });
  const result = formatted.join("\n");
  return trailingNewline ? `${result}\n` : result;
}

function wcCommandShape(tokens: readonly string[]): WcCommandShape | null {
  const operands: string[] = [];
  const columns = new Set<string>();
  let optionsEnded = false;
  for (const token of tokens.slice(1)) {
    if (optionsEnded) {
      operands.push(token);
      continue;
    }
    if (token === "--") {
      optionsEnded = true;
      continue;
    }
    if (token === "--files0-from" || token.startsWith("--files0-from=")) {
      return null;
    }
    if (token.startsWith("--")) {
      const column = LONG_COLUMN_FLAGS[token];
      if (column === undefined) {
        return null;
      }
      columns.add(column);
      continue;
    }
    if (token.startsWith("-") && token !== "-") {
      for (const flag of token.slice(1)) {
        if (!SHORT_COLUMN_FLAGS.has(flag)) {
          return null;
        }
        columns.add(flag);
      }
      continue;
    }
    operands.push(token);
  }
  return {
    defaultColumns: columns.size === 0,
    operands,
    columns: columns.size === 0 ? 3 : columns.size,
  };
}

function parseWcRow(line: string, columns: number): WcRow | null {
  const countGroups = Array.from({ length: columns }, () => "(\\d+)").join("\\s+");
  const match = new RegExp(`^\\s*${countGroups}(?:\\s+(.*))?$`, "u").exec(line);
  if (match === null) {
    return null;
  }
  const counts = match.slice(1, columns + 1);
  if (counts.some((count) => count === undefined)) {
    return null;
  }
  return {
    counts: counts.filter((count): count is string => count !== undefined),
    label: match[columns + 1] ?? null,
  };
}

function rowsMatchOperands(rows: readonly WcRow[], operands: readonly string[]): boolean {
  if (operands.length === 0) {
    return rows.length === 1 && rows[0]?.label === null;
  }
  if (operands.length === 1) {
    const label = rows[0]?.label;
    return rows.length === 1 && (label === operands[0] || (operands[0] === "-" && label === null));
  }
  if (rows.length !== operands.length + 1) {
    return false;
  }
  for (const [index, operand] of operands.entries()) {
    if (rows[index]?.label !== operand) {
      return false;
    }
  }
  return rows.at(-1)?.label === "total";
}

function formatCounts(counts: readonly string[], defaultColumns: boolean): string {
  if (defaultColumns && counts.length === 3) {
    return `${counts[0]}L ${counts[1]}W ${counts[2]}B`;
  }
  return counts.join(" ");
}

function baseName(path: string): string {
  return path.replaceAll("\\", "/").split("/").at(-1) ?? path;
}
