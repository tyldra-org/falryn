/**
 * Language-server document and workspace synchronization (#90).
 *
 * Open/change/save/close, workspace-folder updates, and dynamic capability
 * registration stay Falryn-owned. Feature requests and edits-as-patches remain
 * later children of #88.
 */

import { err, ok, type Result } from "./result.ts";

export const MAX_LANGUAGE_SERVER_OPEN_DOCUMENTS = 256;
export const MAX_LANGUAGE_SERVER_DOCUMENT_BYTES = 4 * 1024 * 1024;
export const MAX_LANGUAGE_SERVER_DOCUMENT_URI_LENGTH = 4_096;
export const MAX_LANGUAGE_SERVER_LANGUAGE_ID_LENGTH = 64;
export const MAX_LANGUAGE_SERVER_WORKSPACE_FOLDERS = 64;
export const MAX_LANGUAGE_SERVER_REGISTERED_CAPABILITIES = 128;
export const MAX_LANGUAGE_SERVER_CONTENT_CHANGES = 1_024;

export type LanguageServerDocumentUri = string;

export type LanguageServerWorkspaceFolder = {
  readonly uri: string;
  readonly name: string;
};

export type LanguageServerOpenDocument = {
  readonly uri: LanguageServerDocumentUri;
  readonly languageId: string;
  readonly version: number;
  /** Exact UTF-8 text last admitted for this document. */
  readonly text: string;
};

export type LanguageServerContentChange =
  | {
      readonly kind: "full";
      readonly text: string;
    }
  | {
      readonly kind: "incremental";
      readonly text: string;
      readonly range: {
        readonly start: { readonly line: number; readonly character: number };
        readonly end: { readonly line: number; readonly character: number };
      };
    };

export type LanguageServerOpenDocumentRequest = {
  readonly uri: LanguageServerDocumentUri;
  readonly languageId: string;
  readonly text: string;
  /** Defaults to 1 when omitted. */
  readonly version?: number | undefined;
};

export type LanguageServerChangeDocumentRequest = {
  readonly uri: LanguageServerDocumentUri;
  /** Must be exactly one greater than the currently tracked version. */
  readonly version: number;
  readonly contentChanges: readonly LanguageServerContentChange[];
};

export type LanguageServerSaveDocumentRequest = {
  readonly uri: LanguageServerDocumentUri;
  readonly text?: string | undefined;
};

export type LanguageServerCloseDocumentRequest = {
  readonly uri: LanguageServerDocumentUri;
};

export type LanguageServerWorkspaceFoldersChange = {
  readonly added: readonly LanguageServerWorkspaceFolder[];
  readonly removed: readonly LanguageServerWorkspaceFolder[];
};

export type LanguageServerRegisteredCapability = {
  readonly id: string;
  readonly method: string;
  readonly registerOptions: unknown;
};

export type LanguageServerSyncValidationReason =
  | "invalid-uri"
  | "invalid-language-id"
  | "invalid-version"
  | "invalid-text"
  | "text-too-large"
  | "too-many-changes"
  | "invalid-change"
  | "invalid-folder"
  | "too-many-folders"
  | "invalid-capability";

export type LanguageServerSyncError =
  | {
      readonly kind: "language-server";
      readonly code: "invalid-request";
      readonly reason: LanguageServerSyncValidationReason;
    }
  | { readonly kind: "language-server"; readonly code: "not-ready" }
  | { readonly kind: "language-server"; readonly code: "document-not-open" }
  | { readonly kind: "language-server"; readonly code: "document-already-open" }
  | { readonly kind: "language-server"; readonly code: "stale-document" }
  | { readonly kind: "language-server"; readonly code: "capacity-exceeded" };

function utf8Bytes(text: string): number {
  return new TextEncoder().encode(text).byteLength;
}

export function validateDocumentUri(uri: string): LanguageServerSyncValidationReason | null {
  if (
    uri.length === 0 ||
    uri.length > MAX_LANGUAGE_SERVER_DOCUMENT_URI_LENGTH ||
    uri.includes("\0") ||
    !uri.includes(":")
  ) {
    return "invalid-uri";
  }
  return null;
}

