import { afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { createPackageHealthRepository } from "../../data/extensions/package-health-repository.ts";
import {
  openProductStoreOrThrow,
  removeTemporaryRoots,
  temporaryRoot,
} from "../../data/fixtures.ts";
import { createNoticeAcknowledgementRepository } from "../../data/security/notice-repository.ts";
import { createPackageProvenanceRepository } from "../../data/security/provenance-repository.ts";
import { createTrustDecisionRepository } from "../../data/security/trust-repository.ts";
import { canonicalDigest } from "../../domain/extensions/canonical.ts";
import {
  initialHealthResult,
  PACKAGE_HEALTH_PROTOCOL,
  type PackageHealthStore,
} from "../../domain/extensions/package-health.ts";
import {
  ecosystemTrustReason,
  noticeAcknowledgementKey,
} from "../../domain/security/ecosystem-notice.ts";
import type { TrustObservation } from "../../domain/security/ecosystem-trust.ts";
import type { SqliteStorePort } from "../../domain/storage/index.ts";
import { ed25519PackageVerifier } from "../../integrations/extensions/package-signature.ts";
import { createCapabilityTrust } from "./capability-trust.ts";
import { inspectionHost, packageSource, pluginManifest } from "./package-fixtures.ts";
import { inspectPackageNotices, type NoticeRequest } from "./package-notices.ts";
import { packageNoticeLines } from "./package-notices-report.ts";
import { inspectProvenanceTrust } from "./package-provenance.ts";
import { packageTrustObservation, type TrustRequest } from "./package-trust.ts";
import { type PreparedPackage, preparePackage } from "./prepare-package.ts";
import { signedVerification } from "./provenance-fixtures.ts";

afterEach(removeTemporaryRoots);

const actor = canonicalDigest("actor");
const DAY = 86_400_000;

async function prepared(host = inspectionHost, compatibility: unknown = { bun: ">=1.4.0" }) {
  const result = await preparePackage(
    packageSource(pluginManifest({ version: 1, compatibility })),
    host,
  );
  if (!result.ok) throw new Error(result.code);
  return result.package;
}

function owners(store: SqliteStorePort) {
  return {
    decisions: createTrustDecisionRepository(store),
    provenance: createPackageProvenanceRepository(store),
    acknowledgements: createNoticeAcknowledgementRepository(store),
    health: createPackageHealthRepository(store),
  };
}

/** The trust owner's own preview then confirm flow, exactly as `extension trust` drives it. */
function decide(
  store: SqliteStorePort,
  observation: TrustObservation,
  affected: readonly string[],
  request: TrustRequest,
) {
  const { decisions, provenance } = owners(store);
  const run = (next: TrustRequest) =>
    inspectProvenanceTrust(
      { decisions, provenance, verifier: ed25519PackageVerifier },
      observation,
      affected,
      next,
    );
  const preview = run(request);
  if (preview.status !== "preview" || preview.confirmation === null)
    throw new Error(`preview: ${JSON.stringify(preview)}`);
  const applied = run({ ...request, confirmation: preview.confirmation });
  if (applied.status !== "applied") throw new Error(`apply: ${JSON.stringify(applied)}`);
}
function acknowledge(
  store: SqliteStorePort,
  pkg: PreparedPackage,
  observation: TrustObservation,
  request: NoticeRequest,
) {
  const preview = inspectPackageNotices(owners(store), pkg, observation, request);
  if (preview.status !== "preview" || preview.confirmation === null)
    throw new Error(`preview: ${JSON.stringify(preview)}`);
  return inspectPackageNotices(owners(store), pkg, observation, {
    ...request,
    confirmation: preview.confirmation,
  });
}
function list(
  store: SqliteStorePort,
  pkg: PreparedPackage,
  observation: TrustObservation,
  at = observation.now,
) {
  const result = inspectPackageNotices(owners(store), pkg, { ...observation, now: at });
  if (result.status !== "listed") throw new Error(JSON.stringify(result));
  return result;
}
const codes = (result: { notices: readonly { notice: { code: string } }[] }) =>
  result.notices.map((entry) => entry.notice.code);
/** What the invocation gateway consults for this package. */
function gatewayTrust(store: SqliteStorePort, observation: TrustObservation, at: number) {
  const { decisions, provenance } = owners(store);
  return createCapabilityTrust(decisions, () => ({ ...observation, now: at }), provenance).inspect(
    "extension:fixture@1",
  );
}
function seedHealth(
  store: PackageHealthStore,
  pkg: PreparedPackage,
  state: "failed" | "healthy" | "uncertain",
  options: { generation?: string; contribution?: string; pending?: boolean } = {},
) {
  const binding = {
    protocol: PACKAGE_HEALTH_PROTOCOL,
    attempt: randomUUID(),
    package: pkg.identityDigest,
    contribution: options.contribution ?? canonicalDigest("contribution"),
    generation: options.generation ?? canonicalDigest("generation"),
  } as const;
  const base = {
    operation: randomUUID(),
    packageId: pkg.identity.packageId,
    fingerprint: canonicalDigest("fingerprint"),
    birth: null,
    directory: null,
  };
  const started = store.save({ ...base, revision: 1, result: initialHealthResult(binding) }, 0);
  if (!started.ok) throw new Error(started.error.code);
  // An uncertain outcome that may still be running stays unterminated and needs recovery.
  const done = store.save(
    {
      ...base,
      revision: 2,
      result: {
        ...initialHealthResult(binding),
        state,
        code: `health-${state}`,
        terminated: options.pending !== true,
        cleanup: options.pending === true ? "unknown" : "removed",
      },
    },
    1,
  );
  if (!done.ok) throw new Error(done.error.code);
}

describe("the advisory journey on a real, reopened store", () => {
  test("arrival, acknowledgement without permission, restart, withdrawal and recovery to ready", async () => {
    const root = await temporaryRoot("falryn-notices-journey-");
    const pkg = await prepared();
    const observation = packageTrustObservation(pkg, actor, 1_000);
    const affected = pkg.contributions.map((entry) => entry.identityDigest);
    let store = await openProductStoreOrThrow(root);
    try {
      const approve = () =>
        decide(store, observation, affected, { action: "approve", expiresAt: 1_000 + 5 * DAY });
      const refresh = (sequence: number, status: "clear" | "revoked") =>
        decide(store, observation, affected, {
          action: "refresh",
          expiresAt: null,
          verification: signedVerification(observation, { sequence, status }),
        });
      // Signed clear evidence, then a fresh approval bound to it.
      refresh(1, "clear");
      approve();
      expect(gatewayTrust(store, observation, 1_000)?.eligible).toBe(true);
      expect(codes(list(store, pkg, observation))).toEqual([]);

      // A signed advisory with a higher sequence arrives through the evidence owner.
      refresh(2, "revoked");
      const arrived = list(store, pkg, observation);
      expect(codes(arrived)).toEqual(["advisory-revoked", "approval-changed"]);
      const revoked = arrived.notices[0]?.notice;
      if (revoked === undefined) throw new Error("notice");
      expect(revoked).toMatchObject({
        severity: "blocking",
        impact: "invocation-denied",
        reason: "ecosystem-trust-revoked",
        requiredAction: "update-package",
        evidence: { advisory: "revoked", advisorySequence: 2 },
      });
      // The gateway, discovery and the notice read one reason from one projection.
      const projection = gatewayTrust(store, observation, 1_000);
      expect(projection?.eligible).toBe(false);
      expect(ecosystemTrustReason(projection ?? null)).toBe(revoked.reason);

      // Acknowledging hides the presentation. It is not permission and changes no eligibility.
      const request = {
        action: "acknowledge" as const,
        noticeId: revoked.id,
        expiresAt: 1_000 + DAY,
      };
      const acknowledged = acknowledge(store, pkg, observation, request);
      if (acknowledged.status !== "applied") throw new Error(JSON.stringify(acknowledged));
      expect(acknowledged.suppressed).toBe(1);
      expect(acknowledged.notices[0]).toMatchObject({
        presentation: "suppressed",
        notice: { impact: "invocation-denied", reason: "ecosystem-trust-revoked" },
      });
      expect(acknowledged.notices[1]?.presentation).toBe("shown");
      expect(gatewayTrust(store, observation, 1_000)?.eligible).toBe(false);
      expect(ecosystemTrustReason(gatewayTrust(store, observation, 1_000))).toBe(
        "ecosystem-trust-revoked",
      );
      const ids = arrived.notices.map((entry) => entry.notice.id);

      // Restart: the same causes keep their identities and the acknowledgement survives.
      await store.close();
      store = await openProductStoreOrThrow(root);
      const restarted = list(store, pkg, observation);
      expect(restarted.notices.map((entry) => entry.notice.id)).toEqual(ids);
      expect(restarted.notices.map((entry) => entry.presentation)).toEqual(["suppressed", "shown"]);

      // A higher-sequence clear withdraws the advisory. The old approval no longer matches
      // the evidence, so recovery to ready still needs a fresh approval.
      refresh(3, "clear");
      const withdrawn = list(store, pkg, observation);
      expect(codes(withdrawn)).toEqual(["approval-changed"]);
      expect(withdrawn.notices[0]?.notice.reason).toBe("ecosystem-trust-changed");
      expect(withdrawn.notices[0]?.notice.id).not.toBe(ids[1]);
      expect(ecosystemTrustReason(gatewayTrust(store, observation, 1_000))).toBe(
        "ecosystem-trust-changed",
      );
      approve();
      expect(codes(list(store, pkg, observation))).toEqual([]);
      expect(gatewayTrust(store, observation, 1_000)?.eligible).toBe(true);
    } finally {
      await store.close();
    }
  }, 30_000); // Drives real signature verification and durable SQLite writes across a reopen.

  test("a newer advisory is a new notice: an earlier acknowledgement does not carry over", async () => {
    const root = await temporaryRoot("falryn-notices-sequence-");
    const pkg = await prepared();
    const observation = packageTrustObservation(pkg, actor, 1_000);
    const store = await openProductStoreOrThrow(root);
    try {
      decide(store, observation, [], {
        action: "refresh",
        expiresAt: null,
        verification: signedVerification(observation, { sequence: 1, status: "quarantined" }),
      });
      const first = list(store, pkg, observation).notices[0]?.notice;
      if (first === undefined) throw new Error("notice");
      expect(first).toMatchObject({ code: "advisory-quarantined", state: "quarantined" });
      acknowledge(store, pkg, observation, {
        action: "acknowledge",
        noticeId: first.id,
        expiresAt: 1_000 + DAY,
      });
      expect(list(store, pkg, observation).notices[0]?.presentation).toBe("suppressed");
      decide(store, observation, [], {
        action: "refresh",
        expiresAt: null,
        verification: signedVerification(observation, { sequence: 2, status: "quarantined" }),
      });
      const next = list(store, pkg, observation).notices[0];
      expect(next?.notice.id).not.toBe(first.id);
      expect(next?.presentation).toBe("shown");
    } finally {
      await store.close();
    }
  });
});

describe("freshness, health and compatibility", () => {
  test("stale offline evidence names its own action and deduplicates across reads", async () => {
    const root = await temporaryRoot("falryn-notices-stale-");
    const pkg = await prepared();
    const observation = packageTrustObservation(pkg, actor, 1_000);
    const affected = pkg.contributions.map((entry) => entry.identityDigest);
    const store = await openProductStoreOrThrow(root);
    try {
      decide(store, observation, affected, {
        action: "refresh",
        expiresAt: null,
        verification: signedVerification(observation, { sequence: 1, status: "clear" }),
      });
      decide(store, observation, affected, { action: "approve", expiresAt: 1_000 + 5 * DAY });
      expect(codes(list(store, pkg, observation, 1_000))).toEqual([]);
      const later = list(store, pkg, observation, 1_000 + 120_000);
      expect(later.notices.map((entry) => entry.notice)).toMatchObject([
        {
          code: "evidence-stale",
          state: "degraded",
          reason: "ecosystem-trust-stale",
          requiredAction: "refresh-evidence",
          freshness: { status: "stale" },
        },
      ]);
      const again = list(store, pkg, observation, 1_000 + 130_000);
      expect(again.notices.map((entry) => entry.notice.id)).toEqual(
        later.notices.map((entry) => entry.notice.id),
      );
      expect(ecosystemTrustReason(gatewayTrust(store, observation, 1_000 + 120_000))).toBe(
        "ecosystem-trust-stale",
      );
    } finally {
      await store.close();
    }
  });

  test("flapping health keeps one notice identity per cause and clears on recovery", async () => {
    const root = await temporaryRoot("falryn-notices-health-");
    const pkg = await prepared();
    const observation = packageTrustObservation(pkg, actor, 1_000);
    const store = await openProductStoreOrThrow(root);
    try {
      const health = createPackageHealthRepository(store);
      expect(codes(list(store, pkg, observation))).toEqual([]);
      seedHealth(health, pkg, "failed");
      const failed = list(store, pkg, observation).notices[0];
      expect(failed?.notice).toMatchObject({
        code: "health-failed",
        state: "failed",
        impact: "reported-only",
        requiredAction: "recover-health",
        reason: null,
      });
      seedHealth(health, pkg, "healthy");
      expect(codes(list(store, pkg, observation))).toEqual([]);
      seedHealth(health, pkg, "failed");
      expect(list(store, pkg, observation).notices[0]?.notice.id).toBe(failed?.notice.id);
      seedHealth(health, pkg, "failed", { generation: canonicalDigest("later generation") });
      expect(list(store, pkg, observation).notices[0]?.notice.id).not.toBe(failed?.notice.id);
      seedHealth(health, pkg, "uncertain");
      expect(list(store, pkg, observation).notices[0]?.notice.code).toBe("health-uncertain");
    } finally {
      await store.close();
    }
  });

  test("an unterminated uncertain attempt is reported: it blocks the next attempt until recovery", async () => {
    const root = await temporaryRoot("falryn-notices-uncertain-");
    const pkg = await prepared();
    const observation = packageTrustObservation(pkg, actor, 1_000);
    const store = await openProductStoreOrThrow(root);
    try {
      seedHealth(createPackageHealthRepository(store), pkg, "uncertain", { pending: true });
      const notice = list(store, pkg, observation).notices[0]?.notice;
      expect(notice).toMatchObject({
        code: "health-uncertain",
        state: "degraded",
        requiredAction: "recover-health",
        evidence: { healthState: "uncertain" },
      });
    } finally {
      await store.close();
    }
  });

  test("health is judged per contribution: a healthy sibling does not hide a failure", async () => {
    const root = await temporaryRoot("falryn-notices-contributions-");
    const pkg = await prepared();
    const observation = packageTrustObservation(pkg, actor, 1_000);
    const store = await openProductStoreOrThrow(root);
    try {
      const health = createPackageHealthRepository(store);
      const first = canonicalDigest("contribution a");
      const second = canonicalDigest("contribution b");
      seedHealth(health, pkg, "failed", { contribution: first });
      seedHealth(health, pkg, "healthy", { contribution: second });
      const failing = list(store, pkg, observation).notices;
      expect(failing.map((entry) => entry.notice.code)).toEqual(["health-failed"]);
      expect(failing[0]?.notice.evidence.reference).toBe(first);
      seedHealth(health, pkg, "healthy", { contribution: first });
      expect(codes(list(store, pkg, observation))).toEqual([]);
    } finally {
      await store.close();
    }
  });

  test("health recorded for another installed identity is not this package's notice", async () => {
    const root = await temporaryRoot("falryn-notices-identity-");
    const pkg = await prepared();
    const other = await preparePackage(
      packageSource(pluginManifest({ version: 1 }), { "extra.txt": "different bytes" }),
      inspectionHost,
    );
    if (!other.ok) throw new Error(other.code);
    const observation = packageTrustObservation(pkg, actor, 1_000);
    const store = await openProductStoreOrThrow(root);
    try {
      seedHealth(createPackageHealthRepository(store), other.package, "failed");
      expect(codes(list(store, pkg, observation))).toEqual([]);
    } finally {
      await store.close();
    }
  });

  test("a host or version change makes the same package incompatible, blocking and recoverable", async () => {
    const root = await temporaryRoot("falryn-notices-host-");
    const store = await openProductStoreOrThrow(root);
    try {
      const compatible = await prepared();
      const observation = packageTrustObservation(compatible, actor, 1_000);
      expect(codes(list(store, compatible, observation))).toEqual([]);
      const older = await prepared({ ...inspectionHost, bun: "1.3.0" });
      const changed = packageTrustObservation(older, actor, 1_000);
      const result = list(store, older, changed);
      expect(result.notices.map((entry) => entry.notice)).toMatchObject([
        {
          code: "host-incompatible",
          state: "incompatible",
          severity: "blocking",
          reason: "ecosystem-trust-incompatible",
          requiredAction: "update-package",
        },
      ]);
      expect(ecosystemTrustReason(gatewayTrust(store, changed, 1_000))).toBe(
        "ecosystem-trust-incompatible",
      );
    } finally {
      await store.close();
    }
  });
});

describe("rendering", () => {
  test("out-of-range evidence times render as text instead of throwing", async () => {
    const pkg = await prepared();
    const observation = packageTrustObservation(pkg, actor, 1_000);
    const root = await temporaryRoot("falryn-notices-render-");
    const store = await openProductStoreOrThrow(root);
    try {
      decide(store, observation, [], {
        action: "refresh",
        expiresAt: null,
        verification: signedVerification(observation, {
          sequence: 1,
          status: "revoked",
          issuedAt: 9_000_000_000_000_000,
          expiresAt: 9_000_000_000_000_001,
        }),
      });
      const result = list(store, pkg, observation);
      const text = packageNoticeLines(result).join("\n");
      expect(text).toContain("out of range");
    } finally {
      await store.close();
    }
  });
});

describe("acknowledgement boundaries", () => {
  async function revoked() {
    const root = await temporaryRoot("falryn-notices-boundary-");
    const pkg = await prepared();
    const observation = packageTrustObservation(pkg, actor, 1_000);
    const store = await openProductStoreOrThrow(root);
    decide(store, observation, [], {
      action: "refresh",
      expiresAt: null,
      verification: signedVerification(observation, { sequence: 1, status: "revoked" }),
    });
    const notice = list(store, pkg, observation).notices[0]?.notice;
    if (notice === undefined) throw new Error("notice");
    return { store, pkg, observation, notice };
  }

  test("only a current notice can be acknowledged, within a bounded lifetime, with fresh confirmation", async () => {
    const { store, pkg, observation, notice } = await revoked();
    try {
      const attempt = (request: NoticeRequest) =>
        inspectPackageNotices(owners(store), pkg, observation, request);
      const valid = { action: "acknowledge" as const, noticeId: notice.id, expiresAt: 1_000 + DAY };
      expect(attempt({ ...valid, noticeId: canonicalDigest("unknown") })).toEqual({
        status: "failed",
        code: "notice-not-found",
      });
      for (const expiresAt of [1_000, 999, 1_000 + 31 * DAY])
        expect(attempt({ ...valid, expiresAt })).toEqual({
          status: "failed",
          code: "invalid-acknowledgement-expiry",
        });
      expect(attempt({ ...valid, confirmation: canonicalDigest("stale") })).toEqual({
        status: "failed",
        code: "stale-notice-confirmation",
      });
      expect(attempt({ ...valid, extra: true } as unknown as NoticeRequest)).toEqual({
        status: "failed",
        code: "malformed",
      });
      expect(
        inspectPackageNotices(owners(store), pkg, observation, valid, AbortSignal.abort()),
      ).toEqual({ status: "failed", code: "cancelled" });
      expect(list(store, pkg, observation).suppressed).toBe(0);
    } finally {
      await store.close();
    }
  });

  test("an acknowledgement lapses at its expiry and the notice shows again", async () => {
    const { store, pkg, observation, notice } = await revoked();
    try {
      acknowledge(store, pkg, observation, {
        action: "acknowledge",
        noticeId: notice.id,
        expiresAt: 1_000 + DAY,
      });
      expect(list(store, pkg, observation, 1_000 + DAY - 1).notices[0]?.presentation).toBe(
        "suppressed",
      );
      expect(list(store, pkg, observation, 1_000 + DAY).notices[0]).toMatchObject({
        presentation: "shown",
        acknowledgement: { status: "expired" },
      });
    } finally {
      await store.close();
    }
  });

  test("an acknowledgement is never a second confirmation: a changed expiry needs a fresh preview", async () => {
    const { store, pkg, observation, notice } = await revoked();
    try {
      const request = {
        action: "acknowledge" as const,
        noticeId: notice.id,
        expiresAt: 1_000 + DAY,
      };
      const preview = inspectPackageNotices(owners(store), pkg, observation, request);
      if (preview.status !== "preview") throw new Error("preview");
      expect(
        inspectPackageNotices(owners(store), pkg, observation, {
          ...request,
          expiresAt: 1_000 + 2 * DAY,
          confirmation: preview.confirmation ?? "",
        }),
      ).toEqual({ status: "failed", code: "stale-notice-confirmation" });
    } finally {
      await store.close();
    }
  });

  test("a corrupt acknowledgement row neither hides the list nor blocks a new acknowledgement", async () => {
    const { store, pkg, observation, notice } = await revoked();
    try {
      const key = noticeAcknowledgementKey(notice.id, observation.scope);
      expect(
        store.write((statements) => {
          statements.run(
            "INSERT INTO ecosystem_notice_acknowledgements (acknowledgement_key, revision, expires_at, record_json) VALUES ($key, 1, 9999999, 'not json')",
            { key },
          );
          return null;
        }).ok,
      ).toBe(true);
      expect(list(store, pkg, observation).notices[0]).toMatchObject({
        presentation: "shown",
        acknowledgement: { status: "unacknowledged" },
      });
      const done = acknowledge(store, pkg, observation, {
        action: "acknowledge",
        noticeId: notice.id,
        expiresAt: 1_000 + DAY,
      });
      expect(done.status).toBe("applied");
      expect(list(store, pkg, observation).notices[0]?.presentation).toBe("suppressed");
    } finally {
      await store.close();
    }
  });

  test("notices carry only closed codes, digests and bounded text", async () => {
    const { store, pkg, observation } = await revoked();
    try {
      const text = JSON.stringify(list(store, pkg, observation));
      expect(text).not.toMatch(/publicKey|"signature":"[A-Za-z0-9+/]{86}==|\/Users\/|\/private\//u);
    } finally {
      await store.close();
    }
  });
});
