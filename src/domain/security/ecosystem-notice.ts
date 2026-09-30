/**
 * Notices explain ecosystem trust, compatibility and health facts. They are derived from the
 * same projection that decides invocation eligibility and never grant, deny or clear anything.
 * Only an acknowledgement is stored, and it hides a presentation, not the underlying denial.
 */
import { z } from "zod";
import { canonicalDigest } from "../extensions/canonical.ts";
import { digestSchema, identityText } from "../extensions/identity.ts";
import type { Result } from "../foundation/result.ts";
import {
  type TrustProjection,
  type TrustStoreError,
  trustEvidenceBinding,
  trustScopeSchema,
} from "./ecosystem-trust.ts";

export const ECOSYSTEM_TRUST_REASONS = [
  "ecosystem-trust-required",
  "ecosystem-trust-revoked",
  "ecosystem-trust-quarantined",
  "ecosystem-trust-incompatible",
  "ecosystem-trust-stale",
  "ecosystem-trust-expired",
  "ecosystem-trust-changed",
  "ecosystem-grant-required",
] as const;
export type EcosystemTrustReason = (typeof ECOSYSTEM_TRUST_REASONS)[number];

/**
 * The one reason discovery, diagnostics and attempted invocation report for an ecosystem
 * contribution. A missing projection denies, so absent trust facts read as required approval.
 */
export function ecosystemTrustReason(trust: TrustProjection | null): EcosystemTrustReason | null {
  if (trust === null) return "ecosystem-trust-required";
  if (trust.eligible) return null;
  if (trust.state === "revoked") return "ecosystem-trust-revoked";
  if (trust.state === "quarantined") return "ecosystem-trust-quarantined";
  if (trust.state === "incompatible") return "ecosystem-trust-incompatible";
  if (trust.freshness === "stale") return "ecosystem-trust-stale";
  if (trust.decisionStatus === "expired") return "ecosystem-trust-expired";
  if (trust.decisionStatus === "stale") return "ecosystem-trust-changed";
  if (trust.state === "user-approved") return "ecosystem-grant-required";
  return "ecosystem-trust-required";
}

export const NOTICE_LIMITS = {
  perPackage: 32,
  advisoryIds: 32,
  remediation: 3,
  acknowledgementMs: 30 * 24 * 60 * 60 * 1_000,
  acknowledgementBytes: 4_096,
  records: 1_024,
} as const;

export const NOTICE_CODES = [
  "advisory-revoked",
  "advisory-quarantined",
  "advisory-unverified",
  "integrity-mismatch",
  "signature-invalid",
  "signature-conflicting",
  "evidence-stale",
  "approval-expired",
  "approval-changed",
  "host-incompatible",
  "dependencies-unresolved",
  "dependencies-degraded",
  "health-failed",
  "health-uncertain",
] as const;
export type NoticeCode = (typeof NOTICE_CODES)[number];
export const NOTICE_KINDS = ["advisory", "trust", "compatibility", "dependency", "health"] as const;
export const NOTICE_STATES = [
  "unavailable",
  "degraded",
  "incompatible",
  "quarantined",
  "revoked",
  "failed",
] as const;
export const NOTICE_ACTIONS = [
  "refresh-evidence",
  "reapprove",
  "update-package",
  "rollback-package",
  "recover-health",
  "inspect",
] as const;
export type NoticeAction = (typeof NOTICE_ACTIONS)[number];