export function validateOpenDocumentRequest(
  request: LanguageServerOpenDocumentRequest,
): LanguageServerSyncValidationReason | null {
  const uriError = validateDocumentUri(request.uri);
  if (uriError !== null) {
    return uriError;
  }
  if (
    request.languageId.length === 0 ||
    request.languageId.length > MAX_LANGUAGE_SERVER_LANGUAGE_ID_LENGTH ||
    request.languageId.includes("\0")
  ) {
    return "invalid-language-id";
  }
  if (
    request.version !== undefined &&
    (!Number.isSafeInteger(request.version) || request.version < 1)
  ) {
    return "invalid-version";
  }
  if (request.text.includes("\0")) {
    return "invalid-text";
  }
  if (utf8Bytes(request.text) > MAX_LANGUAGE_SERVER_DOCUMENT_BYTES) {
    return "text-too-large";
  }
  return null;
}

export function validateChangeDocumentRequest(
  request: LanguageServerChangeDocumentRequest,
): LanguageServerSyncValidationReason | null {
  const uriError = validateDocumentUri(request.uri);
  if (uriError !== null) {
    return uriError;
  }
  if (!Number.isSafeInteger(request.version) || request.version < 1) {
    return "invalid-version";
  }
  if (
    request.contentChanges.length === 0 ||
    request.contentChanges.length > MAX_LANGUAGE_SERVER_CONTENT_CHANGES
  ) {
    return "too-many-changes";
  }
  let aggregate = 0;
  for (const change of request.contentChanges) {
    if (change.text.includes("\0")) {
      return "invalid-text";
    }
    aggregate += utf8Bytes(change.text);
    if (aggregate > MAX_LANGUAGE_SERVER_DOCUMENT_BYTES) {
      return "text-too-large";
    }
    if (change.kind === "incremental") {
      const { start, end } = change.range;
      if (
        !Number.isSafeInteger(start.line) ||
        !Number.isSafeInteger(start.character) ||
        !Number.isSafeInteger(end.line) ||
        !Number.isSafeInteger(end.character) ||
        start.line < 0 ||
        start.character < 0 ||
        end.line < 0 ||
        end.character < 0
      ) {
        return "invalid-change";
      }
    }
  }
  return null;
}

export function validateWorkspaceFolder(
  folder: LanguageServerWorkspaceFolder,
): LanguageServerSyncValidationReason | null {
  const uriError = validateDocumentUri(folder.uri);
  if (uriError !== null) {
    return "invalid-folder";
  }
  if (folder.name.length === 0 || folder.name.includes("\0")) {
    return "invalid-folder";
  }
  return null;
}

export function validateWorkspaceFoldersChange(
  change: LanguageServerWorkspaceFoldersChange,
): LanguageServerSyncValidationReason | null {
  const total = change.added.length + change.removed.length;
  if (total === 0 || total > MAX_LANGUAGE_SERVER_WORKSPACE_FOLDERS) {
    return "too-many-folders";
  }
  for (const folder of [...change.added, ...change.removed]) {
    const invalid = validateWorkspaceFolder(folder);
    if (invalid !== null) {
      return invalid;
    }
  }
  return null;
}

export function applyContentChanges(
  previousText: string,
  changes: readonly LanguageServerContentChange[],
): Result<string, LanguageServerSyncError> {
  let text = previousText;
  for (const change of changes) {
    if (change.kind === "full") {
      text = change.text;
      continue;
    }
    const startOffset = offsetAt(text, change.range.start);
    const endOffset = offsetAt(text, change.range.end);
    if (startOffset === null || endOffset === null || endOffset < startOffset) {
      return err({
        kind: "language-server",
        code: "invalid-request",
        reason: "invalid-change",
      });
    }
    text = `${text.slice(0, startOffset)}${change.text}${text.slice(endOffset)}`;
  }
  if (utf8Bytes(text) > MAX_LANGUAGE_SERVER_DOCUMENT_BYTES) {
    return err({
      kind: "language-server",
      code: "invalid-request",
      reason: "text-too-large",
    });
  }
  return ok(text);
}

