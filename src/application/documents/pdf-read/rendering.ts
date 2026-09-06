import type {
  NormalizedPdfReadRequest,
  PdfAnnotationBlock,
  PdfBlock,
  PdfCoordinate,
  PdfDiagnostic,
  PdfImageBlock,
  PdfLinkBlock,
  PdfOmission,
  PdfPage,
  PdfPageRange,
  PdfReadLimits,
  PdfTableBlock,
  PdfTextBlock,
} from "../../../domain/documents/index.ts";
import { byteLength, truncateUtf8 } from "./bytes.ts";
import type { ExtractedPage, PageDefinition, RenderBudget, Selection } from "./contracts.ts";

import { diagnostic } from "./extraction.ts";

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

export function renderPage(
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

export function addOmission(
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

export function rangesForPages(pages: readonly number[]): readonly PdfPageRange[] {
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

export function selectPages(request: NormalizedPdfReadRequest, pageCount: number): Selection {
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
