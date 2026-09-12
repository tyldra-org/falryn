/** Bounded, read-only semantic history. No runner or mutation port is accepted. */
import { type ArtifactRecord, type ArtifactStorePort, artifactId } from "../artifacts/index.ts";
import type { Sequence, StreamId } from "../foundation/index.ts";
import type { RuntimeEvent } from "./event.ts";
import type { EventStorePort } from "./event-store.ts";
import { HISTORY_LIMITS } from "./history.ts";

export type HistoryAvailability =
  | "exact"
  | "reduced"
  | "missing"
  | "expired"
  | "redacted"
  | "unauthorized"
  | "corrupt"
  | "unavailable"
  | "cancelled";
export type HistoryReadItem = {
  readonly references?: readonly {
    readonly artifactId: string | null;
    readonly availability: HistoryAvailability;
    readonly text: string | null;
    readonly reason: string | null;
  }[];
  readonly event: RuntimeEvent | null;
  readonly availability: HistoryAvailability;
  readonly text: string | null;
  readonly reason: string | null;
};
export function createHistoryReader(options: {
  readonly digest: (value: string | Uint8Array) => string;
  readonly events: EventStorePort;
  readonly artifacts?: Pick<ArtifactStorePort, "get" | "readRange">;
  /** Trusted current scope and retention policy. Denied facts expose no event identity. */
  readonly authorize: (event: RuntimeEvent, artifact: ArtifactRecord | null) => boolean;
  /** Export may preserve an authorized fact's position with all denied evidence removed. */
  readonly redactDeniedEvidence?: boolean;
}) {
  return {
    async page(
      input: {
        readonly streamId: StreamId;
        readonly afterSequence: Sequence | null;
        readonly limit?: number;
        readonly maxBytes?: number;
      },
      signal = new AbortController().signal,
    ) {
      const limit = input.limit ?? 32;
      const maxBytes = input.maxBytes ?? HISTORY_LIMITS.readBytes;
      if (
        !Number.isSafeInteger(limit) ||
        limit < 1 ||
        limit > HISTORY_LIMITS.page ||
        !Number.isSafeInteger(maxBytes) ||
        maxBytes < 0 ||
        maxBytes > HISTORY_LIMITS.readBytes
      )
        return { ok: false as const, code: "malformed" };
      const read = await options.events.readFrom(
        { streamId: input.streamId, afterSequence: input.afterSequence },
        limit + 1,
        signal,
      );
      if (!read.ok) return { ok: false as const, code: read.error.code };
      const items: HistoryReadItem[] = [];
      let bytes = 0;
      for (const event of read.value.slice(0, limit)) {
        let item = await resolve(event, maxBytes - bytes, signal);
        bytes += item.text === null ? 0 : new TextEncoder().encode(item.text).byteLength;
        if (
          item.event &&
          item.availability !== "expired" &&
          event.kind === "history.recorded" &&
          event.payload.references?.length
        ) {
          const references = [];
          for (const reference of event.payload.references) {
            const resolved = await resolve(
              { ...event, payload: { ...event.payload, evidence: reference, references: [] } },
              maxBytes - bytes,
              signal,
            );
            bytes +=
              resolved.text === null ? 0 : new TextEncoder().encode(resolved.text).byteLength;
            references.push({
              artifactId:
                resolved.availability === "unauthorized"
                  ? null
                  : reference.availability === "retained"
                    ? reference.artifactId
                    : (reference.reference?.artifactId ?? null),
              availability: resolved.availability,
              text: resolved.text,
              reason: resolved.reason,
            });
          }
          item = references.some((reference) => reference.availability === "unauthorized")
            ? deniedEvidence(event, "referenced-evidence-authority")
            : {
                ...item,
                references,
                ...(item.availability === "exact" &&
                references.some((reference) => reference.availability !== "exact")
                  ? { availability: "reduced" as const, reason: "referenced-evidence-unavailable" }
                  : {}),
              };
        }

        items.push(item);
      }
      return {
        ok: true as const,
        items,
        bytes,
        next: read.value.length > limit ? (read.value[limit - 1]?.sequence ?? null) : null,
        partial: items.some((item) => item.availability !== "exact"),
      };
    },
  };
  function deniedEvidence(event: RuntimeEvent, reason: string): HistoryReadItem {
    return {
      event:
        options.redactDeniedEvidence && event.kind === "history.recorded"
          ? {
              ...event,
              payload: {
                ...event.payload,
                evidence: { availability: "unavailable", fidelity: "unknown", reason: "redacted" },
                references: [],
              },
            }
          : null,
      availability: "unauthorized",
      text: null,
      reason,
    };
  }
  function retired(event: RuntimeEvent): HistoryReadItem | null {
    if (event.kind !== "history.recorded" || event.payload.type !== "restore-point") return null;
    const current = options.events.historyRetirement?.(
      event.streamId,
      event.payload.restorePointId,
    );
    if (!current?.ok)
      return {
        event: null,
        availability: "unavailable",
        text: null,
        reason: "restore-lineage-unavailable",
      };
    if (!current.value) return null;
    const omit = (evidence: typeof event.payload.evidence) => ({
      availability: "unavailable" as const,
      fidelity: "unknown" as const,
      reason: "expired" as const,
      ...(evidence.availability === "retained"
        ? {
            reference: {
              artifactId: evidence.artifactId,
              digest: evidence.digest,
              byteLength: evidence.byteLength,
            },
          }
        : evidence.availability === "unavailable" && evidence.reference
          ? { reference: evidence.reference }
          : {}),
    });
    return {
      event: {
        ...event,
        payload: {
          ...event.payload,
          evidence: omit(event.payload.evidence),
          ...(event.payload.references ? { references: event.payload.references.map(omit) } : {}),
        },
      },
      availability: "expired",
      text: null,
      reason: `restore-point-${current.value.reason}`,
    };
  }
  async function resolve(
    event: RuntimeEvent,
    remaining: number,
    signal: AbortSignal,
  ): Promise<HistoryReadItem> {
    const fail = (availability: HistoryAvailability, reason: string): HistoryReadItem => ({
      // Preserve authorized metadata for export, but never refused inline bytes.
      event:
        availability === "unauthorized"
          ? null
          : event.kind === "history.recorded" && event.payload.evidence.availability === "inline"
            ? {
                ...event,
                payload: {
                  ...event.payload,
                  evidence: {
                    availability: "unavailable",
                    fidelity: "unknown",
                    reason: "redacted",
                  },
                },
              }
            : event,
      availability,
      text: null,
      reason,
    });
    if (!options.authorize(event, null)) return fail("unauthorized", "current-authority");
    if (signal.aborted) return fail("cancelled", "cancelled");
    if (event.kind !== "history.recorded")
      return { event, availability: "exact", text: null, reason: null };
    const retirement = retired(event);
    if (retirement) return retirement;
    const evidence = event.payload.evidence;
    if (evidence.availability === "unavailable")
      return fail(
        ["redacted", "missing", "expired", "corrupt", "cancelled"].includes(evidence.reason)
          ? (evidence.reason as HistoryAvailability)
          : "unavailable",
        evidence.reason,
      );
    if (evidence.availability === "inline") {
      if (
        new TextEncoder().encode(evidence.text).byteLength !== evidence.byteLength ||
        options.digest(evidence.text) !== evidence.digest
      )
        return fail("corrupt", "inline-digest");
      if (evidence.byteLength > remaining) return fail("reduced", "page-byte-limit");
      return {
        event,
        availability: evidence.fidelity === "exact" ? "exact" : "redacted",
        text: evidence.text,
        reason: null,
      };
    }
    if (!options.artifacts) return fail("unavailable", "artifact-store");
    const id = artifactId.parse(evidence.artifactId);
    if (!id.ok) return fail("corrupt", "artifact-identity");
    const found = options.artifacts.get(id.value);
    if (!found.ok) return fail("unavailable", "artifact-metadata");
    const record = found.value;
    if (!record) return fail("missing", "artifact-metadata");
    if (!options.authorize(event, record) || record.sensitivity === "restricted")
      return deniedEvidence(event, "artifact-authority");
    if (record.availability === "missing") return fail("expired", "retained-bytes-unavailable");
    if (record.availability === "quarantined") return fail("corrupt", "quarantined");
    if (record.availability !== "available") return fail("unavailable", "unsealed");
    if (String(record.digest) !== evidence.digest || record.byteLength !== evidence.byteLength)
      return fail("corrupt", "metadata-digest");
    if (evidence.byteLength > remaining) return fail("reduced", "page-byte-limit");
    const read = await options.artifacts.readRange(id.value, 0, evidence.byteLength, signal);
    if (!read.ok) return fail(signal.aborted ? "cancelled" : "missing", "artifact-read");
    if (
      read.value.byteLength !== evidence.byteLength ||
      options.digest(read.value.bytes) !== evidence.digest
    )
      return fail("corrupt", "content-digest");
    const retirementAfterRead = retired(event);
    if (retirementAfterRead) return retirementAfterRead;
    const current = options.artifacts.get(id.value);
    if (!current.ok || !current.value) return fail("missing", "authority-metadata-unavailable");
    if (!options.authorize(event, current.value) || current.value.sensitivity === "restricted")
      return deniedEvidence(event, "authority-changed");
    if (signal.aborted) return fail("cancelled", "cancelled");
    if (
      current.value.availability !== "available" ||
      String(current.value.digest) !== evidence.digest
    )
      return fail("unavailable", "retention-changed");
    try {
      return {
        event,
        availability: evidence.fidelity === "exact" ? "exact" : "redacted",
        text: new TextDecoder("utf-8", { fatal: true }).decode(read.value.bytes),
        reason: null,
      };
    } catch {
      return fail("corrupt", "encoding");
    }
  }
}

export type HistoryReader = ReturnType<typeof createHistoryReader>;
export type HistoryPage = Extract<Awaited<ReturnType<HistoryReader["page"]>>, { ok: true }>;
