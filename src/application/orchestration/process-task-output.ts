/** Bounded task artifacts and authorized byte reads; no process or lifecycle authority. */
import { createHash } from "node:crypto";
import { type ArtifactStorePort, artifactId } from "../../domain/artifacts/artifact.ts";
import { contentDigest } from "../../domain/artifacts/index.ts";
import { invocationId } from "../../domain/foundation/index.ts";
import { err, ok, type Result } from "../../domain/foundation/result.ts";
import type {
  ProcessTaskArtifact,
  ProcessTaskSnapshot,
} from "../../domain/orchestration/process-task.ts";
import { MAX_PROCESS_TASK_LOG_BYTES } from "../../domain/orchestration/process-task.ts";
import type { ProcessTaskStore } from "../../domain/orchestration/process-task-store.ts";
import type { ProcessStreamName } from "../../domain/process/process-capture.ts";
import { createRuntimeProjectionRedactor } from "../diagnostics/redaction.ts";
import type { ProcessTaskTail } from "./process-task-buffer.ts";

type OutputError = { readonly code: string };
const redactor = createRuntimeProjectionRedactor();

export async function retainProcessTaskBytes(
  artifacts: ArtifactStorePort,
  task: ProcessTaskSnapshot,
  key: string,
  bytes: Uint8Array,
  mediaType = "application/octet-stream",
): Promise<Result<ProcessTaskArtifact, OutputError>> {
  const digest = contentDigest.from(`sha-256:${createHash("sha256").update(bytes).digest("hex")}`);
  const id = artifactId.from(
    `process-task-${createHash("sha256").update(`${task.handle.taskId}:${task.handle.generation}:${key}`).digest("hex")}`,
  );
  const stored = await artifacts.ingest(
    {
      artifactId: id,
      mediaType,
      encoding: "identity",
      sensitivity: "sensitive",
      origin: "capture",
      invocationId: invocationId.from(task.owner.invocationId),
      declaredByteLength: bytes.byteLength,
      expectedDigest: digest,
      content: (async function* () {
        yield bytes;
      })(),
    },
    AbortSignal.timeout(5_000),
  );
  if (!stored.ok) return err({ code: stored.error.code });
  if (
    stored.value.cancelledAfterCommit ||
    stored.value.record.availability !== "available" ||
    stored.value.record.digest !== digest ||
    stored.value.record.byteLength !== bytes.byteLength
  )
    return err({ code: "artifact-unavailable" });
  return ok({ artifactId: id, digest, byteLength: bytes.byteLength });
}

async function readArtifact(
  artifacts: ArtifactStorePort,
  task: ProcessTaskSnapshot,
  artifact: ProcessTaskArtifact,
  offset: number,
  limit: number,
  signal: AbortSignal,
): Promise<Result<Uint8Array, OutputError>> {
  const id = artifactId.from(artifact.artifactId);
  const record = artifacts.get(id);
  if (!record.ok || record.value === null) return err({ code: "missing-artifact" });
  if (
    record.value.invocationId !== task.owner.invocationId ||
    record.value.digest !== artifact.digest ||
    record.value.byteLength !== artifact.byteLength ||
    record.value.availability !== "available"
  )
    return err({ code: "artifact-integrity" });
  const integrity = await artifacts.verifyIntegrity(id, signal);
  if (!integrity.ok || !integrity.value) return err({ code: "artifact-integrity" });
  const read = await artifacts.readRange(id, offset, limit, signal);
  if (!read.ok) return err({ code: read.error.code });
  return ok(read.value.bytes);
}

export type ProcessTaskBytes = {
  readonly bytes: Uint8Array;
  readonly offset: number;
  readonly nextOffset: number;
  readonly availableBytes: number;
  readonly sealed: boolean;
  readonly complete: boolean;
  readonly durableBytes?: number;
};

