/**
 * Deterministic commit planning over Git status (#80).
 *
 * Produces advice only: cohesive groups, drafted subjects, a validation
 * summary, and provenance. It never stages, commits, or otherwise mutates Git.
 */

import {
  COMMIT_PLAN_SOURCE,
  COMMIT_PLAN_VERSION,
  type CommitChangeUnit,
  type CommitGroup,
  type CommitPlan,
  type GitIdentity,
  type GitStatusEntry,
  isSecretPath,
  MAX_COMMIT_PLAN_GROUPS,
} from "./git.ts";

const CONVENTIONAL_SUBJECT =
  /^(feat|fix|docs|test|chore|build|ci|refactor|perf|style)(\([^)]+\))?: /;
const TEST_SUFFIX = /\.(?:test|spec)\.(?:tsx|ts|jsx|js)$/;
const LOCKFILE_NAMES = new Set([
  "bun.lock",
  "bun.lockb",
  "package-lock.json",
  "yarn.lock",
  "pnpm-lock.yaml",
]);

export function planGitCommits(input: {
  readonly identity: GitIdentity;
  readonly entries: readonly GitStatusEntry[];
  readonly truncated: boolean;
  readonly subjects: readonly string[];
}): CommitPlan {
  const inventory = input.entries.filter((entry) => entry.kind !== "ignored").map(toChangeUnit);
  const unassigned: CommitPlan["unassigned"][number][] = [];
  const assignable: CommitChangeUnit[] = [];
  let conflictCount = 0;
  let secretPathCount = 0;
  for (const unit of inventory) {
    if (unit.kind === "unmerged") {
      conflictCount += 1;
      unassigned.push({ path: unit.path, reason: "conflict" });
      continue;
    }
    if (isSecretPath(unit.path)) {
      secretPathCount += 1;
      unassigned.push({ path: unit.path, reason: "secret-path" });
      continue;
    }
    assignable.push(unit);
  }
  const conventional = usesConventional(input.subjects);
  const clustered = clusterUnits(assignable, conventional);
  const overflow = clustered.slice(MAX_COMMIT_PLAN_GROUPS);
  const groups = clustered.slice(0, MAX_COMMIT_PLAN_GROUPS);
  for (const group of overflow) {
    for (const path of group.paths) {
      unassigned.push({ path, reason: "truncated" });
    }
  }
  const truncated = input.truncated || overflow.length > 0;
  const head = input.identity.head.state === "observed" ? input.identity.head.value : null;
  return {
    inventory,
    groups,
    unassigned,
    validation: {
      groupCount: groups.length,
      unassignedCount: unassigned.length,
      conflictCount,
      secretPathCount,
      truncated,
      detached: input.identity.headState === "detached",
    },
    provenance: {
      version: COMMIT_PLAN_VERSION,
      source: COMMIT_PLAN_SOURCE,
      model: null,
      head,
      truncated,
    },
  };
}

function toChangeUnit(entry: GitStatusEntry): CommitChangeUnit {
  const states: CommitChangeUnit["states"][number][] = [];
  if (entry.kind === "untracked") {
    states.push("untracked");
  } else {
    if (entry.indexStatus !== "." && entry.indexStatus !== " " && entry.indexStatus !== "?") {
      states.push("staged");
    }
    if (entry.worktreeStatus !== "." && entry.worktreeStatus !== " ") {
      states.push("unstaged");
    }
  }
  return {
    path: entry.path,
    originalPath: entry.originalPath,
    kind: entry.kind,
    states,
  };
}

function clusterUnits(units: readonly CommitChangeUnit[], conventional: boolean): CommitGroup[] {
  const remaining = new Map(units.map((unit) => [unit.path, unit]));
  const groups: CommitGroup[] = [];
  const take = (paths: readonly string[], reason: string): void => {
    const members = paths.flatMap((path) => {
      const unit = remaining.get(path);
      if (unit === undefined) {
        return [];
      }
      remaining.delete(path);
      return [unit];
    });
    if (members.length === 0) {
      return;
    }
    groups.push(makeGroup(groups.length + 1, members, reason, conventional));
  };

  for (const unit of units) {
    if (!remaining.has(unit.path)) {
      continue;
    }
    const partner = findTestPartner(unit, remaining);
    if (partner !== null) {
      const implementation = isTestPath(unit.path) ? partner : unit;
      const test = implementation === unit ? partner : unit;
      take([implementation.path, test.path], "source-and-test");
    }
  }
  for (const unit of units) {
    if (!remaining.has(unit.path)) {
      continue;
    }
    const key = packageKey(unit.path);
    if (key === null) {
      continue;
    }
    const related = [...remaining.values()]
      .filter((candidate) => packageKey(candidate.path) === key)
      .map((candidate) => candidate.path)
      .sort();
    if (related.length > 1) {
      take(related, "package-and-lockfile");
    }
  }
  const byParent = new Map<string, string[]>();
  for (const unit of remaining.values()) {
    const parent = dirname(unit.path);
    const bucket = byParent.get(parent) ?? [];
    bucket.push(unit.path);
    byParent.set(parent, bucket);
  }
  for (const [parent, paths] of [...byParent.entries()].sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    if (paths.length < 2 || parent === ".") {
      continue;
    }
    take([...paths].sort(), "same-directory");
  }
  for (const unit of [...remaining.values()].sort((left, right) =>
    left.path.localeCompare(right.path),
  )) {
    take([unit.path], "single-change");
  }
  return groups.sort(compareGroups);
}

