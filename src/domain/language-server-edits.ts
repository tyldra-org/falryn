/**
 * Language-server edits as Falryn patches (#92).
 *
 * Format, rename, and code-action workspace edits normalize into previewable
 * patch plans. Embedded commands are recorded but never executed during
 * preview. Indexes remain #93.
 */

import {
  type LanguageServerPosition,
  type LanguageServerRange,
  validateRange,
  validateTextDocumentPosition,
} from "./language-server-features.ts";
import { type LanguageServerOpenDocument, validateDocumentUri } from "./language-server-sync.ts";
import { err, ok, type Result } from "./result.ts";
import {
  DEFAULT_PATCH_LIMITS,
  type ParsedPatchHunk,
  type ParsedPatchPlan,
  type ParsedPatchTarget,
} from "./workspace-patch.ts";
import { splitLines } from "./workspace-read.ts";

export const MAX_LANGUAGE_SERVER_TEXT_EDITS = 2_048;
export const MAX_LANGUAGE_SERVER_CODE_ACTIONS = 256;
export const MAX_LANGUAGE_SERVER_EDIT_URIS = 64;

export type LanguageServerTextEdit = {
  readonly range: LanguageServerRange;
  readonly newText: string;
};

export type LanguageServerVersionedTextDocumentId = {
  readonly uri: string;
  readonly version: number | null;
};

export type LanguageServerTextDocumentEdit = {
  readonly textDocument: LanguageServerVersionedTextDocumentId;
  readonly edits: readonly LanguageServerTextEdit[];
};

export type LanguageServerWorkspaceEdit = {
  readonly documentEdits: readonly LanguageServerTextDocumentEdit[];
};

export type LanguageServerCodeActionCommand = {
  readonly title: string;
  readonly command: string;
  readonly arguments?: readonly unknown[] | undefined;
};

export type LanguageServerCodeAction = {
  readonly title: string;
  readonly kind?: string | undefined;
  readonly isPreferred?: boolean | undefined;
  readonly edit?: LanguageServerWorkspaceEdit | undefined;
  readonly command?: LanguageServerCodeActionCommand | undefined;
};

export type LanguageServerCodeActionResult =
  | { readonly kind: "actions"; readonly actions: readonly LanguageServerCodeAction[] }
  | { readonly kind: "commands"; readonly commands: readonly LanguageServerCodeActionCommand[] };

export type LanguageServerFormatRequest = {
  readonly uri: string;
  readonly tabSize?: number | undefined;
  readonly insertSpaces?: boolean | undefined;
};

export type LanguageServerRenameRequest = {
  readonly uri: string;
  readonly position: LanguageServerPosition;
  readonly newName: string;
};

export type LanguageServerCodeActionsRequest = {
  readonly uri: string;
  readonly range: LanguageServerRange;
  readonly only?: readonly string[] | undefined;
};

export type LanguageServerEditToPatchResult = {
  readonly plan: ParsedPatchPlan;
  readonly deferredCommands: readonly LanguageServerCodeActionCommand[];
};

export type LanguageServerEditValidationReason =
  | "invalid-uri"
  | "invalid-position"
  | "invalid-range"
  | "invalid-edit"
  | "invalid-workspace-edit"
  | "invalid-code-action"
  | "invalid-rename"
  | "result-too-large"
  | "unsupported-resource-operation"
  | "overlapping-edits"
  | "path-outside-workspace";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseTextEdit(
  value: unknown,
): Result<LanguageServerTextEdit, LanguageServerEditValidationReason> {
  if (!isRecord(value) || typeof value.newText !== "string") {
    return err("invalid-edit");
  }
  const range = validateRange(value.range);
  if (!range.ok) {
    return err("invalid-edit");
  }
  return ok({ range: range.value, newText: value.newText });
}

