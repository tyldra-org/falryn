import { describe, expect, test } from "bun:test";
import { deflateSync } from "node:zlib";

import { createInMemoryFileSystem, localPath } from "../domain/index.ts";
import { createPdfReader, type PdfReader } from "./pdf-read.ts";
import { createWorkspaceReader } from "./workspace-read.ts";

const root = localPath("/work/project");

function streamObject(number: number, content: string): string {
  return [
    `${number} 0 obj`,
    `<< /Length ${Buffer.byteLength(content, "latin1")} >>`,
    "stream",
    content,
    "endstream",
    "endobj",
  ].join("\n");
}

const pdf = [
  "%PDF-1.4",
  "1 0 obj",
  "<< /Type /Catalog /Pages 2 0 R >>",
  "endobj",
  "2 0 obj",
  "<< /Type /Pages /Kids [3 0 R 4 0 R 10 0 R] /Count 3 /Resources 5 0 R >>",
  "endobj",
  "3 0 obj",
  "<< /Type /Page /Parent 2 0 R /Contents 6 0 R /Annots [7 0 R] >>",
  "endobj",
  "4 0 obj",
  "<< /Type /Page /Parent 2 0 R /Contents 9 0 R >>",
  "endobj",
  "5 0 obj",
  "<< /XObject << /Im0 8 0 R >> >>",
  "endobj",
  streamObject(6, "BT\n/F1 12 Tf\n(First page) Tj\nET"),
  "7 0 obj",
  "<< /Type /Annot /Subtype /Link /Rect [0 0 100 20] /A << /S /URI /URI (https://example.com) >> >>",
  "endobj",
  "8 0 obj",
  "<< /Type /XObject /Subtype /Image /Width 2 /Height 3 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Length 3 >>",
  "stream",
  "abc",
  "endstream",
  "endobj",
  streamObject(9, "BT\n/F1 12 Tf\n(Second page) Tj\nET"),
  "10 0 obj",
  "<< /Type /Page /Parent 2 0 R /Contents 11 0 R >>",
  "endobj",
  streamObject(11, "q\n/Im0 Do\nQ"),
].join("\n");

function singlePagePdf(contentObject: string): Uint8Array {
  return Uint8Array.from(
    Buffer.from(
      [
        "%PDF-1.4",
        "1 0 obj",
        "<< /Type /Catalog /Pages 2 0 R >>",
        "endobj",
        "2 0 obj",
        "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        "endobj",
        "3 0 obj",
        "<< /Type /Page /Parent 2 0 R /Contents 4 0 R >>",
        "endobj",
        contentObject,
      ].join("\n"),
      "latin1",
    ),
  );
}

function filteredStreamObject(number: number, content: string, filter: string): string {
  const bytes =
    filter === "FlateDecode"
      ? deflateSync(Buffer.from(content, "latin1"))
      : Buffer.from(content, "latin1");
  return [
    `${number} 0 obj`,
    `<< /Length ${bytes.byteLength} /Filter /${filter} >>`,
    "stream",
    Buffer.from(bytes).toString("latin1"),
    "endstream",
    "endobj",
  ].join("\n");
}

function createFileSystem() {
  return createInMemoryFileSystem({
    nodes: {
      "/work/project": { kind: "directory" },
      "/work/project/report.pdf": { kind: "file", text: pdf },
      "/work/project/malformed.pdf": { kind: "file", text: "%PDF-1.4\n1 0 obj\n<<" },
      "/work/project/encrypted.pdf": {
        kind: "file",
        text: "%PDF-1.4\n/Encrypt 12 0 R",
      },
      "/work/project/v2.pdf": { kind: "file", text: "%PDF-2.0" },
      "/work/project/plain.txt": { kind: "file", text: "not a PDF" },
    },
  });
}

function reader(): PdfReader {
  return createPdfReader(createWorkspaceReader(createFileSystem()));
}

