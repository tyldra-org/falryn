import { canonicalDigest } from "../../domain/extensions/canonical.ts";
import {
  type WorkspaceTrustReport,
  type WorkspaceTrustReview,
  type WorkspaceTrustStore,
  workspaceDecisionKey,
} from "../../domain/security/workspace-trust.ts";
import type {
  WorkspaceInventoryPort,
  WorkspaceInventorySnapshot,
} from "./workspace-trust-inventory.ts";

export type WorkspaceTrust = {
  resolve(review?: WorkspaceTrustReview, signal?: AbortSignal): Promise<WorkspaceTrustReport>;
  /** Revalidates the whole inventory and returns only committed, generation-pinned configuration. */
  project(
    signal?: AbortSignal,
  ): Promise<{ readonly text: string | null; readonly report: WorkspaceTrustReport }>;
  current(): WorkspaceTrustReport;
};
export function createWorkspaceTrust(options: {
  readonly inventory: WorkspaceInventoryPort;
  readonly store: WorkspaceTrustStore;
  readonly actor: string;
  readonly now: () => number;
}): WorkspaceTrust {
  let report: WorkspaceTrustReport = {
    version: 1,
    status: "review-required",
    inventory: null,
    priorGeneration: null,
    reason: "workspace-trust-required",
    added: 0,
    removed: 0,
    changed: 0,
  };
  let refused = false;
  let admitted: string | null = null;
  let active: Promise<WorkspaceTrustReport> | null = null;
  const currentReport = () => report;
  const fail = (reason: string): WorkspaceTrustReport => {
    admitted = null;
    report = { ...report, status: reason === "cancelled" ? "refused" : "failed", reason };
    return report;
  };
  async function inspect(
    signal?: AbortSignal,
  ): Promise<{ snapshot: WorkspaceInventorySnapshot; revision: number } | null> {
    const read = await options.inventory.inspect(signal);
    if (!read.ok) {
      fail(read.error.code);
      return null;
    }
    const snapshot = read.value;
    if (snapshot.report.loaders.length === 0) {
      report = {
        version: 1,
        status: refused ? "refused" : "empty",
        inventory: snapshot.report,
        priorGeneration: null,
        reason: refused ? "project-loaders-disabled" : "no-project-loaders",
        added: 0,
        changed: 0,
        removed: 0,
      };
      return { snapshot, revision: 0 };
    }
    const key = workspaceDecisionKey(snapshot.report.identity, options.actor);
    const saved = await options.store.get(key);
    if (!saved.ok) {
      fail(`trust-store-${saved.error.code}`);
      return null;
    }
    const previous = saved.value;
    const old = new Map(
      previous?.inventory.loaders.map((entry) => [entry.source, canonicalDigest(entry)]) ?? [],
    );
    const next = new Map(
      snapshot.report.loaders.map((entry) => [entry.source, canonicalDigest(entry)]),
    );
    const matching =
      previous !== null &&
      previous.actor === options.actor &&
      previous.decidedAt <= options.now() &&
      canonicalDigest(previous.inventory) === canonicalDigest(snapshot.report);
    report = {
      version: 1,
      status: refused
        ? "refused"
        : matching
          ? "accepted"
          : previous === null
            ? "review-required"
            : "stale",
      inventory: snapshot.report,
      priorGeneration: previous?.inventory.generation ?? null,
      reason: refused
        ? "project-loaders-disabled"
        : matching
          ? "recorded-decision-matched"
          : previous === null
            ? "workspace-trust-required"
            : "inventory-generation-changed",
      added: [...next.keys()].filter((key) => !old.has(key)).length,
      removed: [...old.keys()].filter((key) => !next.has(key)).length,
      changed: [...next].filter(([key, digest]) => old.has(key) && old.get(key) !== digest).length,
    };
    return { snapshot, revision: previous?.revision ?? 0 };
  }
  async function resolve(
    review?: WorkspaceTrustReview,
    signal?: AbortSignal,
  ): Promise<WorkspaceTrustReport> {
    const initial = await inspect(signal);
    if (initial === null || refused) return report;
    if (report.status === "accepted" || report.status === "empty") {
      admitted = initial.snapshot.report.generation;
      return report;
    }
    if (review === undefined) return report;
    let choice: "proceed" | "refuse";
    try {
      choice = await review(report, signal);
    } catch {
      choice = "refuse";
    }
    if (choice === "refuse" || signal?.aborted) {
      refused = true;
      admitted = null;
      report = {
        ...report,
        status: "refused",
        reason: signal?.aborted ? "cancelled" : "project-loaders-disabled",
      };
      return report;
    }
    const current = await inspect(signal);
    if (current === null) return report;
    if (
      canonicalDigest(initial.snapshot.report) !== canonicalDigest(current.snapshot.report) ||
      initial.revision !== current.revision
    ) {
      report = { ...report, status: "stale", reason: "inventory-changed-during-review" };
      return report;
    }
    const written = await options.store.replace(
      workspaceDecisionKey(current.snapshot.report.identity, options.actor),
      current.revision,
      {
        version: 1,
        actor: options.actor,
        inventory: current.snapshot.report,
        revision: current.revision + 1,
        decidedAt: options.now(),
      },
      signal,
    );
    if (!written.ok) return fail(`trust-store-${written.error.code}`);
    const committed = await inspect(signal);
    if (committed === null || currentReport().status !== "accepted") return report;
    admitted = committed.snapshot.report.generation;
    return report;
  }
  return {
    current: () => report,
    resolve(review, signal) {
      if (active !== null) return active;
      active = resolve(review, signal).finally(() => {
        active = null;
      });
      return active;
    },
    async project(signal) {
      if (refused) return { text: null, report };
      const result = await inspect(signal);
      if (result === null) return { text: null, report };
      if (admitted !== null && admitted !== result.snapshot.report.generation) {
        admitted = null;
        report = { ...report, status: "stale", reason: "inventory-generation-changed" };
      }
      const allowed =
        report.status === "accepted" && admitted === result.snapshot.report.generation;
      return { text: allowed ? result.snapshot.projectText : null, report };
    },
  };
}
