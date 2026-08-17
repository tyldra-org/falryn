/**
 * Language-server feature requests (#91).
 *
 * Diagnostics, hover, definition, references, document symbols, and completion
 * normalize into Falryn-owned shapes. Code actions, rename, format, and
 * workspace edits remain #92; indexes remain #93.
 */

import { validateDocumentUri } from "./language-server-sync.ts";
import { err, ok, type Result } from "./result.ts";

export const MAX_LANGUAGE_SERVER_DIAGNOSTICS = 2_048;
export const MAX_LANGUAGE_SERVER_LOCATIONS = 512;
export const MAX_LANGUAGE_SERVER_SYMBOLS = 2_048;
export const MAX_LANGUAGE_SERVER_COMPLETION_ITEMS = 512;
export const MAX_LANGUAGE_SERVER_HOVER_CHARS = 32_768;
export const MAX_LANGUAGE_SERVER_DIAGNOSTIC_MESSAGE_CHARS = 4_096;
export const MAX_LANGUAGE_SERVER_COMPLETION_LABEL_CHARS = 512;

export type LanguageServerPosition = {
  readonly line: number;
  readonly character: number;
};

export type LanguageServerRange = {
  readonly start: LanguageServerPosition;
  readonly end: LanguageServerPosition;
};

export type LanguageServerLocation = {
  readonly uri: string;
  readonly range: LanguageServerRange;
};

export type LanguageServerLocationLink = {
  readonly targetUri: string;
  readonly targetRange: LanguageServerRange;
  readonly targetSelectionRange: LanguageServerRange;
  readonly originSelectionRange?: LanguageServerRange | undefined;
};

export type LanguageServerDiagnosticSeverity = 1 | 2 | 3 | 4;

export type LanguageServerDiagnostic = {
  readonly range: LanguageServerRange;
  readonly message: string;
  readonly severity?: LanguageServerDiagnosticSeverity | undefined;
  readonly code?: string | number | undefined;
  readonly source?: string | undefined;
  readonly tags?: readonly number[] | undefined;
};

export type LanguageServerPublishDiagnostics = {
  readonly uri: string;
  readonly version: number | null;
  readonly diagnostics: readonly LanguageServerDiagnostic[];
};

export type LanguageServerMarkupContent = {
  readonly kind: "plaintext" | "markdown";
  readonly value: string;
};

export type LanguageServerHover = {
  readonly contents: LanguageServerMarkupContent;
  readonly range?: LanguageServerRange | undefined;
};

export type LanguageServerSymbolKind = number;

export type LanguageServerDocumentSymbol = {
  readonly name: string;
  readonly kind: LanguageServerSymbolKind;
  readonly range: LanguageServerRange;
  readonly selectionRange: LanguageServerRange;
  readonly detail?: string | undefined;
  readonly children?: readonly LanguageServerDocumentSymbol[] | undefined;
};

export type LanguageServerSymbolInformation = {
  readonly name: string;
  readonly kind: LanguageServerSymbolKind;
  readonly location: LanguageServerLocation;
  readonly containerName?: string | undefined;
};

export type LanguageServerSymbols =
  | { readonly kind: "document"; readonly symbols: readonly LanguageServerDocumentSymbol[] }
  | { readonly kind: "information"; readonly symbols: readonly LanguageServerSymbolInformation[] };

export type LanguageServerCompletionItem = {
  readonly label: string;
  readonly kind?: number | undefined;
  readonly detail?: string | undefined;
  readonly documentation?: LanguageServerMarkupContent | string | undefined;
  readonly insertText?: string | undefined;
  readonly sortText?: string | undefined;
  readonly filterText?: string | undefined;
};

export type LanguageServerCompletionList = {
  readonly isIncomplete: boolean;
  readonly items: readonly LanguageServerCompletionItem[];
};

export type LanguageServerTextDocumentPosition = {
  readonly uri: string;
  readonly position: LanguageServerPosition;
};

export type LanguageServerReferencesRequest = LanguageServerTextDocumentPosition & {
  readonly includeDeclaration: boolean;
};

export type LanguageServerDocumentSymbolsRequest = {
  readonly uri: string;
};

