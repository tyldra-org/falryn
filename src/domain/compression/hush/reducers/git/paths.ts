export type GitDiffPaths = Readonly<{
  before: string;
  after: string;
  beforeHeader: string;
  afterHeader: string;
}>;

export function pathsFromDiffGit(rest: string): GitDiffPaths | null {
  if (rest.includes('"')) {
    return null;
  }
  const parts = rest.trim().split(/\s+/u);
  const left = parts[0];
  const right = parts[1];
  if (left === undefined || right === undefined || parts.length !== 2) {
    return null;
  }
  return {
    before: stripDiffPrefix(left),
    after: stripDiffPrefix(right),
    beforeHeader: left,
    afterHeader: right,
  };
}

export function pathFromDiffGit(rest: string): string | null {
  const paths = pathsFromDiffGit(rest);
  if (paths === null) {
    return null;
  }
  return paths.before === paths.after ? paths.before : `${paths.before} → ${paths.after}`;
}

function stripDiffPrefix(value: string): string {
  return value.startsWith("a/") || value.startsWith("b/") ? value.slice(2) : value;
}
