/**
 * Render-safe Git changes dashboard (#268).
 *
 * Groups status entries and lists worktrees and checkpoints. No GitPort here.
 */

import type {
  GitCheckpointRecord,
  GitIdentity,
  GitStatusEntry,
  GitWorktreeRecord,
} from "../../domain/index.ts";

export type ChangesDashboardInput = {
  readonly identity: GitIdentity;
  readonly entries: readonly GitStatusEntry[];
  readonly entriesNote: string | null;
  readonly worktrees: readonly GitWorktreeRecord[];
  readonly worktreesNote: string | null;
  readonly checkpoints: readonly GitCheckpointRecord[];
  readonly checkpointsNote: string | null;
};

export const CHANGES_TABS = ["files", "worktrees", "checkpoints"] as const;
export type ChangesTab = (typeof CHANGES_TABS)[number];

export const CHANGE_BUCKETS = ["conflict", "staged", "unstaged", "untracked", "ignored"] as const;
export type ChangeBucket = (typeof CHANGE_BUCKETS)[number];

export type ChangeRow = {
  readonly bucket: ChangeBucket;
  readonly path: string;
  readonly originalPath: string | null;
  readonly indexStatus: string;
  readonly worktreeStatus: string;
};

export type WorktreeRow = {
  readonly path: string;
  readonly branch: string;
  readonly flags: string;
};

export type CheckpointRow = {
  readonly id: string;
  readonly label: string;
  readonly truncated: boolean;
  readonly excludedUntracked: number;
};

export type ChangesDashboardModel = {
  readonly worktreeRoot: string;
  readonly branch: string;
  readonly operation: string;
  readonly groups: readonly {
    readonly bucket: ChangeBucket;
    readonly rows: readonly ChangeRow[];
  }[];
  readonly entriesNote: string | null;
  readonly worktrees: readonly WorktreeRow[];
  readonly worktreesNote: string | null;
  readonly checkpoints: readonly CheckpointRow[];
  readonly checkpointsNote: string | null;
};

export function changesDashboardFrom(snapshot: ChangesDashboardInput): ChangesDashboardModel {
  return {
    worktreeRoot: snapshot.identity.worktreeRoot,
    branch: branchLabel(snapshot.identity),
    operation: snapshot.identity.operation,
    groups: grouped(snapshot.entries),
    entriesNote: snapshot.entriesNote,
    worktrees: snapshot.worktrees.map(worktreeRow),
    worktreesNote: snapshot.worktreesNote,
    checkpoints: snapshot.checkpoints.map(checkpointRow),
    checkpointsNote: snapshot.checkpointsNote,
  };
}

export function rowsForTab(model: ChangesDashboardModel, tab: ChangesTab): readonly string[] {
  switch (tab) {
    case "files":
      return model.groups.flatMap((group) =>
        group.rows.map((row) => `${group.bucket} ${row.path}`),
      );
    case "worktrees":
      return model.worktrees.map((row) => `${row.branch} ${row.path}`);
    case "checkpoints":
      return model.checkpoints.map((row) => row.label);
    default: {
      const exhaustive: never = tab;
      return exhaustive;
    }
  }
}

function grouped(entries: readonly GitStatusEntry[]): ChangesDashboardModel["groups"] {
  const buckets: Record<ChangeBucket, ChangeRow[]> = {
    conflict: [],
    staged: [],
    unstaged: [],
    untracked: [],
    ignored: [],
  };
  for (const entry of entries) {
    for (const bucket of bucketsOf(entry)) {
      buckets[bucket].push({
        bucket,
        path: entry.path,
        originalPath: entry.originalPath,
        indexStatus: entry.indexStatus,
        worktreeStatus: entry.worktreeStatus,
      });
    }
  }
  return CHANGE_BUCKETS.filter((bucket) => buckets[bucket].length > 0).map((bucket) => ({
    bucket,
    rows: buckets[bucket],
  }));
}

function bucketsOf(entry: GitStatusEntry): readonly ChangeBucket[] {
  if (entry.kind === "unmerged") {
    return ["conflict"];
  }
  if (entry.kind === "ignored") {
    return ["ignored"];
  }
  if (entry.kind === "untracked") {
    return ["untracked"];
  }
  const buckets: ChangeBucket[] = [];
  if (isDirty(entry.indexStatus)) {
    buckets.push("staged");
  }
  if (isDirty(entry.worktreeStatus)) {
    buckets.push("unstaged");
  }
  return buckets;
}

function isDirty(status: string): boolean {
  return status !== "." && status !== " " && status !== "?" && status !== "";
}

function worktreeRow(record: GitWorktreeRecord): WorktreeRow {
  const flags = [
    record.detached ? "detached" : null,
    record.locked ? "locked" : null,
    record.prunable ? "prunable" : null,
  ].filter((flag): flag is string => flag !== null);
  return {
    path: record.path,
    branch: record.branch.state === "observed" ? record.branch.value : "detached",
    flags: flags.length === 0 ? "clean" : flags.join(" "),
  };
}

function checkpointRow(record: GitCheckpointRecord): CheckpointRow {
  const short = record.id.length > 12 ? record.id.slice(0, 12) : record.id;
  const branch = record.branch ?? record.headState;
  return {
    id: record.id,
    label: `${short} ${branch}`,
    truncated: record.truncated,
    excludedUntracked: record.excludedUntracked,
  };
}

function branchLabel(identity: GitIdentity): string {
  if (identity.branch.state === "observed") {
    return identity.branch.value;
  }
  return identity.headState;
}
