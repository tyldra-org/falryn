/** Model-facing process output with Hush projection and Loom-backed exact recovery (#796). */

import { createHash } from "node:crypto";

import {
  type ArtifactId,
  type ArtifactRecord,
  type ArtifactStorePort,
  describeProcessCaptureStop,
  type InvocationId,
  type ProcessStreamCapture,
  processCaptureArtifactId,
  type ToolInvocationOutcome,
  type ToolInvocationResultMetadata,
} from "../domain/index.ts";
import type { HushObservation, HushOrigin } from "./hush.ts";
import type { LoomPort } from "./loom.ts";
import { composeProductLoomContext, type ProductLoomRecoveryHandle } from "./product-loom.ts";
import { createRuntimeProjectionRedactor } from "./redaction.ts";

export const PRODUCT_PROCESS_OUTPUT_OWNER = "#796";
export const PRODUCT_PROCESS_OUTPUT_MODES = ["hush", "raw"] as const;
export const MAX_PRODUCT_PROCESS_RAW_INLINE_BYTES = 6 * 1_024;
export const MAX_PRODUCT_PROCESS_HUSH_BYTES = 8 * 1_024;
export const MAX_PRODUCT_PROCESS_MODEL_BYTES = 16 * 1_024;

export type ProductProcessOutputMode = (typeof PRODUCT_PROCESS_OUTPUT_MODES)[number];

export type ProductProcessObservation = {
  readonly origin: HushOrigin;
  readonly capture: HushObservation["capture"];
  readonly hush: HushObservation["hush"] | null;
  readonly projection: string | null;
};

export type ProductProcessOutputPorts = {
  readonly artifacts?: ArtifactStorePort;
  readonly loom?: LoomPort;
  readonly workspaceId?: string;
  readonly sessionId?: string;
  readonly generation: number;
};

export type ProductProcessRecoveryHandle = ProductLoomRecoveryHandle & {
  readonly lineage: {
    readonly invocationId: string;
    readonly captureId: string;
    readonly stream: ProcessStreamCapture["stream"];
    readonly encoding: ProcessStreamCapture["encoding"];
    readonly availability: "available";
  };
};

type RetainedArtifact = {
  readonly stream: ProcessStreamCapture["stream"];
  readonly record: ArtifactRecord | null;
  readonly artifactId: ArtifactId;
  readonly committed: boolean;
  readonly truncated: boolean;
  readonly required: boolean;
};

async function* oneChunk(bytes: Uint8Array): AsyncIterable<Uint8Array> {
  if (bytes.byteLength > 0) {
    yield bytes;
  }
}

function exactInline(stream: ProcessStreamCapture): boolean {
  return (
    stream.encoding === "utf-8" &&
    !stream.truncated &&
    stream.omittedBytes === 0 &&
    stream.inlineBytes.byteLength === stream.byteCount
  );
}

function needsExactArtifact(
  stream: ProcessStreamCapture,
  mode: ProductProcessOutputMode,
  reduced: boolean,
): boolean {
  if (stream.byteCount === 0 && stream.artifact === null) {
    return false;
  }
  return reduced || !exactInline(stream) || (mode === "raw" && stream.encoding === "binary");
}

async function retainStream(
  stream: ProcessStreamCapture,
  required: boolean,
  invocationId: InvocationId,
  captureId: ProductProcessObservation["capture"]["captureId"],
  artifacts: ArtifactStorePort | undefined,
  signal: AbortSignal,
): Promise<RetainedArtifact | null> {
  const existing = stream.artifact;
  if (existing !== null) {
    const record =
      existing.committed && artifacts !== undefined ? artifacts.get(existing.artifactId) : null;
    return {
      stream: stream.stream,
      artifactId: existing.artifactId,
      committed:
        existing.committed && record?.ok === true && record.value?.availability === "available",
      record:
        record?.ok === true && record.value?.availability === "available" ? record.value : null,
      truncated: existing.truncated,
      required,
    };
  }
  if (!required) {
    return null;
  }
  const identity = processCaptureArtifactId(captureId, stream.stream);
  if (!identity.ok) {
    return null;
  }
  if (artifacts === undefined || !exactInline(stream)) {
    return {
      stream: stream.stream,
      artifactId: identity.value,
      committed: false,
      record: null,
      truncated: stream.truncated || stream.omittedBytes > 0,
      required: true,
    };
  }
  const current = artifacts.get(identity.value);
  if (current.ok && current.value?.availability === "available") {
    return {
      stream: stream.stream,
      artifactId: identity.value,
      committed: true,
      record: current.value,
      truncated: false,
      required: true,
    };
  }
  const ingested = await artifacts.ingest(
    {
      artifactId: identity.value,
      mediaType: "text/plain",
      encoding: "identity",
      sensitivity: "user-content",
      origin: "capture",
      invocationId,
      declaredByteLength: stream.inlineBytes.byteLength,
      content: oneChunk(stream.inlineBytes),
    },
    signal,
  );
  return {
    stream: stream.stream,
    artifactId: identity.value,
    committed: ingested.ok && ingested.value.record.availability === "available",
    record: ingested.ok ? ingested.value.record : null,
    truncated: false,
    required: true,
  };
}

