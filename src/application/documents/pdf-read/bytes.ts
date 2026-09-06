import { createHash } from "node:crypto";

export function latin1(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("latin1");
}

export function bytesFromLatin1(value: string): Uint8Array {
  return Uint8Array.from(Buffer.from(value, "latin1"));
}

export function byteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

export function digestFor(bytes: Uint8Array): string {
  return `sha-256:${createHash("sha256").update(bytes).digest("hex")}`;
}

export function truncateUtf8(
  value: string,
  maximumBytes: number,
): {
  readonly value: string;
  readonly truncated: boolean;
  readonly omittedBytes: number;
} {
  const sourceBytes = byteLength(value);
  if (sourceBytes <= maximumBytes) {
    return { value, truncated: false, omittedBytes: 0 };
  }
  const encoded = Buffer.from(value, "utf8");
  const decoder = new TextDecoder("utf-8", { fatal: true });
  for (let length = Math.max(0, maximumBytes); length > 0; length -= 1) {
    try {
      const truncated = decoder.decode(encoded.subarray(0, length));
      return {
        value: truncated,
        truncated: true,
        omittedBytes: sourceBytes - byteLength(truncated),
      };
    } catch {
      // A UTF-8 code point may straddle this candidate boundary.
    }
  }
  return { value: "", truncated: true, omittedBytes: sourceBytes };
}
