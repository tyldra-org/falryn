/** Selected composer resources are required evidence, never incidental retrieval candidates. */
import type {
  AttachmentDescriptor,
  MentionSpan,
  PromptSectionInput,
} from "../../domain/context/index.ts";
import type { ResourceTarget } from "../../domain/documents/resource-read.ts";
import type { Result } from "../../domain/foundation/index.ts";
import { NO_RETRY, workUnitId } from "../../domain/orchestration/index.ts";
import { type ResourceResolver, resourceDigest } from "../documents/resource-resolver.ts";
import type { ProductTaskResources } from "../orchestration/product-resources.ts";

export type ResourceAttachmentSelection = {
  readonly attachments: readonly AttachmentDescriptor[];
  readonly mentions: readonly MentionSpan[];
  readonly payloads?: { get(id: string): Uint8Array | null };
};
export async function admitResourceAttachments(
  selection: ResourceAttachmentSelection,
  resources: ResourceResolver | undefined,
  task: ProductTaskResources,
  signal: AbortSignal,
) {
  if (selection.attachments.length === 0)
    return prepareResourceAttachments(selection, resources, signal);
  if (selection.attachments.length > 16)
    return { ok: false as const, error: { code: "attachment-count-limit" } };
  const bytes = selection.attachments.reduce((sum, item) => sum + item.byteLength, 0);
  if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > 16 * 1024 * 1024)
    return { ok: false as const, error: { code: "attachment-aggregate-limit" } };
  const admitted = await task.execute({
    operation: "selected-resource-admission",
    attempt: "1",
    generation: task.generation,
    unit: {
      id: workUnitId(`${task.id}:attachments`),
      priority: "interactive",
      effect: "observation",
      conflictKeys: [],
      dependencies: [],
      deadline: null,
      expectedOutputBytes: 64 * 1024,
      retry: NO_RETRY,
      scopeId: null,
    },
    inputBytes: bytes,
    amounts: { operations: selection.attachments.length, memoryBytes: 16 * 1024 * 1024 },
    signal,
    async run(admittedSignal) {
      return {
        value: await prepareResourceAttachments(selection, resources, admittedSignal),
        terminated: true,
        observedEffect: "none",
      };
    },
  });
  return admitted.kind === "completed"
    ? admitted.value
    : { ok: false as const, error: { code: `attachment-admission-${admitted.receipt.state}` } };
}
export async function prepareResourceAttachments(
  selection: ResourceAttachmentSelection,
  resources: ResourceResolver | undefined,
  signal?: AbortSignal,
): Promise<Result<readonly PromptSectionInput[], { code: string }>> {
  const fail = (code: string) => ({ ok: false as const, error: { code } });
  if (selection.attachments.length > 16) return fail("attachment-count-limit");
  if (
    selection.mentions.some(
      (mention) => !selection.attachments.some((item) => item.identity === mention.identity),
    )
  )
    return fail("unresolved-mention");
  if (selection.attachments.length === 0) return { ok: true, value: [] };
  if (!resources) return fail("attachment-reader-unavailable");
  const sections: PromptSectionInput[] = [];
  const seen = new Set<string>();
  let remaining = 16 * 1024;
  for (const attachment of selection.attachments) {
    if (signal?.aborted) return fail("cancelled");
    if (seen.has(attachment.identity)) continue;
    seen.add(attachment.identity);
    if (attachment.status !== "ready") return fail(`attachment-${attachment.status}`);
    if (attachment.secret) return fail("attachment-denied");
    if (!/^(?:text\/|application\/(?:json|xml)$)/u.test(attachment.mediaType))
      return fail("attachment-unsupported-media");
    if (remaining <= 0) return fail("attachment-aggregate-limit");
    let target: ResourceTarget;
    if (attachment.kind === "file") target = { kind: "workspace", path: attachment.identity };
    else if (attachment.kind === "artifact") {
      const selected = await resources.selectArtifact(
        attachment.identity.replace(/^artifact:/u, ""),
        signal,
      );
      if (!selected.ok) return selected;
      target = selected.value;
    } else {
      const bytes = selection.payloads?.get(attachment.id);
      if (!bytes) return fail("attachment-payload-unavailable");
      if (
        bytes.length !== attachment.byteLength ||
        attachment.digest === null ||
        resourceDigest(bytes) !== attachment.digest
      )
        return fail("attachment-stale");
      const retained = await resources.retainSelection(
        attachment.identity,
        bytes,
        attachment.mediaType,
        signal,
      );
      if (!retained.ok) return retained;
      target = retained.value;
    }
    const read = await resources.read(
      { resources: [target], projection: { kind: "exact" }, maxBytes: remaining },
      signal,
    );
    if (!read.ok) return read;
    const item = read.value.items[0];
    if (item?.status !== "read") return fail(item?.code ?? "attachment-unavailable");
    if (
      (attachment.digest !== null && attachment.digest !== item.source.digest) ||
      (attachment.revision !== null && attachment.revision !== item.source.revision) ||
      attachment.byteLength !== item.source.byteLength
    )
      return fail("attachment-stale");
    remaining -= read.value.aggregateBytes;
    sections.push({
      id: `selected-resource-${String(sections.length).padStart(2, "0")}`,
      role: "evidence",
      source: attachment.identity,
      required: true,
      available: true,
      content: JSON.stringify({
        selection: attachment.identity,
        kind: attachment.kind,
        resource: item,
      }),
    });
  }
  return { ok: true, value: sections };
}
