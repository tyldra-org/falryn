/** Shared helpers for complete, model-readable build projections. */

export function buildLines(text: string): readonly string[] {
  return text
    .split("\n")
    .map((line) => line.replace(/\r$/u, "").trimEnd())
    .filter((line) => line.trim().length > 0);
}

export function compactDuration(value: string | undefined): string {
  return (value ?? "").replace(/\s+/gu, "");
}

export function compactSize(value: string | undefined): string {
  return (value ?? "").replace(/\s+/gu, "");
}

export function unique(values: readonly string[]): readonly string[] {
  return [...new Set(values)];
}

export function countedList(label: string, values: readonly string[]): string {
  return `${label} ${values.length}: ${values.join(", ")}`;
}
