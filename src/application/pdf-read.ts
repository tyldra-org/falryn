/**
 * Application boundary for the bounded PDF reader (#495).
 *
 * PDF bytes enter only through the injected workspace reader. Parsing is
 * deliberately local and bounded: it extracts page text and lightweight
 * metadata, never executes an embedded action, invokes OCR, or exposes raw
 * embedded media.
 */

import { createHash } from "node:crypto";
import { inflateSync } from "node:zlib";

import {
  type BoundWorkspacePath,
  type LocalPath,
  type NormalizedPdfReadRequest,
  type PdfAnnotationBlock,
  type PdfBlock,
  type PdfCoordinate,
  type PdfDiagnostic,
  type PdfDocument,
  type PdfExtractionMethod,
  type PdfImageBlock,
  type PdfLayoutConfidence,
  type PdfLinkBlock,
  type PdfOmission,
  type PdfPage,
  type PdfPageRange,
  type PdfRead,
  type PdfReadError,
  type PdfReadLimits,
  type PdfTableBlock,
  type PdfTextBlock,
  parsePdfReadRequest,
  type Result,
} from "../domain/index.ts";
import type { WorkspaceReader } from "./workspace-read.ts";

type PdfObject = {
  readonly number: number;
  readonly generation: number;
  readonly byteOffset: number;
  readonly body: string;
};

type ParsedPdf = {
  readonly bytes: Uint8Array;
  readonly format: {
    readonly major: number;
    readonly minor: number;
  };
  readonly objects: ReadonlyMap<number, PdfObject>;
  readonly pages: readonly PageDefinition[];
};

type PageDefinition = {
  readonly pageNumber: number;
  readonly object: PdfObject;
  readonly contentObjects: readonly PdfObject[];
  readonly annotationObjects: readonly PdfObject[];
  readonly resourceBody: string;
};

type TextSeed = {
  readonly coordinate: PdfCoordinate;
  readonly text: string;
};

type ImageSeed = {
  readonly coordinate: PdfCoordinate;
  readonly mimeType: string | null;
  readonly width: number | null;
  readonly height: number | null;
  readonly encodedBytes: number;
};

type LinkSeed = {
  readonly coordinate: PdfCoordinate;
  readonly uri: string;
  readonly rect: readonly number[] | null;
};

type AnnotationSeed = {
  readonly coordinate: PdfCoordinate;
  readonly subtype: string;
  readonly contents: string | null;
  readonly rect: readonly number[] | null;
};

type ExtractedPage = {
  readonly pageNumber: number;
  readonly pageObjectNumber: number;
  readonly text: string;
  readonly plainText: string;
  readonly tableRows: readonly (readonly string[])[];
  readonly textSeeds: readonly TextSeed[];
  readonly links: readonly LinkSeed[];
  readonly annotations: readonly AnnotationSeed[];
  readonly images: readonly ImageSeed[];
  readonly diagnostics: readonly PdfDiagnostic[];
  readonly extractionMethod: PdfExtractionMethod;
  readonly layoutConfidence: PdfLayoutConfidence;
  readonly ocrRequired: boolean;
};

type RenderBudget = {
  remainingBytes: number;
  stopReason: PdfRead["stopReason"];
};

type Selection = {
  readonly pages: readonly number[];
  readonly scannedPages: readonly number[];
  readonly omissions: readonly PdfOmission[];
  readonly recoveryRanges: readonly PdfPageRange[];
  emptyReason: "no-selected-pages" | "no-query-matches" | null;
};

type StreamFailure =
  | { readonly code: "unsupported-filter"; readonly filter: string }
  | {
      readonly code: "decompression-limit";
      readonly objectNumber: number;
      readonly compressedBytes: number;
      readonly maximumBytes: number;
    }
  | { readonly code: "malformed-content" };

type StreamResult =
  | { readonly ok: true; readonly bytes: Uint8Array }
  | { readonly ok: false; readonly error: StreamFailure };

export type PdfReader = {
  read(
    root: LocalPath,
    request: unknown,
    signal?: AbortSignal,
  ): Promise<
    | { readonly ok: true; readonly value: PdfRead }
    | { readonly ok: false; readonly error: PdfReadError }
  >;
};

function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

function latin1(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("latin1");
}

function bytesFromLatin1(value: string): Uint8Array {
  return Uint8Array.from(Buffer.from(value, "latin1"));
}

function byteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function digestFor(bytes: Uint8Array): string {
  return `sha-256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function truncateUtf8(
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

function objectDictionary(object: PdfObject): string {
  const start = object.body.indexOf("<<");
  const end = object.body.lastIndexOf(">>");
  return start >= 0 && end > start ? object.body.slice(start, end + 2) : object.body;
}

function objectType(dictionary: string): string | null {
  return /\/Type\s*\/([A-Za-z0-9]+)/.exec(dictionary)?.[1] ?? null;
}

function referenceAfter(dictionary: string, name: string): number | null {
  const match = new RegExp(`/${name}\\s+(\\d+)\\s+\\d+\\s+R`).exec(dictionary);
  const number = match?.[1];
  return number === undefined ? null : Number(number);
}

function referencesAfter(dictionary: string, name: string): readonly number[] {
  const array = new RegExp(`/${name}\\s*\\[([\\s\\S]*?)\\]`).exec(dictionary)?.[1];
  if (array === undefined) {
    return [];
  }
  return [...array.matchAll(/(\d+)\s+\d+\s+R/g)].map((match) => Number(match[1]));
}

function allReferences(value: string): readonly number[] {
  return [...value.matchAll(/(\d+)\s+\d+\s+R/g)].map((match) => Number(match[1]));
}

function directNumber(dictionary: string, name: string): number | null {
  const match = new RegExp(`/${name}\\s+(-?\\d+(?:\\.\\d+)?)\\b`).exec(dictionary);
  const value = match?.[1];
  return value === undefined ? null : Number(value);
}

function directName(dictionary: string, name: string): string | null {
  return new RegExp(`/${name}\\s*(?:\\[\\s*)?/([A-Za-z0-9+.-]+)`).exec(dictionary)?.[1] ?? null;
}

function inlineDictionary(dictionary: string, name: string): string | null {
  return new RegExp(`/${name}\\s*(<<[\\s\\S]*?>>)`).exec(dictionary)?.[1] ?? null;
}

function coordinate(page: PageDefinition, object: PdfObject | null): PdfCoordinate {
  return {
    pageNumber: page.pageNumber,
    objectNumber: object?.number ?? page.object.number,
    byteOffset: object?.byteOffset ?? page.object.byteOffset,
  };
}

function parseObjects(
  source: string,
  maximumObjects: number,
): Result<ReadonlyMap<number, PdfObject>, PdfReadError> {
  const objects = new Map<number, PdfObject>();
  const pattern = /(\d+)\s+(\d+)\s+obj\b/g;
  while (true) {
    const match = pattern.exec(source);
    if (match === null) {
      break;
    }
    if (objects.size >= maximumObjects) {
      return {
        ok: false,
        error: { code: "object-limit", count: objects.size + 1, maximum: maximumObjects },
      };
    }
    const number = Number(match[1]);
    const generation = Number(match[2]);
    const bodyStart = match.index + match[0].length;
    const bodyEnd = source.indexOf("endobj", bodyStart);
    if (bodyEnd < 0 || objects.has(number)) {
      return { ok: false, error: { code: "malformed-objects" } };
    }
    objects.set(number, {
      number,
      generation,
      byteOffset: match.index,
      body: source.slice(bodyStart, bodyEnd),
    });
    pattern.lastIndex = bodyEnd + "endobj".length;
  }
  return objects.size === 0
    ? { ok: false, error: { code: "malformed-objects" } }
    : { ok: true, value: objects };
}

function resourceBodyFor(
  dictionary: string,
  objects: ReadonlyMap<number, PdfObject>,
  inherited: string,
): string {
  const resourceObject = referenceAfter(dictionary, "Resources");
  if (resourceObject !== null) {
    const object = objects.get(resourceObject);
    if (object !== undefined) {
      return objectDictionary(object);
    }
  }
  return inlineDictionary(dictionary, "Resources") ?? inherited;
}

function pageContentObjects(
  dictionary: string,
  objects: ReadonlyMap<number, PdfObject>,
): readonly PdfObject[] {
  const references = [
    ...referencesAfter(dictionary, "Contents"),
    ...(referenceAfter(dictionary, "Contents") === null
      ? []
      : [referenceAfter(dictionary, "Contents") as number]),
  ];
  return references.flatMap((number) => {
    const object = objects.get(number);
    return object === undefined ? [] : [object];
  });
}

function pageAnnotationObjects(
  dictionary: string,
  objects: ReadonlyMap<number, PdfObject>,
): readonly PdfObject[] {
  const references = [
    ...referencesAfter(dictionary, "Annots"),
    ...(referenceAfter(dictionary, "Annots") === null
      ? []
      : [referenceAfter(dictionary, "Annots") as number]),
  ];
  return references.flatMap((number) => {
    const object = objects.get(number);
    if (object === undefined) {
      return [];
    }
    const nested = allReferences(object.body);
    return nested.length > 0 ? nested.flatMap((item) => objects.get(item) ?? []) : [object];
  });
}

function parsePages(
  objects: ReadonlyMap<number, PdfObject>,
): Result<readonly PageDefinition[], PdfReadError> {
  const pages: PageDefinition[] = [];
  const visited = new Set<number>();
  const catalogs = [...objects.values()].filter(
    (object) => objectType(objectDictionary(object)) === "Catalog",
  );
  const catalog = catalogs[0];
  const root = catalog === undefined ? null : referenceAfter(objectDictionary(catalog), "Pages");

  const visit = (number: number, inheritedResources: string): boolean => {
    if (visited.has(number)) {
      return false;
    }
    visited.add(number);
    const object = objects.get(number);
    if (object === undefined) {
      return false;
    }
    const dictionary = objectDictionary(object);
    const type = objectType(dictionary);
    const resources = resourceBodyFor(dictionary, objects, inheritedResources);
    if (type === "Page") {
      pages.push({
        pageNumber: pages.length + 1,
        object,
        contentObjects: pageContentObjects(dictionary, objects),
        annotationObjects: pageAnnotationObjects(dictionary, objects),
        resourceBody: resources,
      });
      return true;
    }
    if (type !== "Pages") {
      return false;
    }
    const kids = referencesAfter(dictionary, "Kids");
    if (kids.length === 0 && directNumber(dictionary, "Count") !== 0) {
      return false;
    }
    let found = true;
    for (const child of kids) {
      found = visit(child, resources) && found;
    }
    return found;
  };

  if (root !== null) {
    visit(root, "");
  }
  if (pages.length === 0) {
    for (const object of [...objects.values()].sort((left, right) => left.number - right.number)) {
      if (objectType(objectDictionary(object)) === "Page") {
        visit(object.number, "");
      }
    }
  }
  return pages.length === 0
    ? { ok: false, error: { code: "malformed-pages" } }
    : { ok: true, value: pages };
}

function parsePdf(bytes: Uint8Array, limits: PdfReadLimits): Result<ParsedPdf, PdfReadError> {
  const source = latin1(bytes);
  const header = /%PDF-(\d+)\.(\d+)/.exec(source.slice(0, 64));
  if (header === null) {
    return source.includes("%PDF-")
      ? { ok: false, error: { code: "malformed-header" } }
      : { ok: false, error: { code: "not-pdf" } };
  }
  const major = Number(header[1]);
  const minor = Number(header[2]);
  if (major !== 1 || minor > 7) {
    return { ok: false, error: { code: "unsupported-version", major, minor } };
  }
  if (/\/Encrypt\b/.test(source)) {
    return { ok: false, error: { code: "encrypted" } };
  }
  const objects = parseObjects(source, limits.maxObjects);
  if (!objects.ok) {
    return objects;
  }
  const pages = parsePages(objects.value);
  if (!pages.ok) {
    return pages;
  }
  return {
    ok: true,
    value: {
      bytes,
      format: { major, minor },
      objects: objects.value,
      pages: pages.value,
    },
  };
}

function parsePdfStringToken(token: string): string {
  const trimmed = token.trim();
  if (trimmed.startsWith("(") && trimmed.endsWith(")")) {
    return decodeLiteral(trimmed.slice(1, -1));
  }
  if (trimmed.startsWith("<") && trimmed.endsWith(">") && !trimmed.startsWith("<<")) {
    const hex = trimmed.slice(1, -1).replace(/\s/g, "");
    const normalized = hex.length % 2 === 0 ? hex : `${hex}0`;
    const bytes = Uint8Array.from(
      normalized.match(/.{2}/g)?.map((value) => Number.parseInt(value, 16)) ?? [],
    );
    return decodePdfBytes(bytes);
  }
  return "";
}

function decodePdfBytes(bytes: Uint8Array): string {
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    let value = "";
    for (let index = 2; index + 1 < bytes.length; index += 2) {
      const high = bytes[index];
      const low = bytes[index + 1];
      if (high === undefined || low === undefined) {
        break;
      }
      value += String.fromCharCode((high << 8) | low);
    }
    return value;
  }
  return Buffer.from(bytes).toString("latin1");
}

function decodeLiteral(value: string): string {
  const bytes: number[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (character !== "\\") {
      bytes.push(character?.charCodeAt(0) ?? 0);
      continue;
    }
    const escaped = value[index + 1];
    if (escaped === undefined) {
      break;
    }
    index += 1;
    const simple = new Map([
      ["n", 0x0a],
      ["r", 0x0d],
      ["t", 0x09],
      ["b", 0x08],
      ["f", 0x0c],
      ["(", 0x28],
      [")", 0x29],
      ["\\", 0x5c],
    ]);
    const simpleValue = simple.get(escaped);
    if (simpleValue !== undefined) {
      bytes.push(simpleValue);
      continue;
    }
    if (/[0-7]/.test(escaped)) {
      const octal = `${escaped}${value[index + 1] ?? ""}${value[index + 2] ?? ""}`.match(
        /^[0-7]{1,3}/,
      )?.[0];
      if (octal !== undefined) {
        bytes.push(Number.parseInt(octal, 8));
        index += octal.length - 1;
        continue;
      }
    }
    bytes.push(escaped.charCodeAt(0));
  }
  return decodePdfBytes(Uint8Array.from(bytes));
}

function pdfStrings(value: string): readonly string[] {
  const values: string[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (character === "(") {
      let depth = 1;
      let escaped = false;
      let end = index + 1;
      for (; end < value.length; end += 1) {
        const current = value[end];
        if (escaped) {
          escaped = false;
          continue;
        }
        if (current === "\\") {
          escaped = true;
          continue;
        }
        if (current === "(") {
          depth += 1;
        } else if (current === ")") {
          depth -= 1;
          if (depth === 0) {
            break;
          }
        }
      }
      if (depth !== 0) {
        break;
      }
      values.push(decodeLiteral(value.slice(index + 1, end)));
      index = end;
      continue;
    }
    if (character === "<" && value[index + 1] !== "<") {
      const end = value.indexOf(">", index + 1);
      if (end < 0) {
        break;
      }
      values.push(parsePdfStringToken(value.slice(index, end + 1)));
      index = end;
    }
  }
  return values;
}

function streamData(
  object: PdfObject,
  limits: PdfReadLimits,
): { readonly raw: Uint8Array; readonly filter: string | null } | null {
  const dictionary = objectDictionary(object);
  const streamIndex = object.body.indexOf("stream");
  if (streamIndex < 0) {
    return null;
  }
  let start = streamIndex + "stream".length;
  if (object.body[start] === "\r" && object.body[start + 1] === "\n") {
    start += 2;
  } else if (object.body[start] === "\r" || object.body[start] === "\n") {
    start += 1;
  }
  const declaredLength = directNumber(dictionary, "Length");
  const declaredEnd =
    declaredLength !== null && declaredLength >= 0 && start + declaredLength <= object.body.length
      ? start + declaredLength
      : -1;
  const end =
    declaredEnd >= 0
      ? declaredEnd
      : object.body.indexOf("endstream", start) >= 0
        ? object.body.indexOf("endstream", start)
        : object.body.length;
  const raw = bytesFromLatin1(object.body.slice(start, end));
  if (raw.length > limits.maxDecompressedBytes) {
    return { raw, filter: "__oversized__" };
  }
  return { raw, filter: directName(dictionary, "Filter") };
}

function expandedStream(object: PdfObject, limits: PdfReadLimits): StreamResult {
  const stream = streamData(object, limits);
  if (stream === null) {
    return { ok: false, error: { code: "malformed-content" } };
  }
  if (stream.filter === "__oversized__") {
    return {
      ok: false,
      error: {
        code: "decompression-limit",
        objectNumber: object.number,
        compressedBytes: stream.raw.byteLength,
        maximumBytes: limits.maxDecompressedBytes,
      },
    };
  }
  if (stream.filter === null) {
    return { ok: true, bytes: stream.raw };
  }
  if (stream.filter !== "FlateDecode") {
    return { ok: false, error: { code: "unsupported-filter", filter: stream.filter } };
  }
  const ratioMaximum = Math.max(
    stream.raw.byteLength,
    stream.raw.byteLength * limits.maxDecompressionRatio,
  );
  const maximumBytes = Math.min(limits.maxDecompressedBytes, ratioMaximum);
  try {
    const expanded = inflateSync(stream.raw, { maxOutputLength: maximumBytes });
    if (expanded.byteLength > maximumBytes) {
      return {
        ok: false,
        error: {
          code: "decompression-limit",
          objectNumber: object.number,
          compressedBytes: stream.raw.byteLength,
          maximumBytes,
        },
      };
    }
    return { ok: true, bytes: new Uint8Array(expanded) };
  } catch {
    return {
      ok: false,
      error: {
        code: "decompression-limit",
        objectNumber: object.number,
        compressedBytes: stream.raw.byteLength,
        maximumBytes,
      },
    };
  }
}

function extractText(bytes: Uint8Array): string {
  const source = latin1(bytes);
  const segments = [...source.matchAll(/\bBT\b([\s\S]*?)\bET\b/g)].map((match) => match[1] ?? "");
  const candidates = segments.length > 0 ? segments : /(?:Tj|TJ)\b/.test(source) ? [source] : [];
  return candidates
    .map((segment) => pdfStrings(segment).join(" "))
    .join("\n")
    .replaceAll("\r", "\n")
    .replace(/[ \t]+/g, " ")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .join("\n");
}

function tableRowsFor(text: string): readonly (readonly string[])[] {
  return text
    .split("\n")
    .map((line) =>
      line.includes("|")
        ? line
            .split("|")
            .map((cell) => cell.trim())
            .filter((cell) => cell.length > 0)
        : line
            .split("\t")
            .map((cell) => cell.trim())
            .filter((cell) => cell.length > 0),
    )
    .filter((row) => row.length >= 2)
    .filter(
      (row, index, rows) =>
        rows[index - 1]?.length === row.length || rows[index + 1]?.length === row.length,
    )
    .slice(0, 128);
}

function textWithoutTables(text: string, rows: readonly (readonly string[])[]): string {
  if (rows.length === 0) {
    return text;
  }
  const tableLines = new Set(
    text.split("\n").filter((line) => line.includes("|") || line.includes("\t")),
  );
  return text
    .split("\n")
    .filter((line) => !tableLines.has(line))
    .join("\n");
}

function rectFor(dictionary: string): readonly number[] | null {
  const body = /\/Rect\s*\[([^\]]*)\]/.exec(dictionary)?.[1];
  if (body === undefined) {
    return null;
  }
  const values = body
    .trim()
    .split(/\s+/)
    .filter((value) => value.length > 0)
    .map(Number);
  return values.length === 4 && values.every((value) => Number.isFinite(value)) ? values : null;
}

function tokenAfter(dictionary: string, name: string): string | null {
  const match = new RegExp(`/${name}\\s+(\\([^\\n]*?\\)|<[^>]*>)`).exec(dictionary);
  return match?.[1] === undefined ? null : parsePdfStringToken(match[1]);
}

function imageSeedsFor(
  page: PageDefinition,
  objects: ReadonlyMap<number, PdfObject>,
  limits: PdfReadLimits,
): readonly ImageSeed[] {
  const xObjectBody = /\/XObject\s*(<<[\s\S]*?>>)/.exec(page.resourceBody)?.[1];
  if (xObjectBody === undefined) {
    return [];
  }
  return [...xObjectBody.matchAll(/\/[^\s/]+\s+(\d+)\s+\d+\s+R/g)].flatMap((match) => {
    const objectNumber = Number(match[1]);
    const object = objects.get(objectNumber);
    if (object === undefined || objectType(objectDictionary(object)) !== "XObject") {
      return [];
    }
    const dictionary = objectDictionary(object);
    if (directName(dictionary, "Subtype") !== "Image") {
      return [];
    }
    const filter = directName(dictionary, "Filter");
    const mimeType =
      filter === "DCTDecode" ? "image/jpeg" : filter === "JPXDecode" ? "image/jp2" : null;
    const stream = streamData(object, limits);
    return [
      {
        coordinate: coordinate(page, object),
        mimeType,
        width: directNumber(dictionary, "Width"),
        height: directNumber(dictionary, "Height"),
        encodedBytes: stream?.raw.byteLength ?? 0,
      },
    ];
  });
}

function annotationSeedsFor(page: PageDefinition): {
  readonly links: readonly LinkSeed[];
  readonly annotations: readonly AnnotationSeed[];
} {
  const links: LinkSeed[] = [];
  const annotations: AnnotationSeed[] = [];
  for (const object of page.annotationObjects) {
    const dictionary = objectDictionary(object);
    const subtype = directName(dictionary, "Subtype") ?? "Unknown";
    const base = {
      coordinate: coordinate(page, object),
      rect: rectFor(dictionary),
    };
    const uri = tokenAfter(dictionary, "URI");
    if (subtype === "Link" && uri !== null && uri.length > 0) {
      links.push({ ...base, uri });
      continue;
    }
    annotations.push({
      ...base,
      subtype,
      contents: tokenAfter(dictionary, "Contents"),
    });
  }
  return { links, annotations };
}

function diagnostic(
  code: PdfDiagnostic["code"],
  page: PageDefinition,
  object: PdfObject | null = null,
): PdfDiagnostic {
  return { code, coordinate: coordinate(page, object) };
}

function extractPage(page: PageDefinition, pdf: ParsedPdf, limits: PdfReadLimits): ExtractedPage {
  const diagnostics: PdfDiagnostic[] = [];
  const textSeeds: TextSeed[] = [];
  for (const object of page.contentObjects) {
    const expanded = expandedStream(object, limits);
    if (!expanded.ok) {
      diagnostics.push(diagnostic(expanded.error.code, page, object));
      continue;
    }
    const text = extractText(expanded.bytes);
    if (text !== "") {
      textSeeds.push({ coordinate: coordinate(page, object), text });
    }
  }
  const text = textSeeds.map((seed) => seed.text).join("\n");
  const tableRows = tableRowsFor(text);
  const plainText = textWithoutTables(text, tableRows);
  const annotationSeeds = annotationSeedsFor(page);
  const images = imageSeedsFor(page, pdf.objects, limits);
  const ocrRequired = text.trim() === "" && images.length > 0;
  if (ocrRequired) {
    diagnostics.push(diagnostic("image-only", page));
    diagnostics.push(diagnostic("ocr-required", page));
  }
  const extractionMethod: PdfExtractionMethod =
    text.trim() === "" ? (ocrRequired ? "ocr-required" : "none") : "text";
  const layoutConfidence: PdfLayoutConfidence =
    extractionMethod === "none"
      ? "unknown"
      : diagnostics.length > 0
        ? "low"
        : tableRows.length > 0
          ? "medium"
          : "high";
  return {
    pageNumber: page.pageNumber,
    pageObjectNumber: page.object.number,
    text,
    plainText,
    tableRows,
    textSeeds,
    links: annotationSeeds.links,
    annotations: annotationSeeds.annotations,
    images,
    diagnostics,
    extractionMethod,
    layoutConfidence,
    ocrRequired,
  };
}

function addDiagnosticIfMissing(
  diagnostics: PdfDiagnostic[],
  code: PdfDiagnostic["code"],
  page: PageDefinition,
): void {
  if (!diagnostics.some((item) => item.code === code)) {
    diagnostics.push(diagnostic(code, page));
  }
}

function renderTable(
  rows: readonly (readonly string[])[],
  coordinateValue: PdfCoordinate,
  budget: { remaining: number },
): { readonly block: PdfTableBlock | null; readonly truncated: boolean } {
  const admitted: (readonly string[])[] = [];
  let used = 0;
  for (const row of rows) {
    const rowBytes = byteLength(JSON.stringify(row));
    if (used + rowBytes > budget.remaining) {
      break;
    }
    admitted.push(row);
    used += rowBytes;
  }
  budget.remaining -= used;
  return {
    block:
      admitted.length === 0
        ? null
        : {
            kind: "table",
            coordinate: coordinateValue,
            rows: admitted,
            truncated: admitted.length < rows.length,
          },
    truncated: admitted.length < rows.length,
  };
}

function renderPage(
  extracted: ExtractedPage,
  page: PageDefinition,
  state: RenderBudget,
  limits: PdfReadLimits,
): PdfPage {
  const diagnostics = [...extracted.diagnostics];
  const blocks: PdfBlock[] = [];
  let pageRemaining = limits.maxPageOutputBytes;
  let truncated = false;
  const firstText = extracted.textSeeds[0];

  if (extracted.tableRows.length > 0 && firstText !== undefined) {
    const table = renderTable(extracted.tableRows, firstText.coordinate, {
      get remaining() {
        return Math.min(pageRemaining, state.remainingBytes);
      },
      set remaining(value: number) {
        const consumed = Math.min(pageRemaining, state.remainingBytes) - value;
        pageRemaining -= consumed;
        state.remainingBytes -= consumed;
      },
    });
    if (table.block !== null) {
      blocks.push(table.block);
    }
    if (table.truncated) {
      truncated = true;
      addDiagnosticIfMissing(diagnostics, "huge-output", page);
    }
  }

  if (extracted.plainText !== "" && firstText !== undefined) {
    const available = Math.min(pageRemaining, state.remainingBytes);
    const rendered = truncateUtf8(extracted.plainText, available);
    pageRemaining -= byteLength(rendered.value);
    state.remainingBytes -= byteLength(rendered.value);
    if (rendered.value !== "") {
      const textBlock: PdfTextBlock = {
        kind: "text",
        coordinate: firstText.coordinate,
        text: rendered.value,
        truncated: rendered.truncated,
      };
      blocks.push(textBlock);
    }
    if (rendered.truncated || rendered.omittedBytes > 0) {
      truncated = true;
      addDiagnosticIfMissing(diagnostics, "huge-output", page);
    }
    if (state.remainingBytes === 0) {
      state.stopReason = "budget";
    }
  }

  for (const link of extracted.links) {
    const block: PdfLinkBlock = { kind: "link", ...link };
    blocks.push(block);
  }
  for (const annotation of extracted.annotations) {
    const block: PdfAnnotationBlock = { kind: "annotation", ...annotation };
    blocks.push(block);
  }
  for (const image of extracted.images) {
    const block: PdfImageBlock = { kind: "embedded-image", ...image };
    blocks.push(block);
  }

  return {
    pageNumber: extracted.pageNumber,
    pageObjectNumber: extracted.pageObjectNumber,
    extractionMethod: extracted.extractionMethod,
    layoutConfidence: extracted.layoutConfidence,
    ocrRequired: extracted.ocrRequired,
    blocks,
    diagnostics,
    truncated,
  };
}

function omission(
  kind: PdfOmission["kind"],
  count: number,
  pages: PdfPageRange | null,
  reason: PdfOmission["reason"],
): PdfOmission | null {
  return count > 0 ? { kind, count, pages, reason } : null;
}

function addOmission(
  omissions: PdfOmission[],
  kind: PdfOmission["kind"],
  count: number,
  pages: PdfPageRange | null,
  reason: PdfOmission["reason"],
): void {
  const value = omission(kind, count, pages, reason);
  if (value !== null) {
    omissions.push(value);
  }
}

function rangesForPages(pages: readonly number[]): readonly PdfPageRange[] {
  const ordered = [...new Set(pages)].sort((left, right) => left - right);
  const ranges: PdfPageRange[] = [];
  for (const page of ordered) {
    const previous = ranges.at(-1);
    if (previous === undefined || page > previous.end + 1) {
      ranges.push({ start: page, end: page });
      continue;
    }
    ranges[ranges.length - 1] = { ...previous, end: page };
  }
  return ranges;
}

function selectPages(request: NormalizedPdfReadRequest, pageCount: number): Selection {
  const omissions: PdfOmission[] = [];
  const recoveryRanges: PdfPageRange[] = [];
  if (request.mode === "pages") {
    const requested: number[] = [];
    for (const range of request.pages) {
      const availableEnd = Math.min(range.end, pageCount);
      if (range.start <= availableEnd) {
        requested.push(
          ...Array.from(
            { length: availableEnd - range.start + 1 },
            (_, offset) => range.start + offset,
          ),
        );
      }
      if (range.end > pageCount) {
        const start = Math.max(range.start, pageCount + 1);
        addOmission(
          omissions,
          "pages",
          range.end - start + 1,
          { start, end: range.end },
          "not-found",
        );
      }
    }
    const admitted = requested.slice(0, request.limits.maxPages);
    const omitted = requested.slice(admitted.length);
    for (const range of rangesForPages(omitted)) {
      addOmission(omissions, "pages", range.end - range.start + 1, range, "budget");
      recoveryRanges.push(range);
    }
    return {
      pages: admitted,
      scannedPages: admitted,
      omissions,
      recoveryRanges,
      emptyReason: admitted.length === 0 ? "no-selected-pages" : null,
    };
  }

  const scannedPages = Array.from(
    { length: Math.min(pageCount, request.limits.maxPages) },
    (_, index) => index + 1,
  );
  if (pageCount > scannedPages.length) {
    const range = { start: scannedPages.length + 1, end: pageCount };
    addOmission(omissions, "pages", pageCount - scannedPages.length, range, "budget");
    recoveryRanges.push(range);
  }
  return {
    pages: [],
    scannedPages,
    omissions,
    recoveryRanges,
    emptyReason: null,
  };
}

function documentIdentity(
  requestPath: string,
  bound: BoundWorkspacePath,
  source: { readonly byteLength: number; readonly bytes: Uint8Array },
  parsed: ParsedPdf,
  selectedPages: readonly number[],
  scannedPages: readonly number[],
): PdfDocument {
  return {
    requested: requestPath,
    bound,
    byteLength: source.byteLength,
    digest: digestFor(source.bytes),
    format: parsed.format,
    pageCount: parsed.pages.length,
    selectedPages,
    scannedPages,
  };
}

function emptyResult(
  request: NormalizedPdfReadRequest,
  document: PdfDocument,
  omissions: readonly PdfOmission[],
  recoveryRanges: readonly PdfPageRange[],
  emptyReason: "no-selected-pages" | "no-query-matches",
  stopReason: PdfRead["stopReason"],
): PdfRead {
  return {
    capability: "read_pdf",
    projection: "pdf",
    complete: false,
    status: "empty",
    mode: request.mode,
    document,
    pages: [],
    omissions,
    recoveryRanges,
    stopReason,
    emptyReason,
  };
}

async function readPdf(
  workspaceReader: WorkspaceReader,
  root: LocalPath,
  request: unknown,
  signal: AbortSignal | undefined,
): Promise<
  | { readonly ok: true; readonly value: PdfRead }
  | { readonly ok: false; readonly error: PdfReadError }
> {
  if (isAborted(signal)) {
    return { ok: false, error: { code: "cancelled" } };
  }
  const parsedRequest = parsePdfReadRequest(request);
  if (!parsedRequest.ok) {
    return parsedRequest;
  }
  if (!parsedRequest.value.path.toLowerCase().endsWith(".pdf")) {
    return { ok: false, error: { code: "not-pdf" } };
  }
  const source = await workspaceReader.readBytes(
    root,
    parsedRequest.value.path,
    { maxFileBytes: parsedRequest.value.limits.maxSourceBytes },
    signal,
  );
  if (!source.ok) {
    return { ok: false, error: source.error };
  }
  if (isAborted(signal)) {
    return { ok: false, error: { code: "cancelled" } };
  }
  const parsedPdf = parsePdf(source.value.bytes, parsedRequest.value.limits);
  if (!parsedPdf.ok) {
    return parsedPdf;
  }
  const selection = selectPages(parsedRequest.value, parsedPdf.value.pages.length);
  const selectedPages = selection.pages;
  const document = documentIdentity(
    parsedRequest.value.path,
    source.value.bound,
    source.value,
    parsedPdf.value,
    selectedPages,
    selection.scannedPages,
  );
  const omissions: PdfOmission[] = [...selection.omissions];
  const recoveryRanges: PdfPageRange[] = [...selection.recoveryRanges];
  const budget: RenderBudget = {
    remainingBytes: parsedRequest.value.limits.maxOutputBytes,
    stopReason: null,
  };
  const pages: PdfPage[] = [];
  const pagesByNumber = new Map(parsedPdf.value.pages.map((page) => [page.pageNumber, page]));

  if (parsedRequest.value.mode === "pages") {
    for (let position = 0; position < selectedPages.length; position += 1) {
      if (isAborted(signal)) {
        budget.stopReason = "cancelled";
        for (const range of rangesForPages(selectedPages.slice(position))) {
          addOmission(omissions, "pages", range.end - range.start + 1, range, "budget");
          recoveryRanges.push(range);
        }
        break;
      }
      if (budget.stopReason !== null) {
        for (const range of rangesForPages(selectedPages.slice(position))) {
          addOmission(omissions, "pages", range.end - range.start + 1, range, "budget");
          recoveryRanges.push(range);
        }
        break;
      }
      const pageNumber = selectedPages[position];
      if (pageNumber === undefined) {
        continue;
      }
      const page = pagesByNumber.get(pageNumber);
      if (page === undefined) {
        addOmission(omissions, "pages", 1, { start: pageNumber, end: pageNumber }, "not-found");
        continue;
      }
      const extracted = extractPage(page, parsedPdf.value, parsedRequest.value.limits);
      const rendered = renderPage(extracted, page, budget, parsedRequest.value.limits);
      pages.push(rendered);
    }
  } else {
    for (const pageNumber of selection.scannedPages) {
      if (isAborted(signal)) {
        budget.stopReason = "cancelled";
        break;
      }
      if (budget.stopReason === "budget" || budget.stopReason === "decompression") {
        break;
      }
      const page = pagesByNumber.get(pageNumber);
      if (page === undefined) {
        continue;
      }
      const extracted = extractPage(page, parsedPdf.value, parsedRequest.value.limits);
      if (
        parsedRequest.value.query !== null &&
        !extracted.text.toLocaleLowerCase().includes(parsedRequest.value.query.toLocaleLowerCase())
      ) {
        continue;
      }
      pages.push(renderPage(extracted, page, budget, parsedRequest.value.limits));
    }
    if (pages.length === 0 && selection.scannedPages.length > 0 && budget.stopReason === null) {
      selection.emptyReason = "no-query-matches";
    }
  }

  if (budget.stopReason !== null) {
    const lastPage = pages.at(-1)?.pageNumber ?? 0;
    const remaining =
      parsedRequest.value.mode === "pages"
        ? selectedPages.filter((pageNumber) => pageNumber > lastPage)
        : selection.scannedPages.filter((pageNumber) => pageNumber > lastPage);
    for (const range of rangesForPages(remaining)) {
      addOmission(omissions, "pages", range.end - range.start + 1, range, "budget");
      recoveryRanges.push(range);
    }
  }
  const selectedForDocument =
    parsedRequest.value.mode === "pages" ? selectedPages : pages.map((page) => page.pageNumber);
  if (pages.length === 0) {
    return {
      ok: true,
      value: emptyResult(
        parsedRequest.value,
        { ...document, selectedPages: selectedForDocument },
        omissions,
        recoveryRanges,
        parsedRequest.value.mode === "query"
          ? (selection.emptyReason ?? "no-query-matches")
          : (selection.emptyReason ?? "no-selected-pages"),
        budget.stopReason,
      ),
    };
  }
  return {
    ok: true,
    value: {
      capability: "read_pdf",
      projection: "pdf",
      complete: false,
      status:
        omissions.length > 0 ||
        budget.stopReason !== null ||
        pages.some((page) => page.diagnostics.length > 0)
          ? "partial"
          : "complete",
      mode: parsedRequest.value.mode,
      document: { ...document, selectedPages: selectedForDocument },
      pages,
      omissions,
      recoveryRanges,
      stopReason: budget.stopReason,
    },
  };
}

export function createPdfReader(workspaceReader: WorkspaceReader): PdfReader {
  return {
    read(root, request, signal) {
      return readPdf(workspaceReader, root, request, signal);
    },
  };
}
