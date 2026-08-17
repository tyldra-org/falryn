/**
 * Rebuild workspace lexical and symbol indexes (#93).
 *
 * Inventories admitted text sources, extracts records, and atomically replaces
 * the generation exposed through WorkspaceIndexWritePort / WorkspaceIndexPort.
 * Optional structural parsers are admitted only when qualification says use (#94).
 */

import {
  buildIndexGeneration,
  err,
  extractIndexRecordsFromText,
  languageIdFromLogical,
  ok,
  qualificationUses,
  qualifyStructuralParsing,
  type Result,
  resolveSourceLanguageId,
  type StructuralParserPort,
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
  readonly structuralParser?: StructuralParserPort | undefined;
};

function mapPersistError(code: string): WorkspaceIndexBuildError {
  if (code === "cancelled") {
    return { code: "build-cancelled" };
  }
  return { code: "persist-failed", reason: code };
}

async function admitStructuralSymbols(
  source: WorkspaceIndexBuildSource,
  parser: StructuralParserPort | undefined,
  signal: AbortSignal | undefined,
): Promise<Result<WorkspaceIndexBuildSource, WorkspaceIndexBuildError>> {
  if (parser === undefined) {
    return ok(source);
  }
  const lexical = extractIndexRecordsFromText(source);
  const regexSymbolCount = lexical.filter((record) => record.kind === "symbol").length;
  const fileBytes = new TextEncoder().encode(source.text).byteLength;
  const languageId = resolveSourceLanguageId(source) ?? languageIdFromLogical(source.logical);
  const decision = qualifyStructuralParsing({
    parserAvailable: true,
    languageId,
    regexSymbolCount,
    fileBytes,
  });
  if (!qualificationUses(decision)) {
    return ok(source);
  }
  if (signal?.aborted === true) {
    return err({ code: "build-cancelled" });
  }
  const parsed = await parser.parseSymbols(source, signal);
  if (!parsed.ok) {
    return parsed;
  }
  return ok({
    ...source,
    languageId,
    structuralSymbols: parsed.value,
  });
}

export function createWorkspaceIndexBuilder(
  options: WorkspaceIndexBuilderOptions,
): WorkspaceIndexBuilder {
  return {
    async rebuildFromSources(sources, rebuildOptions) {
      if (rebuildOptions?.signal?.aborted === true) {
        return err({ code: "build-cancelled" });
      }
      const admitted: WorkspaceIndexBuildSource[] = [];
      for (const source of sources) {
        const next = await admitStructuralSymbols(
          source,
          options.structuralParser,
          rebuildOptions?.signal,
        );
        if (!next.ok) {
          return next;
        }
        admitted.push(next.value);
      }
      const generationId =
        rebuildOptions?.generationId ?? `gen-${Date.now().toString(16)}-${sources.length}`;
      const built = buildIndexGeneration(
        {
          sources: admitted,
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