export type LanguageServerFeatureValidationReason =
  | "invalid-uri"
  | "invalid-position"
  | "invalid-range"
  | "invalid-diagnostic"
  | "invalid-hover"
  | "invalid-location"
  | "invalid-symbol"
  | "invalid-completion"
  | "result-too-large";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function validatePosition(
  value: unknown,
): Result<LanguageServerPosition, LanguageServerFeatureValidationReason> {
  if (!isRecord(value)) {
    return err("invalid-position");
  }
  const { line, character } = value;
  if (
    typeof line !== "number" ||
    !Number.isInteger(line) ||
    line < 0 ||
    typeof character !== "number" ||
    !Number.isInteger(character) ||
    character < 0
  ) {
    return err("invalid-position");
  }
  return ok({ line, character });
}

export function validateRange(
  value: unknown,
): Result<LanguageServerRange, LanguageServerFeatureValidationReason> {
  if (!isRecord(value)) {
    return err("invalid-range");
  }
  const start = validatePosition(value.start);
  if (!start.ok) {
    return start;
  }
  const end = validatePosition(value.end);
  if (!end.ok) {
    return end;
  }
  return ok({ start: start.value, end: end.value });
}

export function validateTextDocumentPosition(
  request: LanguageServerTextDocumentPosition,
): LanguageServerFeatureValidationReason | null {
  const uriInvalid = validateDocumentUri(request.uri);
  if (uriInvalid !== null) {
    return "invalid-uri";
  }
  const position = validatePosition(request.position);
  return position.ok ? null : position.error;
}

export function parseLocation(
  value: unknown,
): Result<LanguageServerLocation, LanguageServerFeatureValidationReason> {
  if (!isRecord(value) || typeof value.uri !== "string") {
    return err("invalid-location");
  }
  if (validateDocumentUri(value.uri) !== null) {
    return err("invalid-uri");
  }
  const range = validateRange(value.range);
  if (!range.ok) {
    return err("invalid-location");
  }
  return ok({ uri: value.uri, range: range.value });
}

export function parseLocationLink(
  value: unknown,
): Result<LanguageServerLocationLink, LanguageServerFeatureValidationReason> {
  if (!isRecord(value) || typeof value.targetUri !== "string") {
    return err("invalid-location");
  }
  if (validateDocumentUri(value.targetUri) !== null) {
    return err("invalid-uri");
  }
  const targetRange = validateRange(value.targetRange);
  if (!targetRange.ok) {
    return err("invalid-location");
  }
  const targetSelectionRange = validateRange(value.targetSelectionRange);
  if (!targetSelectionRange.ok) {
    return err("invalid-location");
  }
  let originSelectionRange: LanguageServerRange | undefined;
  if (value.originSelectionRange !== undefined) {
    const origin = validateRange(value.originSelectionRange);
    if (!origin.ok) {
      return err("invalid-location");
    }
    originSelectionRange = origin.value;
  }
  return ok({
    targetUri: value.targetUri,
    targetRange: targetRange.value,
    targetSelectionRange: targetSelectionRange.value,
    ...(originSelectionRange === undefined ? {} : { originSelectionRange }),
  });
}

function parseMarkup(
  value: unknown,
): Result<LanguageServerMarkupContent, LanguageServerFeatureValidationReason> {
  if (typeof value === "string") {
    if (value.length > MAX_LANGUAGE_SERVER_HOVER_CHARS) {
      return err("result-too-large");
    }
    return ok({ kind: "plaintext", value });
  }
  if (!isRecord(value) || (value.kind !== "plaintext" && value.kind !== "markdown")) {
    return err("invalid-hover");
  }
  if (typeof value.value !== "string") {
    return err("invalid-hover");
  }
  if (value.value.length > MAX_LANGUAGE_SERVER_HOVER_CHARS) {
    return err("result-too-large");
  }
  return ok({ kind: value.kind, value: value.value });
}