/** Offsets describe raw artifact bytes, including when the eventual model view is redacted. */
export async function readProcessTaskBytes(
  store: ProcessTaskStore,
  artifacts: ArtifactStorePort,
  task: ProcessTaskSnapshot,
  source: ProcessStreamName | "result",
  offset: number,
  limit: number,
  signal: AbortSignal,
  tail?: ProcessTaskTail,
): Promise<Result<ProcessTaskBytes, OutputError>> {
  if (
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > MAX_PROCESS_TASK_LOG_BYTES
  )
    return err({ code: "invalid-range" });
  let entries: readonly { offset: number; artifact: ProcessTaskArtifact }[];
  if (source === "result") {
    if (task.state !== "terminal") return err({ code: "result-not-sealed" });
    if (task.terminal.result === null) return err({ code: "result-unavailable" });
    entries = [{ offset: 0, artifact: task.terminal.result }];
  } else {
    const loaded = store.chunks(task.handle, source);
    if (!loaded.ok) return loaded;
    entries = loaded.value;
  }
  const durableBytes = entries.reduce((sum, entry) => sum + entry.artifact.byteLength, 0);
  const liveTail = task.state !== "terminal" && source !== "result" ? tail : undefined;
  if (liveTail !== undefined && liveTail.offset > durableBytes)
    return err({ code: "artifact-integrity" });
  const availableBytes = Math.max(
    durableBytes,
    liveTail === undefined ? 0 : liveTail.offset + liveTail.bytes.byteLength,
  );
  if (offset > availableBytes) return err({ code: "invalid-range" });
  const length = Math.min(limit, availableBytes - offset);
  const bytes = new Uint8Array(length);
  let copied = 0;
  for (const entry of entries) {
    if (copied === length) break;
    const start = Math.max(offset + copied, entry.offset);
    const end = Math.min(offset + length, entry.offset + entry.artifact.byteLength);
    if (end <= start) continue;
    const read = await readArtifact(
      artifacts,
      task,
      entry.artifact,
      start - entry.offset,
      end - start,
      signal,
    );
    if (!read.ok) return read;
    if (read.value.byteLength !== end - start) return err({ code: "artifact-integrity" });
    bytes.set(read.value, copied);
    copied += read.value.byteLength;
  }
  if (copied < length && liveTail !== undefined) {
    const start = offset + copied - liveTail.offset;
    const remaining = liveTail.bytes.subarray(start, start + length - copied);
    bytes.set(remaining, copied);
    copied += remaining.byteLength;
  }
  if (copied !== length) return err({ code: "artifact-integrity" });
  const sealed = task.state === "terminal";
  return ok({
    bytes,
    offset,
    nextOffset: offset + copied,
    availableBytes,
    durableBytes,
    sealed,
    complete:
      sealed &&
      offset + copied === availableBytes &&
      (source === "result" || task.terminal.outputComplete === true),
  });
}

/** Even binary views pass through the redactor before base64 encoding. Exact bytes stay in artifacts. */
export function projectProcessTaskBytes(read: ProcessTaskBytes) {
  let text: string;
  let encoding: "utf8" | "base64" = "utf8";
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(read.bytes);
  } catch {
    text = Buffer.from(read.bytes).toString("latin1");
    encoding = "base64";
  }
  const redacted = redactor.redactText(text, Number.MAX_SAFE_INTEGER);
  let data = encoding === "utf8" ? redacted : Buffer.from(redacted, "latin1").toString("base64");
  if (encoding === "utf8" && Buffer.byteLength(JSON.stringify(data)) > 48 * 1_024) {
    encoding = "base64";
    data = Buffer.from(redacted, "utf8").toString("base64");
  }
  return {
    encoding,
    data,
    redacted: redacted !== text,
    exact: redacted === text,
    byteLength: read.bytes.byteLength,
    offset: read.offset,
    nextOffset: read.nextOffset,
    availableBytes: read.availableBytes,
    durableBytes: read.durableBytes ?? read.availableBytes,
    sealed: read.sealed,
    complete: read.complete,
  };
}
