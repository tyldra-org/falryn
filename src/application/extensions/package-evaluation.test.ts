import { afterEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { createPackageLifecycleRepository } from "../../data/extensions/package-lifecycle-repository.ts";
import {
  openProductStoreOrThrow,
  removeTemporaryRoots,
  temporaryRoot,
} from "../../data/fixtures.ts";
import { createEvaluationRepository } from "../../data/security/evaluation-repository.ts";
import { createPackageProvenanceRepository } from "../../data/security/provenance-repository.ts";
import { createTrustDecisionRepository } from "../../data/security/trust-repository.ts";
import { canonicalDigest } from "../../domain/extensions/canonical.ts";
import type { PackageRequest } from "../../domain/extensions/lifecycle.ts";
import {
  initialHealthResult,
  PACKAGE_TOOL_PROTOCOL,
  type PackageHealthRecord,
} from "../../domain/extensions/package-health.ts";
import type { PackageSource } from "../../domain/extensions/package-source.ts";
import { err, ok } from "../../domain/foundation/result.ts";
import { createHostPackageCache } from "../../integrations/extensions/host-package-cache.ts";
import { ed25519PackageVerifier } from "../../integrations/extensions/package-signature.ts";
import { executableToolSource } from "./evaluation-fixtures.ts";
import { evaluateInstalledPackage, type PackageEvaluationOwners } from "./package-evaluation.ts";
import { inspectionHost, packageSource } from "./package-fixtures.ts";
import { createPackageLifecycle } from "./package-lifecycle.ts";
import { createPackageStanding, projectInstalledTrust } from "./package-standing.ts";
import { preparePackage } from "./prepare-package.ts";

afterEach(removeTemporaryRoots);
const actor = canonicalDigest("evaluation-actor");
const NOW = 1_000_000;

async function setup(source: PackageSource) {
  const root = await temporaryRoot("falryn-package-evaluation-");
  const store = await openProductStoreOrThrow(root);
  const packages = createPackageLifecycleRepository(store);
  const trustOwners = {
    decisions: createTrustDecisionRepository(store),
    provenance: createPackageProvenanceRepository(store),
    verifier: ed25519PackageVerifier,
  };
  const standing = createPackageStanding({
    owners: { packages, ...trustOwners },
    actor,
    now: () => NOW,
  });
  const bytes = createHostPackageCache(join(root, "packages"));
  const lifecycle = createPackageLifecycle(packages, bytes, inspectionHost, undefined, (version) =>
    standing.summarize(version),
  );
  const signal = new AbortController().signal;
  async function apply(action: "install" | "update", revision: number, from: PackageSource) {
    const request: PackageRequest = {
      packageId: "fixture",
      operationId: randomUUID(),
      expectedRevision: revision,
      retention: "retain",
    };
    const preview = await lifecycle.run(action, request, signal, from);
    if (preview.confirmation === null) throw new Error(JSON.stringify(preview));
    const done = await lifecycle.run(
      action,
      { ...request, confirmation: preview.confirmation },
      signal,
      from,
    );
    if (done.status !== "completed") throw new Error(JSON.stringify(done));
  }
  await apply("install", 0, source);
  const attempts: PackageHealthRecord[] = [];
  const evaluations = createEvaluationRepository(store);
  const owners: PackageEvaluationOwners = {
    packages,
    bytes,
    host: inspectionHost,
    trust: (version) => projectInstalledTrust(trustOwners, version, actor, NOW),
    standing: (packageId) => {
      const read = standing.standing(packageId, { versions: false });
      return read.ok ? { ok: true, value: read.value } : { ok: false };
    },
    health: { latestPerContribution: () => ok(attempts) },
    evaluations,
    now: () => NOW,
  };
  const current = packages.current("fixture");
  if (!current.ok || current.value.current === null) throw new Error("install");
  const prepared = await preparePackage(source, inspectionHost);
  if (!prepared.ok) throw new Error(prepared.code);
  return {
    root,
    store,
    owners,
    standing,
    attempts,
    apply,
    prepared: prepared.package,
    installed: current.value.current,
  };
}

function attempt(
  contribution: string,
  identity: string,
  state: PackageHealthRecord["result"]["state"],
  code: string,
  enforcement: "strict" | "off" | null,
): PackageHealthRecord {
  const binding = {
    protocol: PACKAGE_TOOL_PROTOCOL,
    attempt: randomUUID(),
    package: identity,
    contribution,
    generation: identity,
  } as const;
  return {
    operation: randomUUID(),
    packageId: "fixture",
    fingerprint: identity,
    revision: 3,
    birth: null,
    directory: null,
    result: {
      ...initialHealthResult(binding),
      state,
      code,
      terminated: true,
      cleanup: "removed",
      sandbox:
        enforcement === null
          ? null
          : {
              schemaVersion: 1,
              id: "receipt",
              invocationId: null,
              capabilityId: null,
              catalogGeneration: 1,
              policyGeneration: 1,
              inputFingerprint: null,
              effect: "observation",
              confirmationId: null,
              resourceTaskId: null,
              requestedMode: "strict",
              effectiveMode: enforcement,
              authority: "user",
              adapter: enforcement === "strict" ? "macos-seatbelt-v1" : "none",
              state: "terminated",
              pid: null,
              readRoots: [],
              writeRoots: [],
              network: "offline",
              processes: "single-process",
              environment: "explicit",
              credentialHandles: [],
              expanded: false,
              reason: null,
              limitations: [],
              remediation: null,
            },
    },
  };
}

function criterion(result: Awaited<ReturnType<typeof evaluateInstalledPackage>>, name: string) {
  if (result.status !== "completed") throw new Error(result.code);
  return result.report.criteria.find((entry) => entry.criterion === name);
}

test("a local evaluation records what Falryn can observe and is never eligible on its own", async () => {
  const context = await setup(packageSource());
  try {
    const signal = new AbortController().signal;
    const first = await evaluateInstalledPackage(context.owners, "fixture", signal);
    expect(first).toMatchObject({
      status: "completed",
      recorded: true,
      report: {
        evaluator: { kind: "local" },
        subject: context.installed.identity,
        decision: "inconclusive",
        behavioralReport: null,
        limitations: [
          "behavioral-report-unavailable",
          "curator-review-required",
          "resource-measurement-unavailable",
        ],
      },
    });
    expect(criterion(first, "effects")).toMatchObject({
      outcome: "not-applicable",
      code: "declarative-only",
    });
    expect(criterion(first, "integrity")).toMatchObject({ outcome: "pass", code: "bytes-match" });
    expect(criterion(first, "provenance")).toMatchObject({
      outcome: "inconclusive",
      code: "signature-unavailable",
    });
    expect(criterion(first, "tests")).toMatchObject({
      outcome: "inconclusive",
      code: "behavioral-report-unavailable",
    });
    expect(criterion(first, "quality")).toMatchObject({
      outcome: "inconclusive",
      basis: "observed",
      code: "curator-review-required",
    });
    // Evaluation changes no standing: the package is exactly as unapproved as before.
    expect(context.standing.standing("fixture")).toMatchObject({
      ok: true,
      value: { state: "unapproved" },
    });
    const repeat = await evaluateInstalledPackage(context.owners, "fixture", signal);
    expect(repeat).toMatchObject({ status: "completed", recorded: false });
    if (repeat.status !== "completed") throw new Error("repeat");
    expect(repeat.history).toHaveLength(1);
    expect(await evaluateInstalledPackage(context.owners, "missing", signal)).toEqual({
      status: "failed",
      code: "not-installed",
    });
  } finally {
    await context.store.close();
  }
});

test("native attempts decide the effects criterion, and a failed attempt is preserved", async () => {
  const context = await setup(
    executableToolSource([
      { id: "one", mode: "governed" },
      { id: "two", mode: "governed" },
    ]),
  );
  try {
    const signal = new AbortController().signal;
    const [one, two] = context.prepared.contributions.map((entry) => entry.identityDigest);
    if (one === undefined || two === undefined) throw new Error("contributions");
    const identity = context.installed.identityDigest;
    const run = () => evaluateInstalledPackage(context.owners, "fixture", signal);
    expect(criterion(await run(), "effects")).toMatchObject({
      outcome: "inconclusive",
      code: "native-unobserved",
    });
    context.attempts.push(attempt(one, identity, "completed", "tool-completed", "strict"));
    expect(criterion(await run(), "effects")).toMatchObject({ code: "native-unobserved" });
    context.attempts.push(attempt(two, identity, "completed", "tool-completed", "strict"));
    expect(criterion(await run(), "effects")).toMatchObject({
      outcome: "pass",
      code: "native-enforced",
    });
    context.attempts[1] = attempt(two, identity, "healthy", "health-completed", "off");
    const unenforced = await run();
    expect(criterion(unenforced, "effects")).toMatchObject({ code: "enforcement-unavailable" });
    expect(unenforced).toMatchObject({
      report: { limitations: expect.arrayContaining(["sandbox-unavailable"]) },
    });
    context.attempts[1] = attempt(two, identity, "uncertain", "health-uncertain", "strict");
    expect(criterion(await run(), "effects")).toMatchObject({ code: "native-uncertain" });
    // The deceptive contribution: its undeclared effect was denied and the attempt failed.
    context.attempts[1] = attempt(two, identity, "failed", "health-child-crashed", "strict");
    const failed = await run();
    expect(criterion(failed, "effects")).toMatchObject({ outcome: "fail", code: "native-failed" });
    expect(failed).toMatchObject({
      status: "completed",
      report: {
        decision: "not-eligible",
        observations: expect.arrayContaining([
          {
            contribution: two,
            mode: "governed",
            state: "failed",
            code: "health-child-crashed",
            enforcement: "strict",
          },
        ]),
      },
    });
    // Attempts recorded against other bytes say nothing about these.
    context.attempts.splice(
      0,
      2,
      attempt(one, canonicalDigest("other"), "completed", "ok", "strict"),
    );
    expect(criterion(await run(), "effects")).toMatchObject({ code: "native-unobserved" });
  } finally {
    await context.store.close();
  }
});

test("full-user effects stay opaque however their attempts went", async () => {
  const context = await setup(executableToolSource([{ id: "one", mode: "full-user" }]));
  try {
    const [one] = context.prepared.contributions.map((entry) => entry.identityDigest);
    if (one === undefined) throw new Error("contribution");
    context.attempts.push(attempt(one, context.installed.identityDigest, "completed", "ok", null));
    const result = await evaluateInstalledPackage(
      context.owners,
      "fixture",
      new AbortController().signal,
    );
    expect(criterion(result, "effects")).toMatchObject({
      outcome: "inconclusive",
      code: "full-user-opaque",
    });
    expect(result).toMatchObject({
      report: { limitations: expect.arrayContaining(["full-user-effects-opaque"]) },
    });
  } finally {
    await context.store.close();
  }
});

test("held, unreadable and replaced packages report their findings; stale history stays labelled", async () => {
  const context = await setup(packageSource());
  try {
    const signal = new AbortController().signal;
    const installed = context.owners.packages.current("fixture");
    if (!installed.ok) throw new Error("installed");
    const base = {
      action: "quarantine" as const,
      packageId: "fixture",
      expectedRevision: installed.value.revision,
      reason: "policy" as const,
    };
    const preview = await context.standing.enforce(base, signal);
    if (preview.status !== "preview" || preview.confirmation === null) throw new Error("hold");
    await context.standing.enforce({ ...base, confirmation: preview.confirmation }, signal);
    const held = await evaluateInstalledPackage(context.owners, "fixture", signal);
    expect(criterion(held, "security")).toMatchObject({
      outcome: "fail",
      code: "standing-blocked",
    });
    expect(held).toMatchObject({ report: { decision: "not-eligible" } });

    const unreadable = await evaluateInstalledPackage(
      {
        ...context.owners,
        bytes: {
          read: async () => {
            throw new Error("truncated-package-cache");
          },
        },
      },
      "fixture",
      signal,
    );
    expect(criterion(unreadable, "integrity")).toMatchObject({
      outcome: "fail",
      code: "bytes-unverifiable",
    });
    expect(criterion(unreadable, "compatibility")).toMatchObject({
      code: "host-compatibility-unknown",
    });

    await context.apply(
      "update",
      installed.value.revision,
      packageSource(undefined, { "notes.md": "changed" }),
    );
    const replaced = await evaluateInstalledPackage(context.owners, "fixture", signal);
    if (replaced.status !== "completed") throw new Error(replaced.code);
    expect(replaced.report.subject).not.toEqual(context.installed.identity);
    expect(replaced.history[0]).toMatchObject({ stale: false });
    expect(replaced.history.slice(1).every((entry) => entry.stale)).toBe(true);
    expect(replaced.history.length).toBeGreaterThan(1);
  } finally {
    await context.store.close();
  }
});

test("cancellation records nothing, and store failures are reported as such", async () => {
  const context = await setup(packageSource());
  try {
    const controller = new AbortController();
    const cancelled = await evaluateInstalledPackage(
      {
        ...context.owners,
        bytes: {
          read: async (version, signal) => {
            controller.abort();
            return context.owners.bytes.read(version, signal);
          },
        },
      },
      "fixture",
      controller.signal,
    );
    expect(cancelled).toEqual({ status: "failed", code: "cancelled" });
    expect(context.owners.evaluations.history("fixture", 8)).toMatchObject({ value: [] });
    const uncertain = await evaluateInstalledPackage(
      {
        ...context.owners,
        evaluations: { ...context.owners.evaluations, append: () => err({ code: "uncertain" }) },
      },
      "fixture",
      new AbortController().signal,
    );
    expect(uncertain).toEqual({ status: "failed", code: "uncertain" });
    const unavailable = await evaluateInstalledPackage(
      { ...context.owners, health: { latestPerContribution: () => err({ code: "unavailable" }) } },
      "fixture",
      new AbortController().signal,
    );
    expect(unavailable).toEqual({ status: "failed", code: "health-store-unavailable" });
  } finally {
    await context.store.close();
  }
});
