/**
 * Prepare evidence-bound text replacements (#996). Resolves each machine-issued evidence
 * reference through the shared resource owner, enforces the requested freshness mode,
 * lowers exact replacements to native patch hunks and previews them through the native
 * patcher. Preparation never writes: the returned patch is applied unchanged through the
 * existing apply operation, whose plan identity and digests refuse any intervening change.
 */

import type { LocalPath } from "../../domain/workspace/index.ts";
import {
  coveredRangesUnchanged,
  lowerTextReplacements,
  TEXT_REPLACEMENT_LIMITS,
  type TextReplacementError,
  textReplacementsInputSchema,
} from "../../domain/workspace/text-replacements.ts";
import {
  describeWorkspacePatchError,
  type WorkspacePatchPreview,
} from "../../domain/workspace/workspace-patch.ts";
import type { ResolvedResourceEvidence, ResourceResolver } from "../documents/resource-resolver.ts";
import type { WorkspacePatcher } from "./workspace-patch.ts";

/** What the model should do next; every refusal has exactly one. */
export type TextReplacementRecovery =
  | "fix-request"
  | "read-again"
  | "read-more"
  | "narrow-old-text"
  | "split-request"
  | "use-write-files"
  | "retry";

export type TextReplacementRefusal = {
  readonly code: string;
  readonly itemId: string | null;
  readonly recovery: TextReplacementRecovery;
};

type Evidence = "reused" | "refreshed";
export type TextReplacementPreparation = {
  readonly version: 1;
  readonly freshness: "exact-revision" | "covered-ranges";
  readonly targets: readonly {
    readonly itemId: string;
    readonly path: string;
    /** reused: the evidence still describes the file; refreshed: covered ranges re-verified. */
    readonly evidence: Evidence;
    readonly scope: "complete-file" | "covered-ranges";
    readonly replacements: readonly {
      readonly itemId: string;
      readonly matches: number;
      readonly lines: readonly { readonly start: number; readonly end: number }[];
    }[];
    readonly hunkIds: readonly string[];
  }[];
  readonly dependencies: readonly {
    readonly itemId: string;
    readonly path: string;
    readonly evidence: Evidence;
  }[];
  /** A native patch plan bound to the previewed bytes; apply it unchanged. */
  readonly patch: {
    readonly expectedPlanId: string;
    readonly targets: readonly {
      readonly path: string;
      readonly expectedDigest: string;
      readonly hunks: readonly {
        readonly hunkId: string;
        readonly oldStart: number;
        readonly oldLines: readonly string[];
        readonly newLines: readonly string[];
      }[];
    }[];
    readonly dependencies: readonly { readonly path: string; readonly expectedDigest: string }[];
  };
  readonly preview: WorkspacePatchPreview;
};

export type TextReplacementPreparer = {
  prepare(
    input: unknown,
    signal: AbortSignal,
  ): Promise<
    | { readonly ok: true; readonly value: TextReplacementPreparation }
    | { readonly ok: false; readonly error: TextReplacementRefusal }
  >;
};

const refuse = (code: string, itemId: string | null, recovery: TextReplacementRecovery) =>
  ({ ok: false, error: { code, itemId, recovery } }) as const;

function recoveryFor(error: TextReplacementError): TextReplacementRecovery {
  switch (error.code) {
    case "match-outside-evidence":
    case "replace-all-needs-complete-evidence":
      return "read-more";
    case "ambiguous-match":
      return "narrow-old-text";
    case "replacement-limit":
      return "split-request";
    case "unsupported-fidelity":
    case "unrepresentable-replacement":
      return "use-write-files";
    default:
      return "fix-request";
  }
}

/** One model-readable line: code, the request item and the one recovery action. */
export function describeTextReplacementRefusal(refusal: TextReplacementRefusal): string {
  return `${refusal.code}${refusal.itemId === null ? "" : ` item=${refusal.itemId}`} recovery=${refusal.recovery}`;
}

