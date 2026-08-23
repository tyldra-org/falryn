export function pathFromDiffGit(rest: string): string | null {
  if (rest.includes('"')) {
    return null;
  }
  const parts = rest.trim().split(/\s+/u);
  const left = parts[0];
  const right = parts[1];
  if (left === undefined || right === undefined || parts.length !== 2) {
    return null;
  }
  const from = stripDiffPrefix(left);
  const to = stripDiffPrefix(right);
  return from === to ? from : `${from} → ${to}`;
}

function stripDiffPrefix(value: string): string {
  return value.startsWith("a/") || value.startsWith("b/") ? value.slice(2) : value;
}