function offsetAt(
  text: string,
  position: { readonly line: number; readonly character: number },
): number | null {
  let line = 0;
  let index = 0;
  while (line < position.line) {
    const next = text.indexOf("\n", index);
    if (next === -1) {
      return null;
    }
    index = next + 1;
    line += 1;
  }
  const lineEnd = text.indexOf("\n", index);
  const end = lineEnd === -1 ? text.length : lineEnd;
  const character = Math.min(position.character, end - index);
  if (character < 0) {
    return null;
  }
  return index + character;
}

export function mergeWorkspaceFolders(
  current: readonly LanguageServerWorkspaceFolder[],
  change: LanguageServerWorkspaceFoldersChange,
): Result<readonly LanguageServerWorkspaceFolder[], LanguageServerSyncError> {
  const removed = new Set(change.removed.map((folder) => folder.uri));
  const next = current.filter((folder) => !removed.has(folder.uri));
  const seen = new Set(next.map((folder) => folder.uri));
  for (const folder of change.added) {
    if (seen.has(folder.uri)) {
      continue;
    }
    next.push(folder);
    seen.add(folder.uri);
  }
  if (next.length > MAX_LANGUAGE_SERVER_WORKSPACE_FOLDERS) {
    return err({ kind: "language-server", code: "capacity-exceeded" });
  }
  return ok(next);
}

export function parseRegisterCapabilityParams(
  params: unknown,
): Result<readonly LanguageServerRegisteredCapability[], LanguageServerSyncError> {
  if (typeof params !== "object" || params === null || Array.isArray(params)) {
    return err({
      kind: "language-server",
      code: "invalid-request",
      reason: "invalid-capability",
    });
  }
  const registrations = (params as { registrations?: unknown }).registrations;
  if (!Array.isArray(registrations) || registrations.length === 0) {
    return err({
      kind: "language-server",
      code: "invalid-request",
      reason: "invalid-capability",
    });
  }
  if (registrations.length > MAX_LANGUAGE_SERVER_REGISTERED_CAPABILITIES) {
    return err({ kind: "language-server", code: "capacity-exceeded" });
  }
  const parsed: LanguageServerRegisteredCapability[] = [];
  for (const entry of registrations) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      return err({
        kind: "language-server",
        code: "invalid-request",
        reason: "invalid-capability",
      });
    }
    const record = entry as Record<string, unknown>;
    if (typeof record.id !== "string" || record.id.length === 0 || record.id.includes("\0")) {
      return err({
        kind: "language-server",
        code: "invalid-request",
        reason: "invalid-capability",
      });
    }
    if (
      typeof record.method !== "string" ||
      record.method.length === 0 ||
      record.method.includes("\0")
    ) {
      return err({
        kind: "language-server",
        code: "invalid-request",
        reason: "invalid-capability",
      });
    }
    parsed.push({
      id: record.id,
      method: record.method,
      registerOptions: record.registerOptions ?? null,
    });
  }
  return ok(parsed);
}

export function parseUnregisterCapabilityParams(
  params: unknown,
): Result<readonly string[], LanguageServerSyncError> {
  if (typeof params !== "object" || params === null || Array.isArray(params)) {
    return err({
      kind: "language-server",
      code: "invalid-request",
      reason: "invalid-capability",
    });
  }
  const unregisterations = (params as { unregisterations?: unknown }).unregisterations;
  if (!Array.isArray(unregisterations) || unregisterations.length === 0) {
    return err({
      kind: "language-server",
      code: "invalid-request",
      reason: "invalid-capability",
    });
  }
  const ids: string[] = [];
  for (const entry of unregisterations) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      return err({
        kind: "language-server",
        code: "invalid-request",
        reason: "invalid-capability",
      });
    }
    const id = (entry as { id?: unknown }).id;
    if (typeof id !== "string" || id.length === 0) {
      return err({
        kind: "language-server",
        code: "invalid-request",
        reason: "invalid-capability",
      });
    }
    ids.push(id);
  }
  return ok(ids);
}
