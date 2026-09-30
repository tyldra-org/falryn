import { z } from "zod";
import { canonicalDigest, freezeMetadata } from "../../domain/extensions/canonical.ts";
import { digestSchema } from "../../domain/extensions/identity.ts";
import type { Result } from "../../domain/foundation/result.ts";
import {
  deriveEcosystemNotices,
  NOTICE_LIMITS,
  type NoticeAcknowledgement,
  type NoticeAcknowledgementStore,
  type NoticeHealthObservation,
  noticeAcknowledgementKey,
  type PresentedNotice,
  presentNotice,
} from "../../domain/security/ecosystem-notice.ts";
import {
  evaluateTrust,
  type TrustDecisionStore,
  type TrustObservation,
  trustDecisionKey,
} from "../../domain/security/ecosystem-trust.ts";
import {
  type PackageProvenanceStore,
  packageProvenanceKey,
  withPackageProvenance,
} from "../../domain/security/package-provenance.ts";
import type { PreparedPackage } from "./prepare-package.ts";

export const noticeRequestSchema = z.strictObject({
  action: z.literal("acknowledge"),
  noticeId: digestSchema,
  expiresAt: z.int().nonnegative(),
  confirmation: digestSchema.optional(),
});
export type NoticeRequest = z.infer<typeof noticeRequestSchema>;

export interface NoticeHealthSource {
  /** Newest completed health attempt for this installed identity. Health owns the record. */
  latest(
    packageId: string,
    identityDigest: string,
  ): Result<
    {
      readonly result: {
        readonly state: string;
        readonly code: string;
        readonly binding: { readonly generation: string; readonly contribution: string };
      };
    } | null,
    { readonly code: string }
  >;
}
export type PackageNoticeOwners = {
  readonly decisions: TrustDecisionStore;
  readonly provenance: PackageProvenanceStore;
  readonly acknowledgements: NoticeAcknowledgementStore;
  readonly health: NoticeHealthSource;
};
export type PackageNoticesResult =
  | { readonly status: "failed"; readonly code: string }
  | {
      readonly status: "listed" | "preview" | "applied";
      readonly notices: readonly PresentedNotice[];
      /** Notices whose presentation an acknowledgement currently hides. */
      readonly suppressed: number;
      readonly confirmation: string | null;
      readonly observedAt: number;
    };

/**
 * Derive notices from the facts the invocation gateway uses, then join the stored
 * acknowledgements. Nothing here writes trust, provenance or health, and an acknowledgement
 * never changes what a notice says about eligibility.
 */
export function inspectPackageNotices(
  owners: PackageNoticeOwners,
  prepared: PreparedPackage,
  observation: TrustObservation,
  request?: NoticeRequest,
  signal?: AbortSignal,
): PackageNoticesResult {
  if (signal?.aborted) return { status: "failed", code: "cancelled" };
  if (request !== undefined && !noticeRequestSchema.safeParse(request).success)
    return { status: "failed", code: "malformed" };
  const facts = owners.provenance.get(packageProvenanceKey(observation));
  if (!facts.ok) return { status: "failed", code: facts.error.code };
  const current = withPackageProvenance(observation, facts.value);
  const decision = owners.decisions.get(
    trustDecisionKey(current.subject, current.scope, current.actor),
  );
  if (!decision.ok) return { status: "failed", code: decision.error.code };
  const latest = owners.health.latest(prepared.identity.packageId, prepared.identityDigest);
  if (!latest.ok) return { status: "failed", code: latest.error.code };
  const health: NoticeHealthObservation | null =
    latest.value === null
      ? null
      : {
          state: latest.value.result.state,
          code: latest.value.result.code,
          generation: latest.value.result.binding.generation,
          contribution: latest.value.result.binding.contribution,
        };
  const notices = deriveEcosystemNotices({
    subject: {
      packageId: prepared.identity.packageId,
      packageVersion: prepared.identity.packageVersion,
      identityDigest: prepared.identityDigest,
      packageDigest: prepared.identity.packageDigest,
    },
    trust: evaluateTrust(current, decision.value),
    advisory:
      facts.value === null
        ? null
        : {
            sequence: facts.value.advisorySequence,
            ids: facts.value.advisoryIds,
            verified: facts.value.advisoryDigest !== null,
          },
    dependencies: prepared.dependencies.ok
      ? {
          status: "resolved",
          degraded: prepared.dependencies.degraded.length > 0,
          digest: prepared.dependencies.digest,
        }
      : { status: "unresolved", code: prepared.dependencies.code },
    health,
    now: current.now,
  });
  const stored = new Map<string, NoticeAcknowledgement | null>();
  for (const notice of notices) {
    const read = owners.acknowledgements.get(noticeAcknowledgementKey(notice.id, current.scope));
    if (!read.ok) return { status: "failed", code: read.error.code };
    stored.set(notice.id, read.value);
  }
  const present = (): readonly PresentedNotice[] =>
    notices.map((notice) => presentNotice(notice, stored.get(notice.id) ?? null, current.now));
  const listing = (status: "listed" | "preview" | "applied", confirmation: string | null) =>
    freezeMetadata({
      status,
      notices: present(),
      suppressed: present().filter((entry) => entry.presentation === "suppressed").length,
      confirmation,
      observedAt: current.now,
    });
  if (request === undefined) return listing("listed", null);

  if (!notices.some((notice) => notice.id === request.noticeId))
    return { status: "failed", code: "notice-not-found" };
  if (
    request.expiresAt <= current.now ||
    request.expiresAt - current.now > NOTICE_LIMITS.acknowledgementMs
  )
    return { status: "failed", code: "invalid-acknowledgement-expiry" };
  const prior = stored.get(request.noticeId) ?? null;
  const key = noticeAcknowledgementKey(request.noticeId, current.scope);
  const confirmation = canonicalDigest({
    version: 1,
    action: "acknowledge",
    key,
    revision: prior?.revision ?? 0,
    expiresAt: request.expiresAt,
  });
  if (request.confirmation === undefined) return listing("preview", confirmation);
  if (request.confirmation !== confirmation)
    return { status: "failed", code: "stale-notice-confirmation" };
  const record: NoticeAcknowledgement = {
    version: 1,
    noticeId: request.noticeId,
    scope: current.scope,
    revision: (prior?.revision ?? 0) + 1,
    acknowledgedAt: current.now,
    expiresAt: request.expiresAt,
  };
  const written = owners.acknowledgements.replace(key, prior?.revision ?? 0, record, signal);
  if (!written.ok) return { status: "failed", code: written.error.code };
  stored.set(request.noticeId, record);
  return listing("applied", null);
}