export function parseHover(
  value: unknown,
): Result<LanguageServerHover | null, LanguageServerFeatureValidationReason> {
  if (value === null) {
    return ok(null);
  }
  if (!isRecord(value)) {
    return err("invalid-hover");
  }
  let contents: LanguageServerMarkupContent;
  if (Array.isArray(value.contents)) {
    if (value.contents.length === 0) {
      return ok(null);
    }
    const parts: string[] = [];
    let kind: "plaintext" | "markdown" = "plaintext";
    for (const part of value.contents) {
      const parsed = parseMarkup(part);
      if (!parsed.ok) {
        return parsed;
      }
      if (parsed.value.kind === "markdown") {
        kind = "markdown";
      }
      parts.push(parsed.value.value);
    }
    const joined = parts.join("\n\n");
    if (joined.length > MAX_LANGUAGE_SERVER_HOVER_CHARS) {
      return err("result-too-large");
    }
    contents = { kind, value: joined };
  } else {
    const parsed = parseMarkup(value.contents);
    if (!parsed.ok) {
      return parsed;
    }
    contents = parsed.value;
  }
  let range: LanguageServerRange | undefined;
  if (value.range !== undefined) {
    const parsedRange = validateRange(value.range);
    if (!parsedRange.ok) {
      return err("invalid-hover");
    }
    range = parsedRange.value;
  }
  return ok({
    contents,
    ...(range === undefined ? {} : { range }),
  });
}

export function parseDefinitionResult(
  value: unknown,
): Result<
  readonly LanguageServerLocation[] | readonly LanguageServerLocationLink[],
  LanguageServerFeatureValidationReason
> {
  if (value === null) {
    return ok([]);
  }
  if (Array.isArray(value)) {
    if (value.length > MAX_LANGUAGE_SERVER_LOCATIONS) {
      return err("result-too-large");
    }
    if (value.length === 0) {
      return ok([]);
    }
    if (isRecord(value[0]) && "targetUri" in value[0]) {
      const links: LanguageServerLocationLink[] = [];
      for (const item of value) {
        const parsed = parseLocationLink(item);
        if (!parsed.ok) {
          return parsed;
        }
        links.push(parsed.value);
      }
      return ok(links);
    }
    const locations: LanguageServerLocation[] = [];
    for (const item of value) {
      const parsed = parseLocation(item);
      if (!parsed.ok) {
        return parsed;
      }
      locations.push(parsed.value);
    }
    return ok(locations);
  }
  if (isRecord(value) && "targetUri" in value) {
    const parsed = parseLocationLink(value);
    if (!parsed.ok) {
      return parsed;
    }
    return ok([parsed.value]);
  }
  const parsed = parseLocation(value);
  if (!parsed.ok) {
    return parsed;
  }
  return ok([parsed.value]);
}

export function parseReferencesResult(
  value: unknown,
): Result<readonly LanguageServerLocation[], LanguageServerFeatureValidationReason> {
  if (value === null) {
    return ok([]);
  }
  if (!Array.isArray(value)) {
    return err("invalid-location");
  }
  if (value.length > MAX_LANGUAGE_SERVER_LOCATIONS) {
    return err("result-too-large");
  }
  const locations: LanguageServerLocation[] = [];
  for (const item of value) {
    const parsed = parseLocation(item);
    if (!parsed.ok) {
      return parsed;
    }
    locations.push(parsed.value);
  }
  return ok(locations);
}

function parseDocumentSymbol(
  value: unknown,
  depth: number,
): Result<LanguageServerDocumentSymbol, LanguageServerFeatureValidationReason> {
  if (depth > 32 || !isRecord(value) || typeof value.name !== "string" || value.name.length === 0) {
    return err("invalid-symbol");
  }
  if (typeof value.kind !== "number" || !Number.isInteger(value.kind) || value.kind < 0) {
    return err("invalid-symbol");
  }
  const range = validateRange(value.range);
  if (!range.ok) {
    return err("invalid-symbol");
  }
  const selectionRange = validateRange(value.selectionRange);
  if (!selectionRange.ok) {
    return err("invalid-symbol");
  }
  let detail: string | undefined;
  if (value.detail !== undefined) {
    if (typeof value.detail !== "string") {
      return err("invalid-symbol");
    }
    detail = value.detail;
  }
  let children: LanguageServerDocumentSymbol[] | undefined;
  if (value.children !== undefined) {
    if (!Array.isArray(value.children)) {
      return err("invalid-symbol");
    }
    children = [];
    for (const child of value.children) {
      const parsed = parseDocumentSymbol(child, depth + 1);
      if (!parsed.ok) {
        return parsed;
      }
      children.push(parsed.value);
    }
  }
  return ok({
    name: value.name,
    kind: value.kind,
    range: range.value,
    selectionRange: selectionRange.value,
    ...(detail === undefined ? {} : { detail }),
    ...(children === undefined ? {} : { children }),
  });
}

