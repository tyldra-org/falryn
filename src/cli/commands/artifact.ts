/** Artifact catalog, inspection, and byte-delivery command family. */

import {
  type createArtifactReader,
  createDurableArtifactApi,
  fromArtifactCatalogError,
  fromArtifactError,
  fromArtifactReadError,
  fromUnknown,
  queryStoredArtifacts,
} from "../../application/index.ts";
import {
  type ArtifactApiError,
  type ArtifactCatalogEntry,
  type ArtifactCatalogError,
  type ArtifactError,
  type ArtifactLineage,
  type ArtifactReadError,
  type ArtifactRecord,
  type LocalPath,
  localPath,
  MAX_ARTIFACT_CATALOG,
  MAX_ARTIFACT_READ_RANGE_BYTES,
  MAX_STREAM_WRITE_BYTES,
  type OutputStreamPort,
  type Result,
} from "../../domain/index.ts";
import { createHostFileOutputStream } from "../../integrations/index.ts";
import type { ArtifactCommandArguments } from "../command-tree.ts";
import type { CommandResultOf, CommandTruncation } from "../result.ts";
import type { ServiceProvider } from "../services.ts";
import { resultFor } from "./shared.ts";
import { openArtifactStore } from "./storage.ts";

export type ArtifactStdoutDelivery = {
  readonly kind: "stdout-bytes";
};

export type ArtifactListPayload = {
  readonly artifacts: readonly ArtifactCatalogEntry[];
  readonly omitted: number;
};

export type ArtifactShowPayload = {
  readonly lineage: ArtifactLineage;
};

export type ArtifactGetPayload = {
  readonly artifactId: string;
  readonly byteLength: number;
  readonly destination: "stdout" | "file";
  readonly path: string | null;
  readonly bytesWritten: number;
};

export type ArtifactCommandExtras = {
  readonly stdoutDelivery?: ArtifactStdoutDelivery;
};

export async function runArtifactList(
  services: ServiceProvider,
  arguments_: Extract<ArtifactCommandArguments, { action: "list" }>,
  signal?: AbortSignal,
): Promise<CommandResultOf<"artifact.list", ArtifactListPayload>> {
  try {
    return await artifactListThroughStore(services, arguments_, signal);
  } catch (error) {
    return resultFor<"artifact.list", ArtifactListPayload>("artifact.list", null, [
      fromUnknown(error, { operation: "list artifacts" }),
    ]);
  }
}

export async function runArtifactShow(
  services: ServiceProvider,
  arguments_: Extract<ArtifactCommandArguments, { action: "show" }>,
  signal?: AbortSignal,
): Promise<CommandResultOf<"artifact.show", ArtifactShowPayload>> {
  try {
    return await artifactShowThroughStore(services, arguments_, signal);
  } catch (error) {
    return resultFor<"artifact.show", ArtifactShowPayload>("artifact.show", null, [
      fromUnknown(error, { operation: "show artifact" }),
    ]);
  }
}

export async function runArtifactGet(
  services: ServiceProvider,
  arguments_: Extract<ArtifactCommandArguments, { action: "get" }>,
  options: {
    readonly resultStream: OutputStreamPort;
    readonly stdoutIsTty: boolean;
  },
  signal?: AbortSignal,
): Promise<CommandResultOf<"artifact.get", ArtifactGetPayload> & ArtifactCommandExtras> {
  try {
    return await artifactGetThroughStore(services, arguments_, options, signal);
  } catch (error) {
    return resultFor<"artifact.get", ArtifactGetPayload>("artifact.get", null, [
      fromUnknown(error, { operation: "get artifact" }),
    ]);
  }
}

async function artifactListThroughStore(
  services: ServiceProvider,
  arguments_: Extract<ArtifactCommandArguments, { action: "list" }>,
  signal: AbortSignal | undefined,
): Promise<CommandResultOf<"artifact.list", ArtifactListPayload>> {
  const opened = await openArtifactStore(services, signal);
  if (!opened.ok) {
    return resultFor<"artifact.list", ArtifactListPayload>("artifact.list", null, opened.errors);
  }
  if (opened.kind === "absent") {
    return resultFor("artifact.list", { artifacts: [], omitted: 0 });
  }

  try {
    const catalog = queryStoredArtifacts(opened.repository, { limit: arguments_.limit }, signal);
    if (!catalog.ok) {
      return artifactListFailure(catalog.error);
    }
    const total = catalog.value.artifacts.length + catalog.value.omitted;
    const truncation: CommandTruncation[] =
      catalog.value.omitted === 0
        ? []
        : [
            {
              of: "artifacts",
              shown: catalog.value.artifacts.length,
              total,
              expansion: arguments_.limit >= MAX_ARTIFACT_CATALOG ? null : artifactListExpansion(),
            },
          ];
    return {
      ...resultFor("artifact.list", {
        artifacts: catalog.value.artifacts,
        omitted: catalog.value.omitted,
      }),
      truncation,
    };
  } finally {
    await opened.store.close();
  }
}