describe("createPdfReader", () => {
  test("returns bounded page-aware text, links, digest, and coordinates", async () => {
    const result = await reader().read(root, {
      path: "report.pdf",
      mode: "pages",
      pages: [{ start: 1, end: 2 }],
    });
    expect(result.ok).toBe(true);
    if (!result.ok || result.value.status === "empty") {
      throw new Error("expected selected PDF pages");
    }

    expect(result.value.document.format).toEqual({ major: 1, minor: 4 });
    expect(result.value.document.pageCount).toBe(3);
    expect(result.value.document.selectedPages).toEqual([1, 2]);
    expect(result.value.document.scannedPages).toEqual([1, 2]);
    expect(result.value.document.digest).toMatch(/^sha-256:[0-9a-f]{64}$/);
    expect(result.value.pages[0]?.blocks).toContainEqual(
      expect.objectContaining({
        kind: "text",
        text: "First page",
        coordinate: expect.objectContaining({ pageNumber: 1 }),
      }),
    );
    expect(result.value.pages[0]?.blocks).toContainEqual(
      expect.objectContaining({
        kind: "link",
        uri: "https://example.com",
      }),
    );
    expect(result.value.pages[1]?.blocks).toContainEqual(
      expect.objectContaining({
        kind: "text",
        text: "Second page",
      }),
    );
    expect(result.value.pages[0]?.extractionMethod).toBe("text");
    expect(result.value.status).toBe("complete");
  });

  test("selects query matches without implicitly returning every page", async () => {
    const result = await reader().read(root, {
      path: "report.pdf",
      mode: "query",
      query: "second",
    });
    expect(result.ok).toBe(true);
    if (!result.ok || result.value.status === "empty") {
      throw new Error("expected query match");
    }
    expect(result.value.document.selectedPages).toEqual([2]);
    expect(result.value.document.scannedPages).toEqual([1, 2, 3]);
    expect(result.value.pages.map((page) => page.pageNumber)).toEqual([2]);
  });

  test("labels image-only pages as OCR-required without executing OCR", async () => {
    const result = await reader().read(root, {
      path: "report.pdf",
      mode: "pages",
      pages: [{ start: 3, end: 3 }],
    });
    expect(result.ok).toBe(true);
    if (!result.ok || result.value.status === "empty") {
      throw new Error("expected image-only page");
    }
    expect(result.value.pages[0]?.extractionMethod).toBe("ocr-required");
    expect(result.value.pages[0]?.ocrRequired).toBe(true);
    expect(result.value.pages[0]?.blocks).toContainEqual(
      expect.objectContaining({
        kind: "embedded-image",
        width: 2,
        height: 3,
        encodedBytes: 3,
      }),
    );
    expect(result.value.pages[0]?.diagnostics.map((item) => item.code)).toEqual([
      "image-only",
      "ocr-required",
    ]);
  });

  test("stops at output budgets while preserving the completed page", async () => {
    const result = await reader().read(root, {
      path: "report.pdf",
      mode: "pages",
      pages: [{ start: 1, end: 2 }],
      limits: { maxOutputBytes: 4, maxPageOutputBytes: 4 },
    });
    expect(result.ok).toBe(true);
    if (!result.ok || result.value.status === "empty") {
      throw new Error("expected partial PDF");
    }
    expect(result.value.pages).toHaveLength(1);
    expect(result.value.document.selectedPages).toEqual([1, 2]);
    expect(result.value.pages[0]?.blocks[0]).toMatchObject({
      kind: "text",
      text: "Firs",
      truncated: true,
    });
    expect(result.value.stopReason).toBe("budget");
    expect(result.value.recoveryRanges).toContainEqual({ start: 2, end: 2 });
  });

  test("bounds query scanning and reports unselected pages", async () => {
    const result = await reader().read(root, {
      path: "report.pdf",
      mode: "query",
      query: "second",
      limits: { maxPages: 1 },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error("expected bounded query result");
    }
    expect(result.value.status).toBe("empty");
    if (result.value.status !== "empty") {
      throw new Error("expected no query match inside the page window");
    }
    expect(result.value.document.scannedPages).toEqual([1]);
    expect(result.value.omissions).toContainEqual({
      kind: "pages",
      count: 2,
      pages: { start: 2, end: 3 },
      reason: "budget",
    });
  });

  test("degrades visibly for unsupported filters and decompression-heavy streams", async () => {
    const unsupported = createPdfReader(
      createWorkspaceReader(
        createInMemoryFileSystem({
          nodes: {
            "/work/project": { kind: "directory" },
            "/work/project/unsupported.pdf": {
              kind: "file",
              bytes: singlePagePdf(filteredStreamObject(4, "ignored", "LZWDecode")),
            },
          },
        }),
      ),
    );
    const unsupportedResult = await unsupported.read(root, {
      path: "unsupported.pdf",
      mode: "pages",
      pages: [{ start: 1, end: 1 }],
    });
    expect(unsupportedResult.ok).toBe(true);
    if (!unsupportedResult.ok || unsupportedResult.value.status === "empty") {
      throw new Error("expected unsupported-filter page");
    }
    expect(unsupportedResult.value.pages[0]?.diagnostics).toContainEqual(
      expect.objectContaining({ code: "unsupported-filter" }),
    );

    const heavy = createPdfReader(
      createWorkspaceReader(
        createInMemoryFileSystem({
          nodes: {
            "/work/project": { kind: "directory" },
            "/work/project/heavy.pdf": {
              kind: "file",
              bytes: singlePagePdf(
                filteredStreamObject(4, `BT\n(${`${"x".repeat(500)}`}) Tj\nET`, "FlateDecode"),
              ),
            },
          },
        }),
      ),
    );
    const heavyResult = await heavy.read(root, {
      path: "heavy.pdf",
      mode: "pages",
      pages: [{ start: 1, end: 1 }],
      limits: { maxDecompressedBytes: 32 },
    });
    expect(heavyResult.ok).toBe(true);
    if (!heavyResult.ok || heavyResult.value.status === "empty") {
      throw new Error("expected decompression-limited page");
    }
    expect(heavyResult.value.pages[0]?.diagnostics).toContainEqual(
      expect.objectContaining({ code: "decompression-limit" }),
    );
  });

  test("types malformed, encrypted, unsupported, wrong-family, oversized, and cancelled inputs", async () => {
    const pdfReader = reader();
    expect(
      await pdfReader.read(root, {
        path: "malformed.pdf",
        mode: "pages",
        pages: [{ start: 1, end: 1 }],
      }),
    ).toEqual({
      ok: false,
      error: { code: "malformed-objects" },
    });
    expect(
      await pdfReader.read(root, {
        path: "encrypted.pdf",
        mode: "pages",
        pages: [{ start: 1, end: 1 }],
      }),
    ).toEqual({
      ok: false,
      error: { code: "encrypted" },
    });
    expect(
      await pdfReader.read(root, { path: "v2.pdf", mode: "pages", pages: [{ start: 1, end: 1 }] }),
    ).toEqual({
      ok: false,
      error: { code: "unsupported-version", major: 2, minor: 0 },
    });
    expect(
      await pdfReader.read(root, {
        path: "plain.txt",
        mode: "pages",
        pages: [{ start: 1, end: 1 }],
      }),
    ).toEqual({
      ok: false,
      error: { code: "not-pdf" },
    });
    expect(
      await pdfReader.read(root, {
        path: "report.pdf",
        mode: "pages",
        pages: [{ start: 1, end: 1 }],
        limits: { maxSourceBytes: 16 },
      }),
    ).toEqual({
      ok: false,
      error: { code: "oversized", byteLength: Buffer.byteLength(pdf, "utf8") },
    });
    expect(
      await pdfReader.read(
        root,
        { path: "report.pdf", mode: "pages", pages: [{ start: 1, end: 1 }] },
        AbortSignal.abort(),
      ),
    ).toEqual({ ok: false, error: { code: "cancelled" } });
  });
});
