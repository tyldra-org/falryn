/** Session-scoped, artifact-backed scratch resources (#848). */

import type { ArtifactId, ContentDigest } from "./artifact.ts";
import type { Instant } from "./clock.ts";
import { type InvocationId, type SessionId, sessionId } from "./identity.ts";
import { err, ok, type Result } from "./result.ts";

declare const brand: unique symbol;

export type ScratchName = string & { readonly [brand]: "ScratchName" };
export type ScratchHandle = string & { readonly [brand]: "ScratchHandle" };
export type ScratchRevision = number & { readonly [brand]: "ScratchRevision" };

export const MAX_SCRATCH_NAME_BYTES = 160;
export const MAX_SCRATCH_TEXT_BYTES = 64 * 1_024;
export const MAX_SCRATCH_LIST_LIMIT = 100;

export const SCRATCH_MEDIA_TYPES = [
  "text/plain",
  "text/markdown",
  "application/json",
  "text/javascript",
  "text/typescript",
  "text/x-python",
  "text/x-shellscript",
] as const;

export type ScratchMediaType = (typeof SCRATCH_MEDIA_TYPES)[number];
export type ScratchStatus = "active" | "discarded";

export type ScratchContractError = {
  readonly kind: "scratch-resource";
  readonly code:
    | "malformed-name"
    | "malformed-handle"
    | "cross-session"
    | "invalid-revision"
    | "invalid-list-limit"
    | "unsupported-media-type"
    | "oversize";
};

export type ScratchResource = {
  readonly sessionId: SessionId;
  readonly name: ScratchName;
  readonly status: ScratchStatus;
  readonly currentRevision: ScratchRevision;
  readonly createdAt: Instant;
  readonly updatedAt: Instant;
};

export type ScratchResourceRevision = {
  readonly sessionId: SessionId;
  readonly name: ScratchName;
  readonly revision: ScratchRevision;
  readonly artifactId: ArtifactId;
  readonly digest: ContentDigest;
  readonly mediaType: ScratchMediaType;
  readonly byteLength: number;
  readonly invocationId: InvocationId;
  readonly createdAt: Instant;
};

export type ScratchResourceView = {
  readonly resource: ScratchResource;
  readonly revision: ScratchResourceRevision;
};

export type ScratchRepositoryError = {
  readonly kind: "scratch-resource";
  readonly code: "not-found" | "discarded" | "conflict" | "cancelled" | "malformed" | "unavailable";
};

export type PublishScratchRevision = {
  readonly sessionId: SessionId;
  readonly name: ScratchName;
  readonly expectedRevision: ScratchRevision | null;
  readonly revision: ScratchResourceRevision;
};

export type ScratchResourceRepositoryPort = {
  publish(
    input: PublishScratchRevision,
    signal?: AbortSignal,
  ): Result<ScratchResourceView, ScratchRepositoryError>;
  get(
    owner: SessionId,
    name: ScratchName,
    revision?: ScratchRevision,
  ): Result<ScratchResourceView | null, ScratchRepositoryError>;
  list(
    owner: SessionId,
    limit: number,
  ): Result<readonly ScratchResourceView[], ScratchRepositoryError>;
  discard(
    owner: SessionId,
    name: ScratchName,
    expectedRevision: ScratchRevision,
    updatedAt: Instant,
    signal?: AbortSignal,
  ): Result<ScratchResourceView, ScratchRepositoryError>;
};

function contractError(code: ScratchContractError["code"]): ScratchContractError {
  return { kind: "scratch-resource", code };
}

export function parseScratchName(value: unknown): Result<ScratchName, ScratchContractError> {
  if (typeof value !== "string") return err(contractError("malformed-name"));
  const bytes = new TextEncoder().encode(value);
  const unsafeCharacter = [...value].some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return character === "/" || character === "\\" || codePoint <= 31 || codePoint === 127;
  });
  if (
    value.length === 0 ||
    value !== value.trim() ||
    value === "." ||
    value === ".." ||
    bytes.byteLength > MAX_SCRATCH_NAME_BYTES ||
    unsafeCharacter
  ) {
    return err(contractError("malformed-name"));
  }
  return ok(value as ScratchName);
}

export function scratchRevision(value: unknown): Result<ScratchRevision, ScratchContractError> {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1
    ? ok(value as ScratchRevision)
    : err(contractError("invalid-revision"));
}

export function parseScratchMediaType(
  value: unknown,
): Result<ScratchMediaType, ScratchContractError> {
  return typeof value === "string" && (SCRATCH_MEDIA_TYPES as readonly string[]).includes(value)
    ? ok(value as ScratchMediaType)
    : err(contractError("unsupported-media-type"));
}

export function parseScratchListLimit(value: unknown): Result<number, ScratchContractError> {
  return typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 1 &&
    value <= MAX_SCRATCH_LIST_LIMIT
    ? ok(value)
    : err(contractError("invalid-list-limit"));
}

export function scratchHandle(owner: SessionId, name: ScratchName): ScratchHandle {
  return `scratch://session/${encodeURIComponent(String(owner))}/${encodeURIComponent(String(name))}` as ScratchHandle;
}

export function parseScratchHandle(
  value: unknown,
  expectedOwner?: SessionId,
): Result<{ readonly owner: SessionId; readonly name: ScratchName }, ScratchContractError> {
  if (typeof value !== "string" || !value.startsWith("scratch://session/")) {
    return err(contractError("malformed-handle"));
  }
  const remainder = value.slice("scratch://session/".length);
  const separator = remainder.indexOf("/");
  if (separator <= 0 || separator === remainder.length - 1) {
    return err(contractError("malformed-handle"));
  }
  try {
    const ownerText = decodeURIComponent(remainder.slice(0, separator));
    const nameText = decodeURIComponent(remainder.slice(separator + 1));
    const parsedOwner = sessionId.parse(ownerText);
    const parsedName = parseScratchName(nameText);
    if (!parsedOwner.ok || !parsedName.ok) {
      return err(contractError("malformed-handle"));
    }
    if (
      encodeURIComponent(ownerText) !== remainder.slice(0, separator) ||
      encodeURIComponent(nameText) !== remainder.slice(separator + 1)
    ) {
      return err(contractError("malformed-handle"));
    }
    if (expectedOwner !== undefined && parsedOwner.value !== expectedOwner) {
      return err(contractError("cross-session"));
    }
    return ok({ owner: parsedOwner.value, name: parsedName.value });
  } catch {
    return err(contractError("malformed-handle"));
  }
}

export function validateScratchText(text: string): Result<Uint8Array, ScratchContractError> {
  const bytes = new TextEncoder().encode(text);
  return bytes.byteLength <= MAX_SCRATCH_TEXT_BYTES ? ok(bytes) : err(contractError("oversize"));
}