async function artifactShowThroughStore(
  services: ServiceProvider,
  arguments_: Extract<ArtifactCommandArguments, { action: "show" }>,
  signal: AbortSignal | undefined,
): Promise<CommandResultOf<"artifact.show", ArtifactShowPayload>> {
  const opened = await openArtifactStore(services, signal);
  if (!opened.ok) {
    return resultFor<"artifact.show", ArtifactShowPayload>("artifact.show", null, opened.errors);
  }
  if (opened.kind === "absent") {
    return artifactShowFailure({
      kind: "artifact",
      code: "not-found",
      artifactId: arguments_.artifactId,
    });
  }

  try {
    const api = createDurableArtifactApi({
      artifacts: opened.repository,
      provenance: opened.provenance,
    });
    const described = api.describe(arguments_.artifactId);
    if (!described.ok) {
      return artifactShowFailure(described.error);
    }
    return resultFor("artifact.show", { lineage: described.value });
  } finally {
    await opened.store.close();
  }
}

async function artifactGetThroughStore(
  services: ServiceProvider,
  arguments_: Extract<ArtifactCommandArguments, { action: "get" }>,
  options: {
    readonly resultStream: OutputStreamPort;
    readonly stdoutIsTty: boolean;
  },
  signal: AbortSignal | undefined,
): Promise<CommandResultOf<"artifact.get", ArtifactGetPayload> & ArtifactCommandExtras> {
  const opened = await openArtifactStore(services, signal);
  if (!opened.ok) {
    return resultFor<"artifact.get", ArtifactGetPayload>("artifact.get", null, opened.errors);
  }
  if (opened.kind === "absent") {
    return artifactGetFailure({
      kind: "artifact",
      code: "not-found",
      artifactId: arguments_.artifactId,
    });
  }

  try {
    const found = opened.repository.get(arguments_.artifactId);
    if (!found.ok) {
      return artifactGetFailure(found.error);
    }
    if (found.value === null) {
      return artifactGetFailure({
        kind: "artifact",
        code: "not-found",
        artifactId: arguments_.artifactId,
      });
    }
    const record = found.value;
    if (arguments_.outputPath === null && options.stdoutIsTty) {
      return resultFor<"artifact.get", ArtifactGetPayload>("artifact.get", null, [
        fromUnknown(new Error("artifact retrieval to a terminal requires --output"), {
          operation: "get artifact",
        }),
      ]);
    }
    const retrievalRefused = refusalForRetrieval(record);
    if (retrievalRefused !== null) {
      return artifactGetFailure(retrievalRefused);
    }
    if (record.availability !== "available") {
      return artifactGetFailure({
        kind: "artifact",
        code: "not-found",
        artifactId: arguments_.artifactId,
      });
    }

    const written =
      arguments_.outputPath === null
        ? await streamArtifactToPort(opened.reader, record, options.resultStream, signal)
        : await streamArtifactToDestination(
            opened.reader,
            record,
            localPath(arguments_.outputPath),
            signal,
          );
    if (!written.ok) {
      return artifactGetFailure(written.error);
    }

    const payload: ArtifactGetPayload = {
      artifactId: String(record.artifactId),
      byteLength: record.byteLength,
      destination: arguments_.outputPath === null ? "stdout" : "file",
      path: arguments_.outputPath,
      bytesWritten: written.value,
    };
    const result = resultFor("artifact.get", payload);
    return arguments_.outputPath === null
      ? { ...result, stdoutDelivery: { kind: "stdout-bytes" } }
      : result;
  } finally {
    await opened.store.close();
  }
}

function refusalForRetrieval(record: ArtifactRecord): ArtifactError | null {
  if (record.sensitivity === "restricted") {
    return { kind: "artifact", code: "not-found", artifactId: record.artifactId };
  }
  return null;
}