type NoticeShape = {
  readonly kind: (typeof NOTICE_KINDS)[number];
  readonly state: (typeof NOTICE_STATES)[number];
  readonly action: NoticeAction;
  readonly remediation: readonly NoticeAction[];
};
const NOTICE_SHAPES = {
  "advisory-revoked": {
    kind: "advisory",
    state: "revoked",
    action: "update-package",
    remediation: ["update-package", "rollback-package"],
  },
  "advisory-quarantined": {
    kind: "advisory",
    state: "quarantined",
    action: "inspect",
    remediation: ["inspect", "rollback-package"],
  },
  "advisory-unverified": {
    kind: "advisory",
    state: "quarantined",
    action: "refresh-evidence",
    remediation: ["refresh-evidence", "rollback-package"],
  },
  "integrity-mismatch": {
    kind: "trust",
    state: "quarantined",
    action: "refresh-evidence",
    remediation: ["refresh-evidence", "rollback-package"],
  },
  "signature-invalid": {
    kind: "trust",
    state: "quarantined",
    action: "refresh-evidence",
    remediation: ["refresh-evidence", "rollback-package"],
  },
  "signature-conflicting": {
    kind: "trust",
    state: "quarantined",
    action: "refresh-evidence",
    remediation: ["refresh-evidence", "rollback-package"],
  },
  "evidence-stale": {
    kind: "trust",
    state: "degraded",
    action: "refresh-evidence",
    remediation: ["refresh-evidence"],
  },
  "approval-expired": {
    kind: "trust",
    state: "degraded",
    action: "reapprove",
    remediation: ["reapprove"],
  },
  "approval-changed": {
    kind: "trust",
    state: "degraded",
    action: "reapprove",
    remediation: ["reapprove", "rollback-package"],
  },
  "host-incompatible": {
    kind: "compatibility",
    state: "incompatible",
    action: "update-package",
    remediation: ["update-package", "rollback-package"],
  },
  "dependencies-unresolved": {
    kind: "dependency",
    state: "unavailable",
    action: "inspect",
    remediation: ["inspect"],
  },
  "dependencies-degraded": {
    kind: "dependency",
    state: "degraded",
    action: "inspect",
    remediation: ["inspect"],
  },
  "health-failed": {
    kind: "health",
    state: "failed",
    action: "recover-health",
    remediation: ["recover-health", "rollback-package"],
  },
  "health-uncertain": {
    kind: "health",
    state: "degraded",
    action: "recover-health",
    remediation: ["recover-health"],
  },
} as const satisfies Record<NoticeCode, NoticeShape>;

const time = z.int().nonnegative();
export const noticeSubjectSchema = z.strictObject({
  packageId: identityText,
  packageVersion: identityText.nullable(),
  identityDigest: digestSchema,
  packageDigest: digestSchema,
});
/** Bounded closed facts only. Signatures, keys, paths and catalog display text never appear. */
export const noticeEvidenceSchema = z.strictObject({
  basis: z.enum(["trust", "compatibility", "dependencies", "health"]),
  reference: digestSchema,
  integrity: z.enum(["unknown", "computed", "verified", "mismatch"]).nullable(),
  signature: z.enum(["unavailable", "unsigned", "verified", "invalid", "conflicting"]).nullable(),
  advisory: z.enum(["unavailable", "clear", "quarantined", "revoked"]).nullable(),
  advisorySequence: z.int().nonnegative().nullable(),
  advisoryIds: z.array(identityText).max(NOTICE_LIMITS.advisoryIds),
  healthState: identityText.nullable(),
  healthGeneration: digestSchema.nullable(),
});
export const noticeFreshnessSchema = z.strictObject({
  status: z.enum(["current", "stale", "unavailable", "unrecorded"]),
  observedAt: time.nullable(),
  expiresAt: time.nullable(),
});
export const ecosystemNoticeSchema = z.strictObject({
  version: z.literal(1),
  id: digestSchema,
  subject: noticeSubjectSchema,
  kind: z.enum(NOTICE_KINDS),
  code: z.enum(NOTICE_CODES),
  state: z.enum(NOTICE_STATES),
  severity: z.enum(["blocking", "warning"]),
  /** `invocation-denied` states what the shared eligibility decision does, not what an ack does. */
  impact: z.enum(["invocation-denied", "reported-only"]),
  reason: z.enum(ECOSYSTEM_TRUST_REASONS).nullable(),
  requiredAction: z.enum(NOTICE_ACTIONS),
  remediation: z
    .array(z.strictObject({ kind: z.enum(NOTICE_ACTIONS), handle: identityText }))
    .max(NOTICE_LIMITS.remediation),
  evidence: noticeEvidenceSchema,
  freshness: noticeFreshnessSchema,
});
export type EcosystemNotice = z.infer<typeof ecosystemNoticeSchema>;
export type NoticeSubject = z.infer<typeof noticeSubjectSchema>;

/** Terminal package-health facts. `attempt` and timing never enter notice identity. */
export type NoticeHealthObservation = {
  readonly state: string;
  readonly code: string;
  readonly generation: string;
  readonly contribution: string;
};
export type NoticeDependencies =
  | { readonly status: "resolved"; readonly degraded: boolean; readonly digest: string }
  | { readonly status: "unresolved"; readonly code: string };
export type NoticeAdvisoryFacts = {
  readonly sequence: number;
  readonly ids: readonly string[];
  readonly verified: boolean;
};
export type NoticeInput = {
  readonly subject: NoticeSubject;
  readonly trust: TrustProjection;
  readonly advisory: NoticeAdvisoryFacts | null;
  readonly dependencies: NoticeDependencies;
  readonly health: NoticeHealthObservation | null;
  readonly now: number;
};

