/** Public contracts for exact and bounded workspace reads. */

import type {
  ArtifactStorePort,
  LocalPath,
  WorkspaceBytesRead,
  WorkspaceFileRead,
  WorkspaceReadError,
  WorkspaceReadLimits,
  WorkspaceReadManyResult,
  WorkspaceReadRange,
  WorkspaceReadTarget,
} from "../../domain/index.ts";

export type WorkspaceReader = {
  read(
    root: LocalPath,
    value: unknown,
    range?: WorkspaceReadRange,
    limits?: Partial<WorkspaceReadLimits>,
    signal?: AbortSignal,
  ): Promise<
    | { readonly ok: true; readonly value: WorkspaceFileRead }
    | { readonly ok: false; readonly error: WorkspaceReadError }
  >;
  readBytes(
    root: LocalPath,
    value: unknown,
    limits?: Partial<WorkspaceReadLimits>,
    signal?: AbortSignal,
  ): Promise<
    | { readonly ok: true; readonly value: WorkspaceBytesRead }
    | { readonly ok: false; readonly error: WorkspaceReadError }
  >;
  readMany(
    root: LocalPath,
    targets: readonly WorkspaceReadTarget[],
    limits?: Partial<WorkspaceReadLimits>,
    signal?: AbortSignal,
  ): Promise<
    | { readonly ok: true; readonly value: WorkspaceReadManyResult }
    | { readonly ok: false; readonly error: WorkspaceReadError }
  >;
};

export type WorkspaceReaderOptions = {
  /**
   * Optional durable store for exact source expansion.
   *
   * Without it, an oversized source remains a typed refusal and no bytes are
   * silently retained in memory.
   */
  readonly artifacts?: ArtifactStorePort;
};
