/**
 * The SHA-256 content hasher.
 *
 * A leaf: it wraps `node:crypto` and produces the domain's prefixed digest
 * form. The prefix is not decoration — a bare hexadecimal string does not say
 * what produced it, and a stored digest nobody can re-verify is a stored digest
 * nobody should trust.
 *
 * SHA-256 rather than a faster non-cryptographic hash, because this digest is
 * content *identity*: it decides whether two artifacts share bytes, and a
 * function with findable collisions would let one artifact's bytes be served
 * for another's.
 */

import { createHash, type Hash } from "node:crypto";

import {
  CONTENT_DIGEST_ALGORITHM,
  type ContentDigest,
  type ContentHasher,
  type ContentHasherPort,
  contentDigest,
} from "../domain/index.ts";

export function createSha256Hasher(): ContentHasherPort {
  return {
    create(): ContentHasher {
      const hash: Hash = createHash("sha256");
      return {
        update(chunk: Uint8Array): void {
          hash.update(chunk);
        },
        digest(): ContentDigest {
          return contentDigest.from(`${CONTENT_DIGEST_ALGORITHM}:${hash.digest("hex")}`);
        },
      };
    },
  };
}
