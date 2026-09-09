import { createPublicKey, verify } from "node:crypto";
import { bytesDigest } from "../../domain/extensions/canonical.ts";
import type { SignatureVerifier } from "../../domain/security/package-provenance.ts";

/** DER/SPKI Ed25519 only; no certificate, network key lookup, or algorithm inference. */
export const ed25519PackageVerifier: SignatureVerifier = {
  verify(publicKey, keyId, statement, signature) {
    try {
      const der = Buffer.from(publicKey, "base64");
      const signed = Buffer.from(signature, "base64");
      if (
        der.toString("base64") !== publicKey ||
        signed.toString("base64") !== signature ||
        signed.length !== 64 ||
        bytesDigest(der) !== keyId
      )
        return false;
      const key = createPublicKey({ key: der, format: "der", type: "spki" });
      return key.asymmetricKeyType === "ed25519" && verify(null, statement, key, signed);
    } catch {
      return false;
    }
  },
};