function manifestIdFor(input: {
  readonly workspaceId: string;
  readonly sessionId: string;
  readonly invocationId: InvocationId;
  readonly captureId: ProductProcessObservation["capture"]["captureId"];
  readonly generation: number;
}): string {
  const hash = createHash("sha256");
  for (const value of [
    input.workspaceId,
    input.sessionId,
    String(input.invocationId),
    String(input.captureId),
    String(input.generation),
  ]) {
    hash.update(value);
    hash.update("\0");
  }
  return `loom-process-${hash.digest("hex").slice(0, 32)}`;
}

async function recoveryHandles(
  retained: readonly RetainedArtifact[],
  observation: ProductProcessObservation,
  invocationId: InvocationId,
  ports: ProductProcessOutputPorts,
  signal: AbortSignal,
): Promise<ReadonlyMap<ProcessStreamCapture["stream"], ProductProcessRecoveryHandle>> {
  const available = retained.filter(
    (entry): entry is RetainedArtifact & { readonly record: ArtifactRecord } =>
      entry.committed && entry.record !== null,
  );
  if (
    available.length === 0 ||
    ports.loom === undefined ||
    ports.workspaceId === undefined ||
    ports.sessionId === undefined
  ) {
    return new Map();
  }
  const manifestId = manifestIdFor({
    workspaceId: ports.workspaceId,
    sessionId: ports.sessionId,
    invocationId,
    captureId: observation.capture.captureId,
    generation: ports.generation,
  });
  const adopted = await ports.loom.adopt(
    {
      id: manifestId,
      workspaceId: ports.workspaceId,
      sessionId: ports.sessionId,
      generation: String(ports.generation),
      members: available.map((entry) => ({
        artifactId: String(entry.artifactId),
        summary: `${observation.origin}:${entry.stream}`,
      })),
    },
    signal,
  );
  if (!adopted.ok) {
    return new Map();
  }
  const productLoom = composeProductLoomContext({ loom: ports.loom });
  return new Map(
    available.map((entry) => {
      const handle = productLoom.attachArtifactRecovery(
        {},
        manifestId,
        {
          kind: "artifact",
          artifactId: entry.record.artifactId,
          digest: entry.record.digest,
          byteLength: entry.record.byteLength,
        },
        `${observation.origin}:${entry.stream}`,
      ).loomRecovery;
      const stream =
        entry.stream === "stdout" ? observation.capture.stdout : observation.capture.stderr;
      return [
        entry.stream,
        {
          ...handle,
          lineage: {
            invocationId: String(invocationId),
            captureId: String(observation.capture.captureId),
            stream: entry.stream,
            encoding: stream.encoding,
            availability: "available" as const,
          },
        },
      ];
    }),
  );
}

function streamProjection(
  stream: ProcessStreamCapture,
  mode: ProductProcessOutputMode,
  recovery: ProductProcessRecoveryHandle | null,
  includeRawText: boolean,
) {
  return {
    byteCount: stream.byteCount,
    encoding: stream.encoding,
    completeInline: mode === "raw" ? includeRawText && exactInline(stream) : exactInline(stream),
    omittedBytes: mode === "raw" && !includeRawText ? stream.byteCount : stream.omittedBytes,
    text: mode === "raw" && includeRawText ? stream.inlineText : null,
    recovery,
  };
}

function resultMetadata(
  retained: readonly RetainedArtifact[],
  observation: ProductProcessObservation,
): ToolInvocationResultMetadata {
  return {
    artifacts: retained.map((entry) => ({
      artifactId: entry.artifactId,
      required: entry.required,
      committed: entry.committed,
      truncated: entry.truncated,
    })),
    captureOverflow: observation.capture.stdout.truncated || observation.capture.stderr.truncated,
    ...(observation.capture.exit.exitCode === null
      ? {}
      : { containedProcessExitCode: observation.capture.exit.exitCode }),
  };
}

