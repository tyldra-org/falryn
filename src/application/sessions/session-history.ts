/** Capture exact public evidence before publishing it in the existing journal. */
import { createHash, randomUUID } from "node:crypto";
import { type ArtifactStorePort, artifactId, contentDigest } from "../../domain/artifacts/index.ts";
import { deadlineAt, instant, type TurnId } from "../../domain/foundation/index.ts";
import { conflictKey, NO_RETRY, workUnitId } from "../../domain/orchestration/index.ts";
import {
  HISTORY_LIMITS,
  type HistoryEvidence,
  type HistoryMetadata,
  type HistoryReference,
  historyPayloadSchema,
} from "../../domain/sessions/history.ts";
import type { SessionCorrelation } from "../../domain/sessions/index.ts";
import { createRuntimeProjectionRedactor } from "../diagnostics/redaction.ts";
import type { ProductTaskResources } from "../orchestration/product-resources.ts";
import type { TurnEventJournalPort } from "../runtime/turn-event-journal.ts";

export type SessionHistory = ReturnType<typeof createSessionHistory>;
export function historyDigest(value: string | Uint8Array): string {
  return `sha-256:${createHash("sha256").update(value).digest("hex")}`;
}
export function createSessionHistory(options: {
  readonly journal: TurnEventJournalPort;
  readonly correlation: SessionCorrelation;
  readonly artifacts?: ArtifactStorePort;
}) {
  const redactor = createRuntimeProjectionRedactor();
  async function seal(
    metadata: HistoryMetadata,
    text: string,
    signal: AbortSignal,
  ): Promise<HistoryEvidence> {
    if (signal.aborted)
      return { availability: "unavailable", reason: "cancelled", fidelity: "unknown" };
    if (Buffer.byteLength(text) > HISTORY_LIMITS.contentBytes)
      return { availability: "unavailable", reason: "oversized", fidelity: "unknown" };
    let safe: string;
    if (metadata.type === "message") safe = redactor.redactText(text, HISTORY_LIMITS.contentBytes);
    else {
      // Input is bounded before parsing. Secret-named JSON fields need structural
      // redaction; free-text credential patterns alone cannot recognize them.
      const scrub = (value: unknown, depth: number): unknown => {
        if (depth > 32) throw new Error("history-json-depth");
        if (typeof value === "string") {
          if (/^\s*[[{]/u.test(value)) {
            try {
              return JSON.stringify(scrub(JSON.parse(value), depth + 1));
            } catch {
              /* Malformed text follows redaction below. */
            }
          }
          return redactor.redactText(value, HISTORY_LIMITS.contentBytes);
        }
        if (Array.isArray(value)) return value.map((item) => scrub(item, depth + 1));
        if (value !== null && typeof value === "object")
          return Object.fromEntries(
            Object.entries(value).map(([key, item]) => [
              key,
              redactor.isSecretName(key) || key === "argumentsFragment"
                ? redactor.placeholder
                : scrub(item, depth + 1),
            ]),
          );
        return value;
      };
      safe = JSON.stringify(scrub(JSON.parse(text), 0));
    }
    const bytes = new TextEncoder().encode(safe);
    const digest = historyDigest(bytes);
    if (bytes.length <= HISTORY_LIMITS.inlineBytes)
      return {
        availability: "inline",
        text: safe,
        digest,
        byteLength: bytes.length,
        sensitivity: "user-content",
        fidelity: safe === text ? "exact" : "redacted",
      };
    if (!options.artifacts)
      return {
        availability: "unavailable",
        reason: safe === text ? "storage-failed" : "redacted",
        fidelity: "unknown",
      };
    const id = artifactId.from(
      `history-${historyDigest(`${options.correlation.sessionId}:${metadata.id}:${digest}`).slice(8)}`,
    );
    const existing = options.artifacts.get(id);
    if (!existing.ok)
      return { availability: "unavailable", reason: "storage-failed", fidelity: "unknown" };
    let record = existing.value;
    if (record !== null) {
      const verified = await options.artifacts.verifyIntegrity(id, signal);
      if (!verified.ok || !verified.value)
        return { availability: "unavailable", reason: "storage-failed", fidelity: "unknown" };
      const current = options.artifacts.get(id);
      record = current.ok ? current.value : null;
      if (record === null)
        return { availability: "unavailable", reason: "storage-failed", fidelity: "unknown" };
    }
    if (record === null) {
      const ingested = await options.artifacts.ingest(
        {
          artifactId: id,
          mediaType: metadata.type === "message" ? "text/plain" : "application/json",
          encoding: "identity",
          sensitivity: "user-content",
          origin:
            metadata.type === "message"
              ? metadata.role === "user"
                ? "user-supplied"
                : "model-output"
              : "tool-output",
          invocationId: null,
          declaredByteLength: bytes.length,
          expectedDigest: contentDigest.from(digest),
          content: (async function* () {
            yield bytes;
          })(),
        },
        signal,
      );
      if (ingested.ok) record = ingested.value.record;
    }
    if (
      record?.availability !== "available" ||
      String(record.digest) !== digest ||
      record.byteLength !== bytes.length
    )
      return { availability: "unavailable", reason: "storage-failed", fidelity: "unknown" };
    return {
      availability: "retained",
      artifactId: String(id),
      digest,
      byteLength: bytes.length,
      sensitivity: record.sensitivity,
      fidelity: safe === text ? "exact" : "redacted",
      mediaType: metadata.type === "message" ? "text/plain" : "application/json",
    };
  }
  async function capture(
    turnId: TurnId,
    metadata: HistoryMetadata,
    text: string | null,
    signal: AbortSignal,
  ) {
    let evidence: HistoryEvidence;
    try {
      evidence =
        text === null
          ? { availability: "unavailable", reason: "not-recorded", fidelity: "unknown" }
          : await seal(metadata, text, signal);
    } catch {
      evidence = {
        availability: "unavailable",
        reason: "storage-failed",
        fidelity: "unknown",
      };
    }
    const parsed = historyPayloadSchema.safeParse({ ...metadata, evidence });
    if (!parsed.success)
      return {
        value: { committed: false, evidence },
        terminated: true,
        observedEffect: "none" as const,
      };
    let committed = false;
    try {
      const publish = (
        evidence: HistoryEvidence,
        references: readonly HistoryReference[] | undefined = parsed.data.references,
      ) =>
        options.journal.persist([
          {
            kind: "history.recorded",
            correlation: { ...options.correlation, turnId },
            payload: {
              ...parsed.data,
              evidence,
              ...(references ? { references: [...references] } : {}),
            },
          },
        ]);
      const persisted = await publish(evidence);
      committed = persisted.kind === "persisted";
      if (
        !committed &&
        (evidence.availability === "retained" ||
          parsed.data.references?.some((reference) => reference.availability === "retained"))
      ) {
        // GC or a failed seal/publication boundary cannot leave a success
        // handle. The failed append has not consumed a sequence.
        evidence = {
          availability: "unavailable",
          reason: "storage-failed",
          fidelity: "unknown",
        };
        committed =
          (
            await publish(
              evidence,
              parsed.data.references?.map((reference) =>
                reference.availability === "retained"
                  ? {
                      availability: "unavailable",
                      fidelity: "unknown",
                      reason: "storage-failed",
                      reference: {
                        artifactId: reference.artifactId,
                        digest: reference.digest,
                        byteLength: reference.byteLength,
                      },
                    }
                  : reference,
              ),
            )
          ).kind === "persisted";
      }
    } catch {
      /* Projection or adapter failure cannot claim a complete delivery. */
    }

    return {
      value: { committed, evidence },
      terminated: true,
      observedEffect: "none" as const,
    };
  }
  return {
    /** Called only inside an existing provider reservation that owns the buffer and deadline. */
    async recordWithinAdmission(
      turnId: TurnId,
      metadata: HistoryMetadata,
      text: string | null,
      signal: AbortSignal,
    ) {
      return (await capture(turnId, metadata, text, signal)).value;
    },
    async record(
      turnId: TurnId,
      metadata: HistoryMetadata,
      text: string | null,
      resources: ProductTaskResources,
      signal = new AbortController().signal,
    ) {
      const id = `history:${randomUUID()}`;
      const executed = await resources.execute({
        target: {
          kind: "session-history",
          workspaceId: String(options.correlation.workspaceId),
          configurationGeneration: String(options.correlation.configurationGeneration),
        },
        operation: id,
        attempt: id,
        generation: resources.generation,
        unit: {
          id: workUnitId(id),
          effect: "observation",
          priority: "interactive",
          conflictKeys: [conflictKey("session-history", String(options.correlation.sessionId))],
          dependencies: [],
          deadline: deadlineAt(instant(Math.min(Date.now() + 30000, resources.expiresAt))),
          expectedOutputBytes: 8192,
          retry: NO_RETRY,
          scopeId: null,
        },
        inputBytes: Math.min(
          text === null ? 0 : Buffer.byteLength(text),
          HISTORY_LIMITS.contentBytes,
        ),
        amounts: {
          operations: 1,
          bufferedBytes:
            Math.min(text === null ? 0 : Buffer.byteLength(text), HISTORY_LIMITS.contentBytes) +
            8192,
          bufferedItems: 1,
        },
        signal,
        async run(admittedSignal) {
          return capture(turnId, metadata, text, admittedSignal);
        },
      });
      return executed.kind === "completed"
        ? executed.value
        : {
            committed: false,
            evidence: {
              availability: "unavailable",
              reason: "storage-failed",
              fidelity: "unknown",
            } as const,
          };
    },
  };
}
