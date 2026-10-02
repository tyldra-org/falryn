import { generateKeyPairSync, sign } from "node:crypto";
import { bytesDigest, canonicalDigest, canonicalJson } from "../../domain/extensions/canonical.ts";
import type { PackageIdentityV1 } from "../../domain/extensions/identity.ts";
import { PACKAGE_TOOL_PROTOCOL } from "../../domain/extensions/package-health.ts";
import type { PackageSource } from "../../domain/extensions/package-source.ts";
import type { TrustObservation } from "../../domain/security/ecosystem-trust.ts";
import {
  CRITERION_CODES,
  type CriterionCode,
  type CurationStatement,
  EVALUATION_CRITERIA,
  type EvaluationCriterion,
  type PackageEvaluationReport,
} from "../../domain/security/package-evaluation.ts";
import type { PackageVerification } from "../../domain/security/package-provenance.ts";
import { executionResources, packageSource, pluginManifest } from "./package-fixtures.ts";

const schema = { type: "object" };
/** A package with one tool per entry; governed tools run natively, full-user ones under Bun. */
export function executableToolSource(
  tools: readonly { readonly id: string; readonly mode: "governed" | "full-user" }[],
  version = "1.0.0",
): PackageSource {
  return packageSource(
    pluginManifest(
      {
        version: 1,
        contributions: tools.map(({ id, mode }) => ({
          kind: "tool",
          namespace: "fixture",
          id,
          description: "Read the fixture answer",
          family: "read",
          inputSchema: schema,
          outputSchema: schema,
          authority: {
            effects: ["observation"],
            permissions: [],
            roots: [],
            destinations: [],
            secretReferences: [],
            localData: [],
          },
          execution:
            mode === "governed"
              ? {
                  mode,
                  executable: "peer",
                  loader: "native",
                  protocolVersion: PACKAGE_TOOL_PROTOCOL,
                  compatibility: {},
                  resources: executionResources,
                }
              : {
                  mode,
                  executable: "scripts/run.ts",
                  loader: "bun",
                  protocolVersion: "1",
                  compatibility: {},
                  resources: executionResources,
                },
        })),
        files: [
          { path: "peer", digest: bytesDigest("inert fixture") },
          { path: "scripts/run.ts", digest: bytesDigest("export {};") },
        ],
      },
      { version },
    ),
    { peer: "inert fixture", "scripts/run.ts": "export {};" },
  );
}

const CURATOR_CODES: Partial<Record<EvaluationCriterion, CriterionCode>> = {
  provenance: "signature-verified",
  ownership: "publisher-verified",
  integrity: "bytes-match",
  effects: "native-enforced",
  security: "advisory-clear",
  compatibility: "host-compatible",
};
/** A curator's report: observed criteria passed, the rest reviewed and passed, unless overridden. */
export function curatorReport(
  subject: PackageIdentityV1,
  overrides: Partial<Record<EvaluationCriterion, CriterionCode>> = {},
  evaluatedAt = 500,
): PackageEvaluationReport {
  const criteria = EVALUATION_CRITERIA.map((criterion) => {
    const code = overrides[criterion] ?? CURATOR_CODES[criterion] ?? "curator-reviewed";
    const rule = CRITERION_CODES[code];
    return { criterion, outcome: rule.outcomes[0], basis: rule.basis, code };
  });
  const failed = criteria.some((entry) => entry.outcome === "fail");
  const open = criteria.some((entry) => entry.outcome === "inconclusive");
  return {
    type: "falryn.package-evaluation.v1",
    rubric: "falryn.package-rubric.v1",
    subject,
    evaluator: { kind: "curator", falryn: "0.0.0", os: "darwin", arch: "arm64" },
    contributionKinds: ["tool"],
    criteria,
    observations: [],
    omittedObservations: 0,
    behavioralReport: null,
    limitations: [],
    decision: failed ? "not-eligible" : open ? "inconclusive" : "eligible",
    evaluatedAt,
  };
}

/**
 * Publisher, advisory and curator evidence signed with one real Ed25519 key. `curatorRole` decides
 * which role the host pins that key under for the curation proof.
 */
export function curatedVerification(
  observation: TrustObservation,
  options: {
    readonly statement?: Partial<CurationStatement>;
    readonly curatorRole?: "curator" | "publisher";
    readonly lifetimeMs?: number;
  } = {},
): PackageVerification {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const der = publicKey.export({ format: "der", type: "spki" });
  const id = bytesDigest(der);
  const lifetime = {
    issuedAt: observation.now,
    expiresAt: observation.now + (options.lifetimeMs ?? 60_000),
  };
  const proof = <T>(statement: T) => ({
    algorithm: "ed25519" as const,
    keyId: id,
    statement,
    signature: sign(null, Buffer.from(canonicalJson(statement)), privateKey).toString("base64"),
  });
  const curation: CurationStatement = {
    type: "falryn.package-curation.v1",
    subject: observation.subject.identity,
    decision: "curated",
    report: curatorReport(observation.subject.identity, {}, observation.now - 1),
    ...lifetime,
    ...options.statement,
  };
  const roles = [
    "publisher",
    "advisory",
    ...(options.curatorRole === "publisher" ? [] : ["curator"]),
  ];
  return {
    version: 1,
    keys: roles.map((role) => ({
      id,
      publicKey: der.toString("base64"),
      role: role as "publisher" | "advisory" | "curator",
    })),
    signature: proof({
      type: "falryn.package-integrity.v1" as const,
      subject: observation.subject.identity,
      publisher: canonicalDigest("publisher"),
      issuedAt: observation.now,
      expiresAt: observation.now + 60_000,
    }),
    advisory: proof({
      type: "falryn.package-advisory.v1" as const,
      subject: observation.subject.identity,
      sequence: 1,
      status: "clear" as const,
      advisoryIds: [],
      issuedAt: observation.now,
      expiresAt: observation.now + 60_000,
    }),
    curation: proof(curation),
  };
}
