/** Authenticated local IPC payloads. Key material never leaves this process owner. */
import {
  createCipheriv,
  createDecipheriv,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
  sign,
  verify,
} from "node:crypto";
import { z } from "zod";
import { err, ok } from "../../domain/foundation/result.ts";
import type { PeerCrypto } from "../../domain/orchestration/peer-transport.ts";

const keysSchema = z.strictObject({ signing: z.string().max(80), agreement: z.string().max(80) });
const packetSchema = z.strictObject({
  version: z.literal(1),
  nonce: z.string().length(16),
  text: z.string().max(524_288),
  tag: z.string().length(24),
  signature: z.string().length(88),
});
const context = Buffer.from("falryn.peer-ipc.v1");
export function createPeerCrypto(): PeerCrypto {
  const signing = generateKeyPairSync("ed25519");
  const agreement = generateKeyPairSync("x25519");
  const publicKey = JSON.stringify({
    signing: signing.publicKey.export({ format: "der", type: "spki" }).toString("base64"),
    agreement: agreement.publicKey.export({ format: "der", type: "spki" }).toString("base64"),
  });
  function remote(encoded: string) {
    if (encoded.length > 256) throw new Error("peer key size");
    const parsed = keysSchema.parse(JSON.parse(encoded));
    const remoteSigning = createPublicKey({
      key: Buffer.from(parsed.signing, "base64"),
      format: "der",
      type: "spki",
    });
    const remoteAgreement = createPublicKey({
      key: Buffer.from(parsed.agreement, "base64"),
      format: "der",
      type: "spki",
    });
    if (
      remoteSigning.asymmetricKeyType !== "ed25519" ||
      remoteAgreement.asymmetricKeyType !== "x25519"
    )
      throw new Error("peer key type");
    return { signing: remoteSigning, agreement: remoteAgreement };
  }
  return {
    publicKey,
    seal(recipientPublicKey, value) {
      const plain = Buffer.from(JSON.stringify(value));
      if (plain.byteLength > 262_144) throw new Error("peer frame size");
      const recipient = remote(recipientPublicKey);
      const nonce = randomBytes(12);
      const secret = diffieHellman({
        privateKey: agreement.privateKey,
        publicKey: recipient.agreement,
      });
      const key = Buffer.from(hkdfSync("sha256", secret, nonce, context, 32));
      secret.fill(0);
      try {
        const cipher = createCipheriv("aes-256-gcm", key, nonce);
        cipher.setAAD(context);
        const text = Buffer.concat([cipher.update(plain), cipher.final()]).toString("base64");
        const unsigned = {
          version: 1,
          nonce: nonce.toString("base64"),
          text,
          tag: cipher.getAuthTag().toString("base64"),
        };
        return JSON.stringify({
          ...unsigned,
          signature: sign(null, Buffer.from(JSON.stringify(unsigned)), signing.privateKey).toString(
            "base64",
          ),
        });
      } finally {
        key.fill(0);
        plain.fill(0);
      }
    },
    decrypt(senderPublicKey, sealed) {
      try {
        if (sealed.length > 525_000) return err({ code: "invalid" });
        const parsed = packetSchema.safeParse(JSON.parse(sealed));
        if (!parsed.success) return err({ code: "invalid" });
        const { signature, ...unsigned } = parsed.data;
        const sender = remote(senderPublicKey);
        if (
          !verify(
            null,
            Buffer.from(JSON.stringify(unsigned)),
            sender.signing,
            Buffer.from(signature, "base64"),
          )
        )
          return err({ code: "denied" });
        const nonce = Buffer.from(unsigned.nonce, "base64");
        if (nonce.byteLength !== 12) return err({ code: "invalid" });
        const secret = diffieHellman({
          privateKey: agreement.privateKey,
          publicKey: sender.agreement,
        });
        const key = Buffer.from(hkdfSync("sha256", secret, nonce, context, 32));
        secret.fill(0);
        try {
          const decipher = createDecipheriv("aes-256-gcm", key, nonce);
          decipher.setAAD(context);
          decipher.setAuthTag(Buffer.from(unsigned.tag, "base64"));
          const plain = Buffer.concat([
            decipher.update(Buffer.from(unsigned.text, "base64")),
            decipher.final(),
          ]);
          try {
            return ok(JSON.parse(plain.toString("utf8")));
          } finally {
            plain.fill(0);
          }
        } finally {
          key.fill(0);
        }
      } catch {
        return err({ code: "denied" });
      }
    },
  };
}
