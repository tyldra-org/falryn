/**
 * Rebuild workspace lexical and symbol indexes (#93).
 *
 * Inventories admitted text sources, extracts records, and atomically replaces
 * the generation exposed through WorkspaceIndexWritePort / WorkspaceIndexPort.
 */

import {
  buildIndexGeneration,
  err,
  ok,
  type Result,
  type WorkspaceIndexBuildError,
  type WorkspaceIndexBuildLimits,
  type WorkspaceIndexBuildReport,
  type WorkspaceIndexBuildSource,
  type WorkspaceIndexWritePort,
} from "../domain/index.ts";

export type WorkspaceIndexBuilder = {
  rebuildFromSources(
    sources: readonly WorkspaceIndexBuildSource[],
    options?: {
      readonly generationId?: string | undefined;
      readonly limits?: WorkspaceIndexBuildLimits | undefined;
      readonly signal?: AbortSignal | undefined;
    },
  ): Promise<Result<WorkspaceIndexBuildReport, WorkspaceIndexBuildError>>;
};

export type WorkspaceIndexBuilderOptions = {
  readonly index: WorkspaceIndexWritePort;
};

function mapPersistError(code: string): WorkspaceIndexBuildError {
  if (code === "cancelled") {
    return { code: "build-cancelled" };
  }
  return { code: "persist-failed", reason: code };
}

export function createWorkspaceIndexBuilder(
  options: WorkspaceIndexBuilderOptions,
): WorkspaceIndexBuilder {
  return {
    async rebuildFromSources(sources, rebuildOptions) {
      if (rebuildOptions?.signal?.aborted === true) {
        return err({ code: "build-cancelled" });
      }
      const generationId =
        rebuildOptions?.generationId ?? `gen-${Date.now().toString(16)}-${sources.length}`;
      const built = buildIndexGeneration(
        {
          sources,
          ...(rebuildOptions?.limits === undefined ? {} : { limits: rebuildOptions.limits }),
        },
        generationId,
        "ready",
      );
      if (!built.ok) {
        return built;
      }
      const persisted = await options.index.rebuild(built.value.generation, rebuildOptions?.signal);
      if (!persisted.ok) {
        return err(mapPersistError(persisted.error.code));
      }
      return ok(built.value);
    },
  };
}