export function parseTextEditArray(
  value: unknown,
): Result<readonly LanguageServerTextEdit[], LanguageServerEditValidationReason> {
  if (value === null) {
    return ok([]);
  }
  if (!Array.isArray(value)) {
    return err("invalid-edit");
  }
  if (value.length > MAX_LANGUAGE_SERVER_TEXT_EDITS) {
    return err("result-too-large");
  }
  const edits: LanguageServerTextEdit[] = [];
  for (const item of value) {
    const parsed = parseTextEdit(item);
    if (!parsed.ok) {
      return parsed;
    }
    edits.push(parsed.value);
  }
  return ok(edits);
}

function parseVersionedTextDocumentId(
  value: unknown,
): Result<LanguageServerVersionedTextDocumentId, LanguageServerEditValidationReason> {
  if (!isRecord(value) || typeof value.uri !== "string") {
    return err("invalid-workspace-edit");
  }
  if (validateDocumentUri(value.uri) !== null) {
    return err("invalid-uri");
  }
  let version: number | null = null;
  if (value.version !== undefined && value.version !== null) {
    if (
      typeof value.version !== "number" ||
      !Number.isInteger(value.version) ||
      value.version < 0
    ) {
      return err("invalid-workspace-edit");
    }
    version = value.version;
  }
  return ok({ uri: value.uri, version });
}

function parseTextDocumentEdit(
  value: unknown,
): Result<LanguageServerTextDocumentEdit, LanguageServerEditValidationReason> {
  if (!isRecord(value)) {
    return err("invalid-workspace-edit");
  }
  const textDocument = parseVersionedTextDocumentId(value.textDocument);
  if (!textDocument.ok) {
    return textDocument;
  }
  const edits = parseTextEditArray(value.edits);
  if (!edits.ok) {
    return edits;
  }
  return ok({ textDocument: textDocument.value, edits: edits.value });
}

export function parseWorkspaceEdit(
  value: unknown,
): Result<LanguageServerWorkspaceEdit | null, LanguageServerEditValidationReason> {
  if (value === null) {
    return ok(null);
  }
  if (!isRecord(value)) {
    return err("invalid-workspace-edit");
  }
  if (Array.isArray(value.documentChanges)) {
    if (value.documentChanges.length > MAX_LANGUAGE_SERVER_EDIT_URIS) {
      return err("result-too-large");
    }
    const documentEdits: LanguageServerTextDocumentEdit[] = [];
    for (const change of value.documentChanges) {
      if (!isRecord(change)) {
        return err("invalid-workspace-edit");
      }
      if (typeof change.kind === "string") {
        return err("unsupported-resource-operation");
      }
      const parsed = parseTextDocumentEdit(change);
      if (!parsed.ok) {
        return parsed;
      }
      documentEdits.push(parsed.value);
    }
    return ok({ documentEdits });
  }
  if (value.changes !== undefined) {
    if (!isRecord(value.changes)) {
      return err("invalid-workspace-edit");
    }
    const entries = Object.entries(value.changes);
    if (entries.length > MAX_LANGUAGE_SERVER_EDIT_URIS) {
      return err("result-too-large");
    }
    const documentEdits: LanguageServerTextDocumentEdit[] = [];
    for (const [uri, editsValue] of entries) {
      if (validateDocumentUri(uri) !== null) {
        return err("invalid-uri");
      }
      const edits = parseTextEditArray(editsValue);
      if (!edits.ok) {
        return edits;
      }
      documentEdits.push({
        textDocument: { uri, version: null },
        edits: edits.value,
      });
    }
    return ok({ documentEdits });
  }
  return ok({ documentEdits: [] });
}

function parseCommand(
  value: unknown,
): Result<LanguageServerCodeActionCommand, LanguageServerEditValidationReason> {
  if (!isRecord(value) || typeof value.title !== "string" || typeof value.command !== "string") {
    return err("invalid-code-action");
  }
  if (value.title.length === 0 || value.command.length === 0) {
    return err("invalid-code-action");
  }
  let args: readonly unknown[] | undefined;
  if (value.arguments !== undefined) {
    if (!Array.isArray(value.arguments)) {
      return err("invalid-code-action");
    }
    args = value.arguments;
  }
  return ok({
    title: value.title,
    command: value.command,
    ...(args === undefined ? {} : { arguments: args }),
  });
}

