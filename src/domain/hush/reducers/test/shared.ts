/** Shared primitives for complete, uncapped test-runner projections. */

export type TestLineTransform = (
  line: string,
) => Readonly<{ kind: "drop" | "keep" | "replace"; text?: string }>;

export function projectTestLines(text: string, transform: TestLineTransform): string | null {
  const output: string[] = [];
  let recognized = false;

  for (const sourceLine of text.split("\n")) {
    const line = sourceLine.replace(/\r$/u, "").trimEnd();
    if (line.trim().length === 0) {
      continue;
    }
    const action = transform(line);
    switch (action.kind) {
      case "drop":
        recognized = true;
        break;
      case "replace":
        recognized = true;
        if (action.text !== undefined && action.text.length > 0) {
          output.push(action.text);
        }
        break;
      case "keep":
        output.push(line);
        break;
    }
  }

  return recognized ? output.join("\n") : null;
}

export function drop(): ReturnType<TestLineTransform> {
  return { kind: "drop" };
}

export function keep(): ReturnType<TestLineTransform> {
  return { kind: "keep" };
}

export function replace(text: string): ReturnType<TestLineTransform> {
  return { kind: "replace", text };
}

export function countSummary(
  passed: string,
  failed?: string,
  skipped?: string,
  duration?: string,
): string {
  const parts = [`${passed} passed`];
  if (failed !== undefined && failed !== "0") {
    parts.push(`${failed} failed`);
  }
  if (skipped !== undefined && skipped !== "0") {
    parts.push(`${skipped} skipped`);
  }
  if (duration !== undefined && duration.length > 0) {
    parts.push(normalizeDuration(duration));
  }
  return parts.join(" ");
}

function normalizeDuration(duration: string): string {
  return duration
    .trim()
    .replace(/\s*(?:milliseconds?|msecs?)$/iu, "ms")
    .replace(/\s*(?:seconds?|secs?)$/iu, "s")
    .replace(/\s+/gu, "");
}

export function executable(tokens: readonly string[]): string {
  return tokens[0] ?? "";
}