function hushProjection(observation: ProductProcessObservation) {
  if (observation.hush === null || observation.projection === null) {
    throw new Error("Hush projection requires a Hush observation");
  }
  return {
    kind: "hush" as const,
    text: observation.projection,
    fidelity: observation.hush.fidelity,
    reduced: observation.hush.strategy !== "passthrough",
    reducer: {
      id: observation.hush.reducerId,
      version: observation.hush.reducerVersion,
      strategy: observation.hush.strategy,
    },
    omissions: observation.hush.omissions,
  };
}

function outputValue(
  observation: ProductProcessObservation,
  invocationId: InvocationId,
  requestedMode: ProductProcessOutputMode,
  projectionMode: ProductProcessOutputMode,
  handles: ReadonlyMap<ProcessStreamCapture["stream"], ProductProcessRecoveryHandle>,
  includeRawText = true,
) {
  const rawComplete =
    includeRawText &&
    exactInline(observation.capture.stdout) &&
    exactInline(observation.capture.stderr);
  const rawRecoveryRequired = [observation.capture.stdout, observation.capture.stderr].filter(
    (stream) => stream.byteCount > 0 && (!includeRawText || !exactInline(stream)),
  );
  const rawRecoverable = rawRecoveryRequired.every((stream) => handles.has(stream.stream));
  return {
    owner: PRODUCT_PROCESS_OUTPUT_OWNER,
    invocationId: String(invocationId),
    captureId: String(observation.capture.captureId),
    outputMode: requestedMode,
    origin: observation.origin,
    process: {
      stop: describeProcessCaptureStop(observation.capture.stop),
      exitCode: observation.capture.exit.exitCode,
      signal: observation.capture.exit.signal,
      durationMs: Number(observation.capture.durationMs),
      killStage: observation.capture.killStage,
    },
    stdout: streamProjection(
      observation.capture.stdout,
      projectionMode,
      handles.get("stdout") ?? null,
      includeRawText,
    ),
    stderr: streamProjection(
      observation.capture.stderr,
      projectionMode,
      handles.get("stderr") ?? null,
      includeRawText,
    ),
    projection:
      projectionMode === "raw"
        ? {
            kind: "raw" as const,
            ordering: "per-stream" as const,
            complete: rawComplete,
            fidelity: rawComplete
              ? ("exact" as const)
              : rawRecoverable
                ? ("artifact-backed" as const)
                : ("unavailable" as const),
          }
        : hushProjection(observation),
  };
}

const projectionRedactor = createRuntimeProjectionRedactor();

function redactForProjection(value: unknown): unknown {
  if (typeof value === "string") {
    return projectionRedactor.redactText(value, Number.MAX_SAFE_INTEGER);
  }
  if (value === null || typeof value !== "object") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(redactForProjection);
  }
  const projected: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    projected[key] = projectionRedactor.isSecretName(key)
      ? projectionRedactor.placeholder
      : redactForProjection(entry);
  }
  return projected;
}

function encodedBytes(value: Readonly<Record<string, unknown>>): number {
  return new TextEncoder().encode(JSON.stringify(redactForProjection(value))).byteLength;
}

function handlesFor(
  handles: ReadonlyMap<ProcessStreamCapture["stream"], ProductProcessRecoveryHandle>,
  streams: readonly ProcessStreamCapture[],
  mode: ProductProcessOutputMode,
  reduced: boolean,
): ReadonlyMap<ProcessStreamCapture["stream"], ProductProcessRecoveryHandle> {
  const required = new Set(
    streams
      .filter((stream) => needsExactArtifact(stream, mode, reduced))
      .map((stream) => stream.stream),
  );
  return new Map([...handles].filter(([stream]) => required.has(stream)));
}