function findTestPartner(
  unit: CommitChangeUnit,
  remaining: ReadonlyMap<string, CommitChangeUnit>,
): CommitChangeUnit | null {
  const key = implementationKey(unit.path);
  for (const candidate of remaining.values()) {
    if (candidate.path === unit.path) {
      continue;
    }
    if (implementationKey(candidate.path) !== key) {
      continue;
    }
    if (isTestPath(unit.path) !== isTestPath(candidate.path)) {
      return candidate;
    }
  }
  return null;
}

function makeGroup(
  index: number,
  members: readonly CommitChangeUnit[],
  reason: string,
  conventional: boolean,
): CommitGroup {
  return {
    id: `group-${index}`,
    paths: members.map((member) => member.path),
    reason,
    subject: draftSubject(members, conventional),
  };
}

function draftSubject(members: readonly CommitChangeUnit[], conventional: boolean): string {
  const type = inferType(members);
  const scope = inferScope(members);
  const summary = inferSummary(members);
  const drafted = conventional
    ? scope === null
      ? `${type}: ${summary}`
      : `${type}(${scope}): ${summary}`
    : summary;
  return drafted.length <= 72 ? drafted : drafted.slice(0, 72);
}

function inferType(members: readonly CommitChangeUnit[]): string {
  if (members.every((member) => isPackagePath(member.path))) {
    return "build";
  }
  if (members.every((member) => isDocPath(member.path))) {
    return "docs";
  }
  if (members.every((member) => isTestPath(member.path))) {
    return "test";
  }
  return "feat";
}

function inferScope(members: readonly CommitChangeUnit[]): string | null {
  const segments = members.map((member) => member.path.split("/")[0] ?? "");
  const first = segments[0];
  if (
    first !== undefined &&
    first.length > 0 &&
    !first.includes(".") &&
    segments.every((segment) => segment === first)
  ) {
    return first;
  }
  return null;
}

function inferSummary(members: readonly CommitChangeUnit[]): string {
  const adding = members.every((member) => member.states.includes("untracked"));
  const verb = adding ? "add" : "update";
  if (members.length === 1) {
    const path = members[0]?.path ?? "files";
    return `${verb} ${stem(isTestPath(path) ? implementationKey(path) : path)}`;
  }
  const implementation = members.find((member) => !isTestPath(member.path));
  if (implementation !== undefined && members.some((member) => isTestPath(member.path))) {
    return `${verb} ${stem(implementation.path)}`;
  }
  if (members.every((member) => isPackagePath(member.path))) {
    return `${verb} package lockfile`;
  }
  const parent = dirname(members[0]?.path ?? "files");
  return `${verb} ${parent === "." ? "files" : basename(parent)}`;
}

function compareGroups(left: CommitGroup, right: CommitGroup): number {
  const rank = (group: CommitGroup): number => {
    if (group.reason === "package-and-lockfile") {
      return 0;
    }
    if (group.subject.startsWith("docs")) {
      return 2;
    }
    return 1;
  };
  const delta = rank(left) - rank(right);
  return delta !== 0 ? delta : (left.paths[0]?.localeCompare(right.paths[0] ?? "") ?? 0);
}

function usesConventional(subjects: readonly string[]): boolean {
  if (subjects.length === 0) {
    return true;
  }
  const hits = subjects.filter((subject) => CONVENTIONAL_SUBJECT.test(subject)).length;
  return hits * 2 >= subjects.length;
}

function implementationKey(path: string): string {
  return path.replace(TEST_SUFFIX, (match) => {
    const extension = match.slice(match.lastIndexOf("."));
    return extension;
  });
}

function isTestPath(path: string): boolean {
  return TEST_SUFFIX.test(path);
}

function isDocPath(path: string): boolean {
  return path.endsWith(".md");
}

function isPackagePath(path: string): boolean {
  return packageKey(path) !== null;
}

function packageKey(path: string): string | null {
  const name = basename(path);
  if (name === "package.json" || LOCKFILE_NAMES.has(name)) {
    return `${dirname(path)}/package`;
  }
  return null;
}

function basename(path: string): string {
  const parts = path.split("/");
  return parts[parts.length - 1] ?? path;
}

function dirname(path: string): string {
  const index = path.lastIndexOf("/");
  return index === -1 ? "." : path.slice(0, index);
}

function stem(path: string): string {
  return basename(path).replace(/\.[^.]+$/, "");
}
