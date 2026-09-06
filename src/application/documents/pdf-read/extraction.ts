import { inflateSync } from "node:zlib";
import type {
  PdfDiagnostic,
  PdfExtractionMethod,
  PdfLayoutConfidence,
  PdfReadLimits,
} from "../../../domain/documents/index.ts";
import { bytesFromLatin1, latin1 } from "./bytes.ts";
import type {
  AnnotationSeed,
  ExtractedPage,
  ImageSeed,
  LinkSeed,
  PageDefinition,
  ParsedPdf,
  PdfObject,
  StreamResult,
  TextSeed,
} from "./contracts.ts";
import { coordinate, directName, directNumber, objectDictionary, objectType } from "./objects.ts";

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

export function diagnostic(
  code: PdfDiagnostic["code"],
  page: PageDefinition,
  object: PdfObject | null = null,
): PdfDiagnostic {
  return { code, coordinate: coordinate(page, object) };
}

export function extractPage(
  page: PageDefinition,
  pdf: ParsedPdf,
  limits: PdfReadLimits,
): ExtractedPage {
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
