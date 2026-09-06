import type {
  PdfCoordinate,
  PdfDiagnostic,
  PdfExtractionMethod,
  PdfLayoutConfidence,
  PdfOmission,
  PdfPageRange,
  PdfRead,
} from "../../../domain/documents/index.ts";

export type PdfObject = {
  readonly number: number;
  readonly generation: number;
  readonly byteOffset: number;
  readonly body: string;
};

export type ParsedPdf = {
  readonly bytes: Uint8Array;
  readonly format: {
    readonly major: number;
    readonly minor: number;
  };
  readonly objects: ReadonlyMap<number, PdfObject>;
  readonly pages: readonly PageDefinition[];
};

export type PageDefinition = {
  readonly pageNumber: number;
  readonly object: PdfObject;
  readonly contentObjects: readonly PdfObject[];
  readonly annotationObjects: readonly PdfObject[];
  readonly resourceBody: string;
};

export type TextSeed = {
  readonly coordinate: PdfCoordinate;
  readonly text: string;
};

export type ImageSeed = {
  readonly coordinate: PdfCoordinate;
  readonly mimeType: string | null;
  readonly width: number | null;
  readonly height: number | null;
  readonly encodedBytes: number;
};

export type LinkSeed = {
  readonly coordinate: PdfCoordinate;
  readonly uri: string;
  readonly rect: readonly number[] | null;
};

export type AnnotationSeed = {
  readonly coordinate: PdfCoordinate;
  readonly subtype: string;
  readonly contents: string | null;
  readonly rect: readonly number[] | null;
};

export type ExtractedPage = {
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

export type RenderBudget = {
  remainingBytes: number;
  stopReason: PdfRead["stopReason"];
};

export type Selection = {
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

export type StreamResult =
  | { readonly ok: true; readonly bytes: Uint8Array }
  | { readonly ok: false; readonly error: StreamFailure };
