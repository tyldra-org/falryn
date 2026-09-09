import { generateKeyPairSync, sign } from "node:crypto";
import { bytesDigest, canonicalDigest, canonicalJson } from "../../domain/extensions/canonical.ts";
import type { TrustObservation } from "../../domain/security/ecosystem-trust.ts";
import type { PackageVerification } from "../../domain/security/package-provenance.ts";

export function signedVerification(
  observation: TrustObservation,
  options: {
    sequence?: number;
    status?: "clear" | "quarantined" | "revoked";
    publisher?: string;
    issuedAt?: number;
    expiresAt?: number;
  } = {},
): PackageVerification {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const der = publicKey.export({ format: "der", type: "spki" });
  const id = bytesDigest(der);
  const lifetime = {
    issuedAt: options.issuedAt ?? observation.now,
    expiresAt: options.expiresAt ?? observation.now + 60_000,
  };
  const signature: NonNullable<PackageVerification["signature"]>["statement"] = {
    type: "falryn.package-integrity.v1",
    subject: observation.subject.identity,
    publisher: options.publisher ?? canonicalDigest("publisher"),
    ...lifetime,
  };
  const advisory: NonNullable<PackageVerification["advisory"]>["statement"] = {
    type: "falryn.package-advisory.v1",
    subject: observation.subject.identity,
    sequence: options.sequence ?? 1,
    status: options.status ?? "clear",
    advisoryIds: [],
    ...lifetime,
  };
  const proof = <T>(statement: T) => ({
    algorithm: "ed25519" as const,
    keyId: id,
    statement,
    signature: sign(null, Buffer.from(canonicalJson(statement)), privateKey).toString("base64"),
  });
  return {
    version: 1,
    keys: ["publisher", "advisory"].map((role) => ({
      id,
      publicKey: der.toString("base64"),
      role: role as "publisher" | "advisory",
    })),
    signature: proof(signature),
    advisory: proof(advisory),
  };
}