function countDocumentSymbols(symbols: readonly LanguageServerDocumentSymbol[]): number {
  let count = 0;
  for (const symbol of symbols) {
    count += 1;
    if (symbol.children !== undefined) {
      count += countDocumentSymbols(symbol.children);
    }
  }
  return count;
}

export function parseDocumentSymbolsResult(
  value: unknown,
): Result<LanguageServerSymbols, LanguageServerFeatureValidationReason> {
  if (value === null) {
    return ok({ kind: "document", symbols: [] });
  }
  if (!Array.isArray(value)) {
    return err("invalid-symbol");
  }
  if (value.length === 0) {
    return ok({ kind: "document", symbols: [] });
  }
  if (isRecord(value[0]) && "location" in value[0]) {
    if (value.length > MAX_LANGUAGE_SERVER_SYMBOLS) {
      return err("result-too-large");
    }
    const symbols: LanguageServerSymbolInformation[] = [];
    for (const item of value) {
      if (!isRecord(item) || typeof item.name !== "string" || item.name.length === 0) {
        return err("invalid-symbol");
      }
      if (typeof item.kind !== "number" || !Number.isInteger(item.kind) || item.kind < 0) {
        return err("invalid-symbol");
      }
      const location = parseLocation(item.location);
      if (!location.ok) {
        return err("invalid-symbol");
      }
      let containerName: string | undefined;
      if (item.containerName !== undefined) {
        if (typeof item.containerName !== "string") {
          return err("invalid-symbol");
        }
        containerName = item.containerName;
      }
      symbols.push({
        name: item.name,
        kind: item.kind,
        location: location.value,
        ...(containerName === undefined ? {} : { containerName }),
      });
    }
    return ok({ kind: "information", symbols });
  }
  const symbols: LanguageServerDocumentSymbol[] = [];
  for (const item of value) {
    const parsed = parseDocumentSymbol(item, 0);
    if (!parsed.ok) {
      return parsed;
    }
    symbols.push(parsed.value);
  }
  if (countDocumentSymbols(symbols) > MAX_LANGUAGE_SERVER_SYMBOLS) {
    return err("result-too-large");
  }
  return ok({ kind: "document", symbols });
}

function parseCompletionItem(
  value: unknown,
): Result<LanguageServerCompletionItem, LanguageServerFeatureValidationReason> {
  if (!isRecord(value) || typeof value.label !== "string" || value.label.length === 0) {
    return err("invalid-completion");
  }
  if (value.label.length > MAX_LANGUAGE_SERVER_COMPLETION_LABEL_CHARS) {
    return err("result-too-large");
  }
  const item: {
    label: string;
    kind?: number;
    detail?: string;
    documentation?: LanguageServerMarkupContent | string;
    insertText?: string;
    sortText?: string;
    filterText?: string;
  } = { label: value.label };
  if (value.kind !== undefined) {
    if (typeof value.kind !== "number" || !Number.isInteger(value.kind)) {
      return err("invalid-completion");
    }
    item.kind = value.kind;
  }
  if (value.detail !== undefined) {
    if (typeof value.detail !== "string") {
      return err("invalid-completion");
    }
    item.detail = value.detail;
  }
  if (value.documentation !== undefined) {
    if (typeof value.documentation === "string") {
      item.documentation = value.documentation;
    } else {
      const markup = parseMarkup(value.documentation);
      if (!markup.ok) {
        return err("invalid-completion");
      }
      item.documentation = markup.value;
    }
  }
  if (value.insertText !== undefined) {
    if (typeof value.insertText !== "string") {
      return err("invalid-completion");
    }
    item.insertText = value.insertText;
  }
  if (value.sortText !== undefined) {
    if (typeof value.sortText !== "string") {
      return err("invalid-completion");
    }
    item.sortText = value.sortText;
  }
  if (value.filterText !== undefined) {
    if (typeof value.filterText !== "string") {
      return err("invalid-completion");
    }
    item.filterText = value.filterText;
  }
  return ok(item);
}