export function parseCodeActionResult(
  value: unknown,
): Result<LanguageServerCodeActionResult, LanguageServerEditValidationReason> {
  if (value === null) {
    return ok({ kind: "actions", actions: [] });
  }
  if (!Array.isArray(value)) {
    return err("invalid-code-action");
  }
  if (value.length > MAX_LANGUAGE_SERVER_CODE_ACTIONS) {
    return err("result-too-large");
  }
  if (value.length === 0) {
    return ok({ kind: "actions", actions: [] });
  }
  const first = value[0];
  if (
    isRecord(first) &&
    typeof first.command === "string" &&
    !("edit" in first) &&
    !("kind" in first) &&
    typeof first.title === "string"
  ) {
    // Ambiguous: Command vs CodeAction with only command. Prefer CodeAction shape when edit/kind present.
  }
  const looksLikeCommandsOnly = value.every(
    (item) =>
      isRecord(item) &&
      typeof item.command === "string" &&
      typeof item.title === "string" &&
      !("edit" in item) &&
      item.kind === undefined &&
      item.isPreferred === undefined,
  );
  if (looksLikeCommandsOnly) {
    const commands: LanguageServerCodeActionCommand[] = [];
    for (const item of value) {
      const parsed = parseCommand(item);
      if (!parsed.ok) {
        return parsed;
      }
      commands.push(parsed.value);
    }
    return ok({ kind: "commands", commands });
  }
  const actions: LanguageServerCodeAction[] = [];
  for (const item of value) {
    if (!isRecord(item) || typeof item.title !== "string" || item.title.length === 0) {
      return err("invalid-code-action");
    }
    let kind: string | undefined;
    if (item.kind !== undefined) {
      if (typeof item.kind !== "string") {
        return err("invalid-code-action");
      }
      kind = item.kind;
    }
    let isPreferred: boolean | undefined;
    if (item.isPreferred !== undefined) {
      if (typeof item.isPreferred !== "boolean") {
        return err("invalid-code-action");
      }
      isPreferred = item.isPreferred;
    }
    let edit: LanguageServerWorkspaceEdit | undefined;
    if (item.edit !== undefined) {
      const parsed = parseWorkspaceEdit(item.edit);
      if (!parsed.ok) {
        return parsed;
      }
      if (parsed.value !== null) {
        edit = parsed.value;
      }
    }
    let command: LanguageServerCodeActionCommand | undefined;
    if (item.command !== undefined) {
      const parsed = parseCommand(item.command);
      if (!parsed.ok) {
        return parsed;
      }
      command = parsed.value;
    }
    actions.push({
      title: item.title,
      ...(kind === undefined ? {} : { kind }),
      ...(isPreferred === undefined ? {} : { isPreferred }),
      ...(edit === undefined ? {} : { edit }),
      ...(command === undefined ? {} : { command }),
    });
  }
  return ok({ kind: "actions", actions });
}

export function validateFormatRequest(
  request: LanguageServerFormatRequest,
): LanguageServerEditValidationReason | null {
  const uriInvalid = validateDocumentUri(request.uri);
  if (uriInvalid !== null) {
    return "invalid-uri";
  }
  if (request.tabSize !== undefined) {
    if (
      typeof request.tabSize !== "number" ||
      !Number.isInteger(request.tabSize) ||
      request.tabSize < 1
    ) {
      return "invalid-edit";
    }
  }
  if (request.insertSpaces !== undefined && typeof request.insertSpaces !== "boolean") {
    return "invalid-edit";
  }
  return null;
}

