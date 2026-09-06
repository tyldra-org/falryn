import type {
  NotebookCellRange,
  NotebookEmptyReason,
  NotebookOmission,
  NotebookReadLimits,
  NotebookStopReason,
} from "../../../domain/documents/index.ts";

export type JsonRecord = { readonly [key: string]: unknown };

export type ParsedNotebook = {
  readonly format: {
    readonly major: number;
    readonly minor: number;
  };
  readonly metadata: JsonRecord;
  readonly cells: readonly unknown[];
};

export type RenderBudget = {
  remainingBytes: number;
  remainingOutputs: number;
  remainingAttachments: number;
  exhausted: boolean;
};

export type RenderState = {
  readonly budget: RenderBudget;
  readonly limits: NotebookReadLimits;
  readonly omissions: NotebookOmission[];
  readonly recoveryRanges: NotebookCellRange[];
  stopReason: NotebookStopReason | null;
};

export type RenderedText = {
  readonly value: string;
  readonly truncated: boolean;
  readonly omittedBytes: number;
};

export type SelectedCells = {
  readonly indexes: readonly number[];
  readonly omissions: readonly NotebookOmission[];
  readonly recoveryRanges: readonly NotebookCellRange[];
  readonly emptyReason: NotebookEmptyReason | null;
};
