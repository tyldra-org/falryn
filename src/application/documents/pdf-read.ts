/**
 * Application boundary for the bounded PDF reader (#495).
 *
 * PDF bytes enter only through the injected workspace reader. Parsing is
 * deliberately local and bounded: it extracts page text and lightweight
 * metadata, never executes an embedded action, invokes OCR, or exposes raw
 * embedded media.
 */

import {
  type NormalizedPdfReadRequest,
  type PdfDocument,
  type PdfOmission,
  type PdfPage,
  type PdfPageRange,
  type PdfRead,
  type PdfReadError,
  parsePdfReadRequest,
} from "../../domain/documents/index.ts";
import type { BoundWorkspacePath, LocalPath } from "../../domain/workspace/index.ts";
import type { WorkspaceReader } from "../workspace/workspace-read.ts";
import { digestFor } from "./pdf-read/bytes.ts";
import type { ParsedPdf, RenderBudget } from "./pdf-read/contracts.ts";
import { extractPage } from "./pdf-read/extraction.ts";
import { parsePdf } from "./pdf-read/objects.ts";
import { addOmission, rangesForPages, renderPage, selectPages } from "./pdf-read/rendering.ts";

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