export function validateRenameRequest(
  request: LanguageServerRenameRequest,
): LanguageServerEditValidationReason | null {
  const positionInvalid = validateTextDocumentPosition(request);
  if (positionInvalid === "invalid-uri") {
    return "invalid-uri";
  }
  if (positionInvalid === "invalid-position") {
    return "invalid-position";
  }
  if (positionInvalid !== null) {
    return "invalid-rename";
  }
  if (
    typeof request.newName !== "string" ||
    request.newName.length === 0 ||
    request.newName.length > 512
  ) {
    return "invalid-rename";
  }
  return null;
}

export function validateCodeActionsRequest(
  request: LanguageServerCodeActionsRequest,
): LanguageServerEditValidationReason | null {
  const uriInvalid = validateDocumentUri(request.uri);
  if (uriInvalid !== null) {
    return "invalid-uri";
  }
  const range = validateRange(request.range);
  if (!range.ok) {
    return "invalid-range";
  }
  if (request.only !== undefined) {
    if (!Array.isArray(request.only) || request.only.some((item) => typeof item !== "string")) {
      return "invalid-code-action";
    }
  }
  return null;
}

function offsetAt(text: string, position: LanguageServerPosition): number | null {
  let line = 0;
  let character = 0;
  let index = 0;
  while (index <= text.length) {
    if (line === position.line && character === position.character) {
      return index;
    }
    if (index >= text.length) {
      break;
    }
    const code = text.charCodeAt(index);
    if (code === 13 && text.charCodeAt(index + 1) === 10) {
      if (line === position.line) {
        return null;
      }
      line += 1;
      character = 0;
      index += 2;
      continue;
    }
    if (code === 10 || code === 13) {
      if (line === position.line) {
        return null;
      }
      line += 1;
      character = 0;
      index += 1;
      continue;
    }
    if (line === position.line) {
      character += 1;
    }
    index += 1;
  }
  return null;
}

function comparePositions(left: LanguageServerPosition, right: LanguageServerPosition): number {
  if (left.line !== right.line) {
    return left.line - right.line;
  }
  return left.character - right.character;
}

function rangesOverlap(left: LanguageServerRange, right: LanguageServerRange): boolean {
  return comparePositions(left.start, right.end) < 0 && comparePositions(right.start, left.end) < 0;
}

function applyTextEdits(
  text: string,
  edits: readonly LanguageServerTextEdit[],
): Result<string, LanguageServerEditValidationReason> {
  const ordered = [...edits].sort((left, right) => {
    const byStart = comparePositions(right.range.start, left.range.start);
    if (byStart !== 0) {
      return byStart;
    }
    return comparePositions(right.range.end, left.range.end);
  });
  for (let index = 0; index < edits.length; index += 1) {
    for (let other = index + 1; other < edits.length; other += 1) {
      const left = edits[index];
      const right = edits[other];
      if (left !== undefined && right !== undefined && rangesOverlap(left.range, right.range)) {
        return err("overlapping-edits");
      }
    }
  }
  let next = text;
  for (const edit of ordered) {
    const start = offsetAt(next, edit.range.start);
    const end = offsetAt(next, edit.range.end);
    if (start === null || end === null || end < start) {
      return err("invalid-edit");
    }
    next = `${next.slice(0, start)}${edit.newText}${next.slice(end)}`;
  }
  return ok(next);
}

export function fileUriToWorkspaceRelativePath(
  uri: string,
  workspaceFolderUris: readonly string[],
): Result<string, LanguageServerEditValidationReason> {
  if (!uri.startsWith("file://")) {
    return err("invalid-uri");
  }
  let path = decodeURIComponent(uri.slice("file://".length));
  if (path.startsWith("/") && /^\/[A-Za-z]:/.test(path)) {
    path = path.slice(1);
  }
  for (const folder of workspaceFolderUris) {
    if (!folder.startsWith("file://")) {
      continue;
    }
    let folderPath = decodeURIComponent(folder.slice("file://".length));
    if (folderPath.startsWith("/") && /^\/[A-Za-z]:/.test(folderPath)) {
      folderPath = folderPath.slice(1);
    }
    const prefix = folderPath.endsWith("/") ? folderPath : `${folderPath}/`;
    if (path === folderPath) {
      return err("path-outside-workspace");
    }
    if (path.startsWith(prefix)) {
      const relative = path.slice(prefix.length);
      if (
        relative.length === 0 ||
        relative.includes("\0") ||
        relative.startsWith("/") ||
        relative.includes("..")
      ) {
        return err("path-outside-workspace");
      }
      return ok(relative.replace(/\\/g, "/"));
    }
  }
  return err("path-outside-workspace");
}