export function createTextReplacementPreparer(ports: {
  readonly resources: ResourceResolver;
  readonly patcher: WorkspacePatcher;
  readonly root: LocalPath;
}): TextReplacementPreparer {
  return {
    async prepare(input, signal) {
      const parsed = textReplacementsInputSchema.safeParse(input);
      if (!parsed.success) {
        const issue = parsed.error.issues[0];
        const message = issue?.message ?? "";
        return refuse(
          /^[a-z]+(?:-[a-z]+)+$/u.test(message) ? message : "malformed-input",
          null,
          "fix-request",
        );
      }
      const request = parsed.data;
      const cancelled = () => refuse("cancelled", null, "retry");

      // Resolve every reference before any matching; each one is revalidated live.
      const resolved = new Map<string, ResolvedResourceEvidence>();
      const identities = new Map<string, string>();
      for (const item of [...request.targets, ...request.dependencies]) {
        if (signal.aborted) return cancelled();
        const found = await ports.resources.resolveEvidence(item.evidenceRef, signal);
        if (!found.ok)
          return signal.aborted ? cancelled() : refuse(found.error.code, item.itemId, "read-again");
        const { evidence } = found.value;
        if (evidence.target.kind !== "workspace" || found.value.current === null)
          return refuse("unsupported-target-kind", item.itemId, "fix-request");
        if (evidence.fidelity !== "exact")
          return refuse("evidence-not-exact", item.itemId, "read-again");
        const seen = identities.get(evidence.sourceIdentity);
        if (seen !== undefined) return refuse("duplicate-target", item.itemId, "fix-request");
        identities.set(evidence.sourceIdentity, item.itemId);
        resolved.set(item.itemId, found.value);
      }

      /** The bytes preparation may rely on, or why the evidence is no longer usable. */
      const fresh = (itemId: string) => {
        const found = resolved.get(itemId);
        if (found === undefined || found.current === null) return null;
        if (found.currentness === "current")
          return {
            bytes: found.retained,
            digest: found.evidence.digest,
            evidence: "reused" as const,
          };
        if (
          request.freshness === "covered-ranges" &&
          coveredRangesUnchanged(found.retained, found.current.bytes, found.evidence.coverage)
        )
          return {
            bytes: found.current.bytes,
            digest: found.current.digest,
            evidence: "refreshed" as const,
          };
        return null;
      };

      const targets: TextReplacementPreparation["targets"][number][] = [];
      const plan: TextReplacementPreparation["patch"]["targets"][number][] = [];
      let hunkCount = 0;
      for (const target of request.targets) {
        const found = resolved.get(target.itemId);
        const bytes = fresh(target.itemId);
        if (found === undefined || bytes === null)
          return refuse(
            request.freshness === "covered-ranges" ? "covered-range-changed" : "evidence-stale",
            target.itemId,
            "read-again",
          );
        const lowered = lowerTextReplacements(
          bytes.bytes,
          found.evidence.coverage,
          target.replacements,
        );
        if (!lowered.ok)
          return refuse(
            lowered.error.code,
            "itemId" in lowered.error ? lowered.error.itemId : target.itemId,
            recoveryFor(lowered.error),
          );
        hunkCount += lowered.value.hunks.length;
        if (hunkCount > TEXT_REPLACEMENT_LIMITS.hunks)
          return refuse("replacement-limit", target.itemId, "split-request");
        const path = found.evidence.target.kind === "workspace" ? found.evidence.target.path : "";
        targets.push({
          itemId: target.itemId,
          path,
          evidence: bytes.evidence,
          scope: lowered.value.scope,
          replacements: lowered.value.items,
          hunkIds: lowered.value.hunks.map((hunk) => hunk.hunkId),
        });
        plan.push({ path, expectedDigest: bytes.digest, hunks: lowered.value.hunks });
      }
      const dependencies: TextReplacementPreparation["dependencies"][number][] = [];
      const preconditions: { path: string; expectedDigest: string }[] = [];
      for (const dependency of request.dependencies) {
        const found = resolved.get(dependency.itemId);
        const bytes = fresh(dependency.itemId);
        if (found === undefined || bytes === null || found.current === null)
          return refuse("dependency-changed", dependency.itemId, "read-again");
        const path = found.evidence.target.kind === "workspace" ? found.evidence.target.path : "";
        dependencies.push({ itemId: dependency.itemId, path, evidence: bytes.evidence });
        // Apply rechecks the live file; the plan relies on the bytes it has now.
        preconditions.push({ path, expectedDigest: found.current.digest });
      }
      if (signal.aborted) return cancelled();

      const nativePlan = {
        targets: plan,
        ...(preconditions.length === 0 ? {} : { dependencies: preconditions }),
      };
      const preview = await ports.patcher.preview(ports.root, nativePlan, signal);
      if (!preview.ok)
        return signal.aborted
          ? cancelled()
          : refuse(describeWorkspacePatchError(preview.error), null, "read-again");
      const conflicted = preview.value.targets.findIndex(
        (item) => item.hunks.length === 0 || item.hunks.some((hunk) => hunk.status !== "ready"),
      );
      if (conflicted >= 0)
        return refuse(
          "preview-conflict",
          request.targets[conflicted]?.itemId ?? null,
          "read-again",
        );
      return {
        ok: true,
        value: {
          version: 1,
          freshness: request.freshness,
          targets,
          dependencies,
          patch: {
            expectedPlanId: preview.value.planId,
            targets: plan,
            dependencies: preconditions,
          },
          preview: preview.value,
        },
      };
    },
  };
}
