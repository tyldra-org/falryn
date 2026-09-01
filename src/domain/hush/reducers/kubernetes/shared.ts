/** Shared complete-line helpers for Kubernetes projections. */

export function kubernetesLines(text: string): readonly string[] {
  const lines = text.split("\n").map((line) => line.replace(/\r$/u, "").trimEnd());
  if (lines.at(-1) === "") lines.pop();
  return lines;
}