export function parseCompletionResult(
  value: unknown,
): Result<LanguageServerCompletionList, LanguageServerFeatureValidationReason> {
  if (value === null) {
    return ok({ isIncomplete: false, items: [] });
  }
  if (Array.isArray(value)) {
    if (value.length > MAX_LANGUAGE_SERVER_COMPLETION_ITEMS) {
      return err("result-too-large");
    }
    const items: LanguageServerCompletionItem[] = [];
    for (const item of value) {
      const parsed = parseCompletionItem(item);
      if (!parsed.ok) {
        return parsed;
      }
      items.push(parsed.value);
    }
    return ok({ isIncomplete: false, items });
  }
  if (!isRecord(value) || !Array.isArray(value.items)) {
    return err("invalid-completion");
  }
  if (value.items.length > MAX_LANGUAGE_SERVER_COMPLETION_ITEMS) {
    return err("result-too-large");
  }
  const isIncomplete = value.isIncomplete === true;
  const items: LanguageServerCompletionItem[] = [];
  for (const item of value.items) {
    const parsed = parseCompletionItem(item);
    if (!parsed.ok) {
      return parsed;
    }
    items.push(parsed.value);
  }
  return ok({ isIncomplete, items });
}

export function parsePublishDiagnostics(
  params: unknown,
): Result<LanguageServerPublishDiagnostics, LanguageServerFeatureValidationReason> {
  if (!isRecord(params) || typeof params.uri !== "string") {
    return err("invalid-uri");
  }
  if (validateDocumentUri(params.uri) !== null) {
    return err("invalid-uri");
  }
  if (!Array.isArray(params.diagnostics)) {
    return err("invalid-diagnostic");
  }
  if (params.diagnostics.length > MAX_LANGUAGE_SERVER_DIAGNOSTICS) {
    return err("result-too-large");
  }
  let version: number | null = null;
  if (params.version !== undefined && params.version !== null) {
    if (
      typeof params.version !== "number" ||
      !Number.isInteger(params.version) ||
      params.version < 0
    ) {
      return err("invalid-diagnostic");
    }
    version = params.version;
  }
  const diagnostics: LanguageServerDiagnostic[] = [];
  for (const item of params.diagnostics) {
    if (!isRecord(item) || typeof item.message !== "string") {
      return err("invalid-diagnostic");
    }
    if (item.message.length > MAX_LANGUAGE_SERVER_DIAGNOSTIC_MESSAGE_CHARS) {
      return err("result-too-large");
    }
    const range = validateRange(item.range);
    if (!range.ok) {
      return err("invalid-diagnostic");
    }
    const diagnostic: {
      range: LanguageServerRange;
      message: string;
      severity?: LanguageServerDiagnosticSeverity;
      code?: string | number;
      source?: string;
      tags?: number[];
    } = { range: range.value, message: item.message };
    if (item.severity !== undefined) {
      if (
        item.severity !== 1 &&
        item.severity !== 2 &&
        item.severity !== 3 &&
        item.severity !== 4
      ) {
        return err("invalid-diagnostic");
      }
      diagnostic.severity = item.severity;
    }
    if (item.code !== undefined) {
      if (typeof item.code !== "string" && typeof item.code !== "number") {
        return err("invalid-diagnostic");
      }
      diagnostic.code = item.code;
    }
    if (item.source !== undefined) {
      if (typeof item.source !== "string") {
        return err("invalid-diagnostic");
      }
      diagnostic.source = item.source;
    }
    if (item.tags !== undefined) {
      if (!Array.isArray(item.tags) || !item.tags.every((tag) => typeof tag === "number")) {
        return err("invalid-diagnostic");
      }
      diagnostic.tags = item.tags;
    }
    diagnostics.push(diagnostic);
  }
  return ok({ uri: params.uri, version, diagnostics });
}