/** Retain exact source when needed, adopt it into Loom, and return one bounded projection. */
export async function projectProductProcessOutput(input: {
  readonly observation: ProductProcessObservation;
  readonly invocationId: InvocationId;
  readonly outputMode: ProductProcessOutputMode;
  readonly ports: ProductProcessOutputPorts;
  readonly signal: AbortSignal;
}): Promise<ToolInvocationOutcome> {
  const observedReduced =
    input.outputMode === "hush" && input.observation.hush?.strategy !== "passthrough";
  const streams = [input.observation.capture.stdout, input.observation.capture.stderr] as const;
  const noHandles = new Map<ProcessStreamCapture["stream"], ProductProcessRecoveryHandle>();
  const bareRawOutput = outputValue(
    input.observation,
    input.invocationId,
    input.outputMode,
    "raw",
    noHandles,
  );
  const bareHushOutput =
    input.outputMode === "hush"
      ? outputValue(input.observation, input.invocationId, input.outputMode, "hush", noHandles)
      : bareRawOutput;
  const candidateMode =
    input.outputMode === "raw" || encodedBytes(bareHushOutput) > encodedBytes(bareRawOutput)
      ? "raw"
      : "hush";
  const candidateReduced = candidateMode === "hush" && observedReduced;
  let retained = (
    await Promise.all(
      streams.map((stream) =>
        retainStream(
          stream,
          needsExactArtifact(stream, candidateMode, candidateReduced),
          input.invocationId,
          input.observation.capture.captureId,
          input.ports.artifacts,
          input.signal,
        ),
      ),
    )
  ).filter((entry): entry is RetainedArtifact => entry !== null);
  let handles = await recoveryHandles(
    retained,
    input.observation,
    input.invocationId,
    input.ports,
    input.signal,
  );
  const rawHandles = handlesFor(handles, streams, "raw", false);
  const rawOutput = outputValue(
    input.observation,
    input.invocationId,
    input.outputMode,
    "raw",
    rawHandles,
  );
  const hushOutput =
    candidateMode === "hush"
      ? outputValue(input.observation, input.invocationId, input.outputMode, "hush", handles)
      : rawOutput;
  const projectionMode =
    candidateMode === "raw" || encodedBytes(hushOutput) > encodedBytes(rawOutput) ? "raw" : "hush";
  let output = projectionMode === "raw" ? rawOutput : hushOutput;
  const selectedReduced = projectionMode === "hush" && observedReduced;
  let selectedRequiredStreams = streams
    .filter((stream) => needsExactArtifact(stream, projectionMode, selectedReduced))
    .map((stream) => stream.stream);
  if (encodedBytes(output) > MAX_PRODUCT_PROCESS_MODEL_BYTES) {
    const forced = (
      await Promise.all(
        streams.map((stream) =>
          retainStream(
            stream,
            stream.byteCount > 0,
            input.invocationId,
            input.observation.capture.captureId,
            input.ports.artifacts,
            input.signal,
          ),
        ),
      )
    ).filter((entry): entry is RetainedArtifact => entry !== null);
    retained = [
      ...new Map([...retained, ...forced].map((entry) => [entry.stream, entry])).values(),
    ];
    handles = await recoveryHandles(
      retained,
      input.observation,
      input.invocationId,
      input.ports,
      input.signal,
    );
    output = outputValue(
      input.observation,
      input.invocationId,
      input.outputMode,
      "raw",
      handles,
      false,
    );
    selectedRequiredStreams = streams
      .filter((stream) => stream.byteCount > 0)
      .map((stream) => stream.stream);
  }
  const selectedRequired = new Set(selectedRequiredStreams);
  const metadata = resultMetadata(
    retained.map((entry) => ({ ...entry, required: selectedRequired.has(entry.stream) })),
    input.observation,
  );
  const recoveryUnavailable = selectedRequiredStreams.some((stream) => !handles.has(stream));

  if (encodedBytes(output) > MAX_PRODUCT_PROCESS_MODEL_BYTES) {
    return { status: "partial", output, effect: "partial", result: metadata };
  }

  switch (input.observation.capture.stop.kind) {
    case "cancelled":
      return { status: "cancelled", effect: "uncertain", result: metadata };
    case "timed-out":
      return { status: "timed-out", effect: "uncertain", result: metadata };
    case "capture-exceeded":
      return { status: "partial", output, effect: "partial", result: metadata };
    case "uncertain":
      return input.observation.capture.stop.reason === "artifact-ingest-failed"
        ? { status: "partial", output, effect: "partial", result: metadata }
        : {
            status: "uncertain",
            effect: "uncertain",
            recoveryHint: input.observation.capture.stop.reason,
            result: metadata,
          };
    case "exited":
      return recoveryUnavailable
        ? { status: "partial", output, effect: "partial", result: metadata }
        : { status: "completed", output, effect: "completed", result: metadata };
  }
}
