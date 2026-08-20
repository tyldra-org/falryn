/**
 * Test Git dashboard port. Not product surface.
 */

import type { GitDashboard, GitDashboardSnapshot } from "../../application/index.ts";
import {
  type GitCheckpointRecord,
  type GitIdentity,
  instant,
  localPath,
  ok,
} from "../../domain/index.ts";

export function fixtureGitIdentity(): GitIdentity {
  return {
    worktreeRoot: localPath("/work/falryn"),
    gitDir: ".git",
    commonDir: ".git",
    head: { state: "observed", value: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" },
    headState: "branch",
    branch: { state: "observed", value: "feat/268-git-dashboard" },
    upstream: { state: "unavailable", reason: "none" },
    ahead: { state: "unavailable", reason: "none" },
    behind: { state: "unavailable", reason: "none" },
    operation: "clean",
    superproject: { state: "unavailable", reason: "no-superproject" },
    sparseCheckout: { state: "observed", value: false },
    gitVersion: { state: "observed", value: "2.45.0" },
    remotes: { state: "observed", value: [] },
    observedAt: instant(0),
  };
}

export function fixtureCheckpoint(
  id = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
): GitCheckpointRecord {
  return {
    id,
    head: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    headState: "branch",
    branch: "feat/268-git-dashboard",
    indexTree: "cccccccccccccccccccccccccccccccccccccccc",
    worktreeTree: "dddddddddddddddddddddddddddddddddddddddd",
    includedUntracked: [],
    excludedUntracked: 0,
    truncated: false,
    sessionId: null,
    turnId: null,
  };
}

export function createFixedGitDashboard(
  snapshot: GitDashboardSnapshot,
  options: {
    readonly onCreate?: () => void;
  } = {},
): GitDashboard {
  const checkpoints = [...snapshot.checkpoints];
  return {
    async snapshot() {
      return ok({ ...snapshot, checkpoints: [...checkpoints] });
    },
    async createCheckpoint() {
      options.onCreate?.();
      const checkpoint = fixtureCheckpoint("eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee");
      checkpoints.push(checkpoint);
      return ok({ identity: snapshot.identity, checkpoint });
    },
    async restoreCheckpoint(checkpointId) {
      const checkpoint =
        checkpoints.find((entry) => entry.id === checkpointId) ?? fixtureCheckpoint(checkpointId);
      return ok({
        identity: snapshot.identity,
        checkpoint,
        restoredIndex: true,
        restoredWorktree: [],
        restoredUntracked: [],
      });
    },
  };
}