function trustEvidence(
  trust: TrustProjection,
  advisory: NoticeAdvisoryFacts | null,
): EcosystemNotice["evidence"] {
  return {
    basis: "trust",
    reference: trust.evidence.reference,
    integrity: trust.evidence.integrity,
    signature: trust.evidence.signature,
    advisory: trust.evidence.advisory,
    advisorySequence: advisory?.sequence ?? null,
    advisoryIds: [...(advisory?.ids ?? [])].sort().slice(0, NOTICE_LIMITS.advisoryIds),
    healthState: null,
    healthGeneration: null,
  };
}
function blankEvidence(
  basis: EcosystemNotice["evidence"]["basis"],
  reference: string,
): EcosystemNotice["evidence"] {
  return {
    basis,
    reference,
    integrity: null,
    signature: null,
    advisory: null,
    advisorySequence: null,
    advisoryIds: [],
    healthState: null,
    healthGeneration: null,
  };
}

/** A malformed upstream digest must not crash a read; it falls back to the package identity. */
function digestOr(value: string, fallback: string): string {
  return digestSchema.safeParse(value).success ? value : fallback;
}

function trustFreshness(trust: TrustProjection): EcosystemNotice["freshness"] {
  return {
    status: trust.freshness,
    observedAt: trust.evidence.observedAt,
    expiresAt: trust.evidence.expiresAt,
  };
}

/** Timestamps and attempt identities are excluded so one cause keeps one identity. */
function noticeIdentity(subject: NoticeSubject, code: NoticeCode, binding: unknown): string {
  return canonicalDigest({ version: 1, subject: subject.identityDigest, code, binding });
}

function build(
  input: NoticeInput,
  code: NoticeCode,
  binding: unknown,
  evidence: EcosystemNotice["evidence"],
  freshness: EcosystemNotice["freshness"],
): EcosystemNotice {
  const shape = NOTICE_SHAPES[code];
  const denied = shape.kind !== "dependency" && shape.kind !== "health" && !input.trust.eligible;
  const id = noticeIdentity(input.subject, code, binding);
  return {
    version: 1,
    id,
    subject: input.subject,
    kind: shape.kind,
    code,
    state: shape.state,
    severity: denied ? "blocking" : "warning",
    impact: denied ? "invocation-denied" : "reported-only",
    reason: denied ? ecosystemTrustReason(input.trust) : null,
    requiredAction: shape.action,
    remediation: shape.remediation.map((kind) => ({
      kind,
      handle: `package:${kind}:${input.subject.identityDigest}`,
    })),
    evidence,
    freshness,
  };
}

/**
 * Every notice the current facts justify, deduplicated by identity and ordered
 * deterministically. A package with no cause yields none: an unapproved package is a normal
 * state, not a notice.
 */