async function streamArtifactToDestination(
  reader: ReturnType<typeof createArtifactReader>,
  record: ArtifactRecord,
  path: LocalPath,
  signal: AbortSignal | undefined,
): Promise<Result<number, ArtifactError | ArtifactReadError>> {
  const stream = createHostFileOutputStream(path);
  try {
    const written = await streamArtifactToPort(reader, record, stream, signal);
    if (!written.ok) {
      return written;
    }
    const flushed = await stream.flush();
    if (flushed.status !== "flushed") {
      return {
        ok: false,
        error: { kind: "artifact", code: "cancelled", artifactId: record.artifactId },
      };
    }
    return written;
  } finally {
    stream.dispose();
  }
}

async function streamArtifactToPort(
  reader: ReturnType<typeof createArtifactReader>,
  record: ArtifactRecord,
  stream: OutputStreamPort,
  signal: AbortSignal | undefined,
): Promise<Result<number, ArtifactError | ArtifactReadError>> {
  let offset = 0;
  let total = 0;
  while (offset < record.byteLength) {
    if (signal?.aborted === true) {
      return {
        ok: false,
        error: { kind: "artifact", code: "cancelled", artifactId: record.artifactId },
      };
    }
    const length = Math.min(MAX_ARTIFACT_READ_RANGE_BYTES, record.byteLength - offset);
    const read = await reader.read(
      {
        artifactId: record.artifactId,
        mode: "range",
        offset,
        length,
        limits: { maxRangeBytes: MAX_ARTIFACT_READ_RANGE_BYTES },
      },
      signal,
    );
    if (!read.ok) {
      return read;
    }
    const bytes = read.value.range?.bytes;
    if (bytes === undefined || bytes === null) {
      return {
        ok: false,
        error: { kind: "artifact", code: "not-found", artifactId: record.artifactId },
      };
    }
    let writtenOffset = 0;
    while (writtenOffset < bytes.byteLength) {
      const slice = bytes.subarray(
        writtenOffset,
        Math.min(writtenOffset + MAX_STREAM_WRITE_BYTES, bytes.byteLength),
      );
      const write = stream.write(slice);
      if (write.status === "closed" || write.status === "too-large") {
        return {
          ok: false,
          error: { kind: "artifact", code: "cancelled", artifactId: record.artifactId },
        };
      }
      writtenOffset += slice.byteLength;
    }
    total += bytes.byteLength;
    offset += bytes.byteLength;
  }
  return { ok: true, value: total };
}

function artifactListExpansion(): string {
  return `falryn artifact list --limit ${MAX_ARTIFACT_CATALOG}`;
}

function artifactListFailure(
  error: ArtifactCatalogError | ArtifactError,
): CommandResultOf<"artifact.list", ArtifactListPayload> {
  return resultFor<"artifact.list", ArtifactListPayload>("artifact.list", null, [
    error.kind === "artifact-catalog"
      ? fromArtifactCatalogError(error, { operation: "list artifacts" })
      : fromArtifactError(error, { operation: "list artifacts" }),
  ]);
}

function artifactShowFailure(
  error: ArtifactError | ArtifactApiError,
): CommandResultOf<"artifact.show", ArtifactShowPayload> {
  if ("kind" in error && error.kind === "artifact") {
    return resultFor<"artifact.show", ArtifactShowPayload>("artifact.show", null, [
      fromArtifactError(error, { operation: "show artifact" }),
    ]);
  }
  return resultFor<"artifact.show", ArtifactShowPayload>("artifact.show", null, [
    fromUnknown(new Error("the artifact could not be described"), { operation: "show artifact" }),
  ]);
}

function artifactGetFailure(
  error: ArtifactError | ArtifactReadError,
): CommandResultOf<"artifact.get", ArtifactGetPayload> {
  if ("kind" in error && error.kind === "artifact") {
    return resultFor<"artifact.get", ArtifactGetPayload>("artifact.get", null, [
      fromArtifactError(error, { operation: "get artifact" }),
    ]);
  }
  if ("code" in error && error.code === "cancelled") {
    return resultFor<"artifact.get", ArtifactGetPayload>("artifact.get", null, [
      fromArtifactReadError(error, { operation: "get artifact" }),
    ]);
  }
  return resultFor<"artifact.get", ArtifactGetPayload>("artifact.get", null, [
    fromArtifactReadError(error, { operation: "get artifact" }),
  ]);
}

/* -------------------------------------------------------------------------- */
/* workspace                                                                   */
/* -------------------------------------------------------------------------- */
