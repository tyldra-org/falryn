/** Versioned, bounded canonical metadata. File integrity always hashes exact bytes. */
import { createHash } from "node:crypto";
import { type Node, parseTree } from "jsonc-parser";

export const MAX_METADATA_BYTES = 1_048_576;
export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

export class ExtensionInputError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

export function canonicalText(value: string): string {
  if (!value.isWellFormed()) throw new ExtensionInputError("invalid-unicode");
  return value.normalize("NFC").replace(/\r\n?/gu, "\n");
}

export function canonicalJson(input: unknown): string {
  let nodes = 0;
  const ancestors = new Set<object>();
  const visit = (value: unknown, depth: number): JsonValue => {
    if (++nodes > 65_536 || depth > 32) throw new ExtensionInputError("metadata-limit");
    if (value === null || typeof value === "boolean") return value;
    if (typeof value === "string") {
      if (Buffer.byteLength(value) > MAX_METADATA_BYTES)
        throw new ExtensionInputError("metadata-limit");
      return canonicalText(value);
    }
    if (typeof value === "number" && Number.isFinite(value))
      return Object.is(value, -0) ? 0 : value;
    if (typeof value !== "object" || value === null)
      throw new ExtensionInputError("non-json-value");
    if (ancestors.has(value)) throw new ExtensionInputError("cyclic-metadata");
    if (Object.getOwnPropertySymbols(value).length > 0)
      throw new ExtensionInputError("non-json-property");
    if (
      !Array.isArray(value) &&
      Object.getPrototypeOf(value) !== Object.prototype &&
      Object.getPrototypeOf(value) !== null
    )
      throw new ExtensionInputError("non-json-object");
    ancestors.add(value);
    try {
      if (Array.isArray(value)) return Array.from(value, (entry) => visit(entry, depth + 1));
      const result: { [key: string]: JsonValue } = Object.create(null);
      const entries = Object.entries(Object.getOwnPropertyDescriptors(value))
        .map(([key, descriptor]) => {
          if (!descriptor.enumerable || !("value" in descriptor))
            throw new ExtensionInputError("non-json-property");
          return [canonicalText(key), descriptor.value] as const;
        })
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
      for (const [key, entry] of entries) {
        if (Object.hasOwn(result, key)) throw new ExtensionInputError("normalized-key-collision");
        result[key] = visit(entry, depth + 1);
      }
      return result;
    } finally {
      ancestors.delete(value);
    }
  };
  // JSON.stringify reorders integer-looking object keys, even after sorted insertion.
  const encode = (value: JsonValue): string => {
    if (value === null || typeof value !== "object") return JSON.stringify(value);
    if (Array.isArray(value)) return `[${value.map(encode).join(",")}]`;
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${encode(value[key] as JsonValue)}`)
      .join(",")}}`;
  };
  const encoded = encode(visit(input, 0));
  if (Buffer.byteLength(encoded) > MAX_METADATA_BYTES)
    throw new ExtensionInputError("metadata-limit");
  return encoded;
}

export function parseMetadata(text: string): JsonValue {
  if (Buffer.byteLength(text) > MAX_METADATA_BYTES) throw new ExtensionInputError("metadata-limit");
  const errors: import("jsonc-parser").ParseError[] = [];
  const tree = parseTree(text, errors, { disallowComments: true, allowTrailingComma: false });
  if (tree === undefined || errors.length > 0) throw new ExtensionInputError("invalid-json");
  let count = 0;
  const check = (node: Node, depth: number): void => {
    if (++count > 65_536 || depth > 64) throw new ExtensionInputError("metadata-limit");
    if (node.type === "object") {
      const keys = new Set<string>();
      for (const property of node.children ?? []) {
        const key = canonicalText(String(property.children?.[0]?.value));
        if (keys.has(key)) throw new ExtensionInputError("duplicate-json-key");
        keys.add(key);
      }
    }
    for (const child of node.children ?? []) check(child, depth + 1);
  };
  check(tree, 0);
  return JSON.parse(canonicalJson(JSON.parse(text))) as JsonValue;
}

export function bytesDigest(bytes: string | Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

export function canonicalDigest(value: unknown): string {
  return bytesDigest(canonicalJson(value));
}

export function freezeMetadata<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) freezeMetadata(child);
    Object.freeze(value);
  }
  return value;
}

/** A portable path has one spelling and cannot address a host root. */
export function packageRelativePath(value: string): string | null {
  const normalized = canonicalText(value).replaceAll("\\", "/").replace(/^\.\//u, "");
  if (normalized.length === 0 || normalized.length > 1_024 || /[\p{Cc}:]/u.test(normalized))
    return null;
  if (
    normalized
      .split("/")
      .some(
        (part) =>
          part === "" ||
          part === "." ||
          part === ".." ||
          /[. ]$/u.test(part) ||
          /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(part),
      )
  )
    return null;
  return normalized;
}