export function workspaceEditToPatchPlan(
  edit: LanguageServerWorkspaceEdit,
  openDocuments: ReadonlyMap<string, LanguageServerOpenDocument>,
  workspaceFolderUris: readonly string[],
): Result<
  LanguageServerEditToPatchResult,
  LanguageServerEditValidationReason | "document-not-open" | "stale-document" | "capacity-exceeded"
> {
  if (edit.documentEdits.length === 0) {
    return ok({
      plan: {
        policy: "fail-before-effect",
        expectedPlanId: null,
        expectedGitHead: null,
        limits: DEFAULT_PATCH_LIMITS,
        targets: [],
      },
      deferredCommands: [],
    });
  }
  if (edit.documentEdits.length > DEFAULT_PATCH_LIMITS.maxTargets) {
    return err("capacity-exceeded");
  }
  const targets: ParsedPatchTarget[] = [];
  for (const [index, documentEdit] of edit.documentEdits.entries()) {
    const open = openDocuments.get(documentEdit.textDocument.uri);
    if (open === undefined) {
      return err("document-not-open");
    }
    if (
      documentEdit.textDocument.version !== null &&
      documentEdit.textDocument.version !== open.version
    ) {
      return err("stale-document");
    }
    const path = fileUriToWorkspaceRelativePath(documentEdit.textDocument.uri, workspaceFolderUris);
    if (!path.ok) {
      return path;
    }
    const nextText = applyTextEdits(open.text, documentEdit.edits);
    if (!nextText.ok) {
      return nextText;
    }
    const oldLines = splitLines(open.text);
    const newLines = splitLines(nextText.value);
    if (
      oldLines.length > DEFAULT_PATCH_LIMITS.maxHunkLines ||
      newLines.length > DEFAULT_PATCH_LIMITS.maxHunkLines
    ) {
      return err("capacity-exceeded");
    }
    const hunk: ParsedPatchHunk = {
      index: 0,
      oldStart: 1,
      oldLines,
      newLines,
    };
    targets.push({
      index,
      path: path.value,
      expectedDigest: null,
      expectedRevision:
        documentEdit.textDocument.version === null
          ? null
          : String(documentEdit.textDocument.version),
      hunks: [hunk],
    });
  }
  return ok({
    plan: {
      policy: "fail-before-effect",
      expectedPlanId: null,
      expectedGitHead: null,
      limits: DEFAULT_PATCH_LIMITS,
      targets,
    },
    deferredCommands: [],
  });
}

export function codeActionToPatchPlan(
  action: LanguageServerCodeAction,
  openDocuments: ReadonlyMap<string, LanguageServerOpenDocument>,
  workspaceFolderUris: readonly string[],
): Result<
  LanguageServerEditToPatchResult,
  | LanguageServerEditValidationReason
  | "document-not-open"
  | "stale-document"
  | "capacity-exceeded"
  | "invalid-code-action"
> {
  const deferredCommands = action.command === undefined ? [] : [action.command];
  if (action.edit === undefined) {
    if (deferredCommands.length === 0) {
      return err("invalid-code-action");
    }
    return ok({
      plan: {
        policy: "fail-before-effect",
        expectedPlanId: null,
        expectedGitHead: null,
        limits: DEFAULT_PATCH_LIMITS,
        targets: [],
      },
      deferredCommands,
    });
  }
  const converted = workspaceEditToPatchPlan(action.edit, openDocuments, workspaceFolderUris);
  if (!converted.ok) {
    return converted;
  }
  return ok({
    plan: converted.value.plan,
    deferredCommands,
  });
}