export function deriveEcosystemNotices(input: NoticeInput): readonly EcosystemNotice[] {
  const { trust, advisory } = input;
  const evidence = trustEvidence(trust, advisory);
  const freshness = trustFreshness(trust);
  const found = new Map<string, EcosystemNotice>();
  const add = (notice: EcosystemNotice) => {
    if (!found.has(notice.id)) found.set(notice.id, notice);
  };
  const advisoryBinding = {
    status: trust.evidence.advisory,
    sequence: advisory?.sequence ?? 0,
    ids: [...(advisory?.ids ?? [])].sort(),
    reference: trust.evidence.reference,
  };
  if (trust.evidence.advisory === "revoked")
    add(build(input, "advisory-revoked", advisoryBinding, evidence, freshness));
  else if (trust.evidence.advisory === "quarantined")
    add(
      build(
        input,
        advisory?.verified === false || advisory === null
          ? "advisory-unverified"
          : "advisory-quarantined",
        advisoryBinding,
        evidence,
        freshness,
      ),
    );
  if (trust.evidence.integrity === "mismatch")
    add(
      build(
        input,
        "integrity-mismatch",
        { reference: trust.evidence.reference },
        evidence,
        freshness,
      ),
    );
  if (trust.evidence.signature === "invalid")
    add(
      build(
        input,
        "signature-invalid",
        { reference: trust.evidence.reference },
        evidence,
        freshness,
      ),
    );
  if (trust.evidence.signature === "conflicting")
    add(
      build(
        input,
        "signature-conflicting",
        { reference: trust.evidence.reference },
        evidence,
        freshness,
      ),
    );
  if (trust.freshness === "stale")
    add(
      build(input, "evidence-stale", { reference: trust.evidence.reference }, evidence, freshness),
    );
  if (trust.decisionStatus === "expired" && trust.decision !== null)
    add(
      build(
        input,
        "approval-expired",
        {
          revision: trust.decision.revision,
          binding: trustEvidenceBinding(trust.decision.evidence),
        },
        evidence,
        freshness,
      ),
    );
  if (trust.decisionStatus === "stale" && trust.decision !== null)
    add(
      build(
        input,
        "approval-changed",
        {
          revision: trust.decision.revision,
          approved: trustEvidenceBinding(trust.decision.evidence),
          current: trustEvidenceBinding(trust.evidence),
          policy: trust.policyGeneration,
        },
        evidence,
        freshness,
      ),
    );
  if (trust.compatibility === "incompatible")
    add(
      build(
        input,
        "host-incompatible",
        { identity: input.subject.identityDigest },
        blankEvidence("compatibility", input.subject.identityDigest),
        { status: "current", observedAt: input.now, expiresAt: null },
      ),
    );
  const dependencies = input.dependencies;
  if (dependencies.status === "unresolved")
    add(
      build(
        input,
        "dependencies-unresolved",
        { code: dependencies.code },
        blankEvidence("dependencies", input.subject.identityDigest),
        { status: "current", observedAt: input.now, expiresAt: null },
      ),
    );
  else if (dependencies.degraded)
    add(
      build(
        input,
        "dependencies-degraded",
        { digest: dependencies.digest },
        blankEvidence("dependencies", digestOr(dependencies.digest, input.subject.identityDigest)),
        { status: "current", observedAt: input.now, expiresAt: null },
      ),
    );
  const health = input.health;
  if (health !== null && (health.state === "failed" || health.state === "uncertain")) {
    add(
      build(
        input,
        health.state === "failed" ? "health-failed" : "health-uncertain",
        { generation: health.generation, contribution: health.contribution, code: health.code },
        {
          ...blankEvidence("health", digestOr(health.contribution, input.subject.identityDigest)),
          healthState: health.state,
          healthGeneration: digestSchema.safeParse(health.generation).success
            ? health.generation
            : null,
        },
        { status: "unrecorded", observedAt: null, expiresAt: null },
      ),
    );
  }
  return Object.freeze(
    [...found.values()]
      .sort(
        (left, right) =>
          Number(right.severity === "blocking") - Number(left.severity === "blocking") ||
          NOTICE_CODES.indexOf(left.code) - NOTICE_CODES.indexOf(right.code) ||
          (left.id < right.id ? -1 : left.id > right.id ? 1 : 0),
      )
      .slice(0, NOTICE_LIMITS.perPackage),
  );
}

export const noticeAcknowledgementSchema = z
  .strictObject({
    version: z.literal(1),
    noticeId: digestSchema,
    scope: trustScopeSchema,
    revision: z.int().positive(),
    acknowledgedAt: time,
    expiresAt: time,
  })
  .refine(
    (value) =>
      value.expiresAt > value.acknowledgedAt &&
      value.expiresAt - value.acknowledgedAt <= NOTICE_LIMITS.acknowledgementMs,
  );
export type NoticeAcknowledgement = z.infer<typeof noticeAcknowledgementSchema>;
export type NoticeStoreError = TrustStoreError | { readonly code: "limit" };
export interface NoticeAcknowledgementStore {
  get(key: string): Result<NoticeAcknowledgement | null, NoticeStoreError>;
  /** Compare and replace under one durable transaction. */
  replace(
    key: string,
    expectedRevision: number,
    record: NoticeAcknowledgement,
    signal?: AbortSignal,
  ): Result<null, NoticeStoreError>;
}
export function noticeAcknowledgementKey(
  noticeId: string,
  scope: NoticeAcknowledgement["scope"],
): string {
  return canonicalDigest({ noticeId, scope });
}

export type NoticeAcknowledgementView =
  | { readonly status: "unacknowledged" }
  | { readonly status: "acknowledged"; readonly acknowledgedAt: number; readonly expiresAt: number }
  | { readonly status: "expired"; readonly acknowledgedAt: number; readonly expiresAt: number };
export type PresentedNotice = {
  readonly notice: EcosystemNotice;
  readonly acknowledgement: NoticeAcknowledgementView;
  /** Suppression is presentation only. `notice.impact` still states the shared decision. */
  readonly presentation: "shown" | "suppressed";
};
export function presentNotice(
  notice: EcosystemNotice,
  record: NoticeAcknowledgement | null,
  now: number,
): PresentedNotice {
  if (record === null || record.noticeId !== notice.id)
    return { notice, acknowledgement: { status: "unacknowledged" }, presentation: "shown" };
  const live = record.acknowledgedAt <= now && now < record.expiresAt;
  return {
    notice,
    acknowledgement: {
      status: live ? "acknowledged" : "expired",
      acknowledgedAt: record.acknowledgedAt,
      expiresAt: record.expiresAt,
    },
    presentation: live ? "suppressed" : "shown",
  };
}
