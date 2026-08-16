/**
 * Resolve composer attachments and `@` mentions into evidence candidates (#278).
 *
 * The TUI never stats a path or reads a file. This seam binds, stats, and
 * hashes through the existing workspace path binder and filesystem port, then
 * admits candidates. It does not rank, pack, or render provider input.
 */

import { createHash } from "node:crypto";

import {
  type AttachmentDescriptor,
  type AttachmentStatus,
  admitEvidenceCandidate,
  CONTENT_DIGEST_ALGORITHM,
  type ContentDigest,
  contentDigest,
  type EvidenceCandidate,
  type EvidenceCandidateInput,
  type FileSystemPort,
  type LocalPath,
  MAX_EVIDENCE_INLINE_BYTES,
  type MentionSpan,
  parseLocalPath,
} from "../domain/index.ts";
import {
  createWorkspacePathBinder,
  type WorkspacePathBinder,
  type WorkspacePathProbeError,
} from "./workspace-path.ts";

export type FileAttachmentProbe = {
  inspect(logicalPath: string, previous?: AttachmentDescriptor): Promise<AttachmentDescriptor>;
  readText(logicalPath: string): Promise<string | null>;
};

export type ComposerContextRequest = {
  readonly attachments: readonly AttachmentDescriptor[];
  readonly mentions: readonly MentionSpan[];
  readonly payloads: {
    get(id: string): Uint8Array | null;
  };
  readonly workspaceId?: string | null;
};

export type ComposerContextResolution =
  | {
      readonly ok: true;
      readonly attachments: readonly AttachmentDescriptor[];
      readonly candidates: readonly EvidenceCandidate[];
    }
  | {
      readonly ok: false;
      readonly attachments: readonly AttachmentDescriptor[];
      readonly reason: string;
    };

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function digestBytes(bytes: Uint8Array): ContentDigest {
  const hash = createHash("sha256");
  hash.update(bytes);
  return contentDigest.from(`${CONTENT_DIGEST_ALGORITHM}:${hash.digest("hex")}`);
}

export function createFileAttachmentProbe(options: {
  readonly fileSystem: FileSystemPort;
  readonly workspace: LocalPath | string | null;
}): FileAttachmentProbe | null {
  if (options.workspace === null) {
    return null;
  }
  const parsed =
    typeof options.workspace === "string"
      ? parseLocalPath(options.workspace)
      : { ok: true as const, value: options.workspace };
  if (!parsed.ok) {
    return null;
  }
  const root = parsed.value;
  const binder = createWorkspacePathBinder(options.fileSystem);
  return {
    inspect(logicalPath, previous) {
      return inspectFile(options.fileSystem, binder, root, logicalPath, previous);
    },
    async readText(logicalPath) {
      const bound = await binder.bind(root, logicalPath);
      if (!bound.ok) {
        return null;
      }
      const bytes = await options.fileSystem.readBytes(
        bound.value.resolved,
        MAX_EVIDENCE_INLINE_BYTES,
      );
      if (!bytes.ok) {
        return null;
      }
      return decoder.decode(bytes.value);
    },
  };
}

async function inspectFile(
  fileSystem: FileSystemPort,
  binder: WorkspacePathBinder,
  root: LocalPath,
  logicalPath: string,
  previous: AttachmentDescriptor | undefined,
): Promise<AttachmentDescriptor> {
  const id = previous?.id ?? `file-${logicalPath.replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 80)}`;
  const base: Omit<AttachmentDescriptor, "status"> = {
    id,
    kind: "file",
    identity: logicalPath,
    byteLength: previous?.byteLength ?? 0,
    characters: null,
    lines: null,
    digest: previous?.digest ?? null,
    revision: previous?.revision ?? null,
    mediaType: "text/plain",
    secret: previous?.secret ?? false,
  };

  const bound = await binder.bind(root, logicalPath);
  if (!bound.ok) {
    return { ...base, status: statusForProbe(bound.error.code) };
  }

  const stated = await fileSystem.stat(bound.value.resolved);
  if (!stated.ok || stated.value === null) {
    return { ...base, status: "inaccessible" };
  }
  if (stated.value.kind !== "file") {
    return { ...base, status: "unsupported", byteLength: 0, digest: null };
  }

  const byteLength = stated.value.byteLength;
  const revision = stated.value.revision;
  if (byteLength > MAX_EVIDENCE_INLINE_BYTES) {
    return { ...base, status: "oversized", byteLength, revision, digest: null };
  }
  if (byteLength < 1) {
    return { ...base, status: "unsupported", byteLength, revision, digest: null };
  }

  const bytes = await fileSystem.readBytes(bound.value.resolved, MAX_EVIDENCE_INLINE_BYTES);
  if (!bytes.ok) {
    return { ...base, status: "inaccessible", byteLength, revision };
  }

  const digest = digestBytes(bytes.value);
  return {
    ...base,
    status: statusAfterDigest(previous, digest, revision),
    byteLength,
    revision,
    digest,
  };
}

function statusAfterDigest(
  previous: AttachmentDescriptor | undefined,
  digest: ContentDigest,
  revision: string,
): AttachmentStatus {
  if (previous?.digest !== null && previous?.digest !== undefined && previous.digest !== digest) {
    return "changed";
  }
  if (
    previous?.revision !== null &&
    previous?.revision !== undefined &&
    previous.revision !== revision
  ) {
    return "stale";
  }
  return "ready";
}

function statusForProbe(code: WorkspacePathProbeError["code"]): AttachmentStatus {
  switch (code) {
    case "cancelled":
      return "unavailable";
    case "symlink-escape":
    case "escaped":
    case "absolute-unscoped":
    case "malformed":
    case "filesystem":
      return "inaccessible";
    default: {
      const exhaustive: never = code;
      return exhaustive;
    }
  }
}

export async function refreshAttachments(
  attachments: readonly AttachmentDescriptor[],
  probe: FileAttachmentProbe | null,
): Promise<readonly AttachmentDescriptor[]> {
  const next: AttachmentDescriptor[] = [];
  for (const attachment of attachments) {
    if (attachment.kind !== "file") {
      next.push(attachment);
      continue;
    }
    if (probe === null) {
      next.push({ ...attachment, status: "unavailable" });
      continue;
    }
    next.push(await probe.inspect(attachment.identity, attachment));
  }
  return next;
}

export async function admitComposerContext(
  request: ComposerContextRequest,
  probe: FileAttachmentProbe | null,
): Promise<ComposerContextResolution> {
  const withMentions = await resolveComposerAttachments(
    request.attachments,
    request.mentions,
    probe,
  );
  const blocking = withMentions.filter((item) => item.status !== "ready");
  if (blocking.length > 0) {
    const first = blocking[0];
    return {
      ok: false,
      attachments: withMentions,
      reason:
        first === undefined ? "an attachment is not ready" : `${first.identity} is ${first.status}`,
    };
  }

  const candidates: EvidenceCandidate[] = [];
  for (const attachment of withMentions) {
    const input = await candidateInput(attachment, request, probe);
    if (input === null) {
      return {
        ok: false,
        attachments: withMentions.map((item) =>
          item.id === attachment.id ? { ...item, status: "partial" } : item,
        ),
        reason: `${attachment.identity} could not be admitted`,
      };
    }
    const admitted = admitEvidenceCandidate(input);
    if (!admitted.ok) {
      return {
        ok: false,
        attachments: withMentions.map((item) =>
          item.id === attachment.id ? { ...item, status: "partial" } : item,
        ),
        reason: `${attachment.identity} could not be admitted`,
      };
    }
    candidates.push(admitted.value);
  }
  return { ok: true, attachments: withMentions, candidates };
}

export async function resolveComposerAttachments(
  attachments: readonly AttachmentDescriptor[],
  mentions: readonly MentionSpan[],
  probe: FileAttachmentProbe | null,
): Promise<readonly AttachmentDescriptor[]> {
  const refreshed = await refreshAttachments(attachments, probe);
  return attachmentsForMentions(refreshed, mentions, probe);
}

async function attachmentsForMentions(
  attachments: readonly AttachmentDescriptor[],
  mentions: readonly MentionSpan[],
  probe: FileAttachmentProbe | null,
): Promise<readonly AttachmentDescriptor[]> {
  const next = [...attachments];
  for (const mention of mentions) {
    if (mention.kind === "unsupported") {
      next.push(unsupportedMention(mention.identity));
      continue;
    }
    if (mention.kind !== "file") {
      continue;
    }
    if (next.some((item) => item.kind === "file" && item.identity === mention.identity)) {
      continue;
    }
    if (probe === null) {
      next.push({
        ...unsupportedMention(mention.identity),
        kind: "file",
        status: "unavailable",
        mediaType: "text/plain",
      });
      continue;
    }
    next.push(await probe.inspect(mention.identity));
  }
  return next;
}

function unsupportedMention(identity: string): AttachmentDescriptor {
  return {
    id: `mention:${identity}`,
    kind: "artifact",
    identity,
    status: "unsupported",
    byteLength: 0,
    characters: null,
    lines: null,
    digest: null,
    revision: null,
    mediaType: "application/octet-stream",
    secret: false,
  };
}

async function candidateInput(
  attachment: AttachmentDescriptor,
  request: ComposerContextRequest,
  probe: FileAttachmentProbe | null,
): Promise<EvidenceCandidateInput | null> {
  const text = await inlineText(attachment, request, probe);
  if (text === null || text.length === 0) {
    return null;
  }
  const bytes = encoder.encode(text);
  const digest = attachment.digest ?? digestBytes(bytes);
  return {
    id: `ev-${attachment.id}`,
    sourceKind: attachment.kind === "file" ? "file" : "attachment",
    origin: attachment.identity,
    ...(request.workspaceId === undefined || request.workspaceId === null
      ? {}
      : { workspaceId: request.workspaceId }),
    payload: { kind: "inline", text },
    estimatedTokens: Math.max(1, Math.ceil(bytes.byteLength / 4)),
    freshness: attachment.kind === "file" ? "live" : "snapshot",
    sensitivity: attachment.secret ? "sensitive" : "user-content",
    trust: "user-confirmed",
    fidelity: "exact-source",
    exactSource: {
      kind: "inline",
      digest,
      byteLength: bytes.byteLength,
    },
  };
}

async function inlineText(
  attachment: AttachmentDescriptor,
  request: ComposerContextRequest,
  probe: FileAttachmentProbe | null,
): Promise<string | null> {
  const held = request.payloads.get(attachment.id);
  if (held !== null) {
    return decoder.decode(held);
  }
  if (attachment.kind === "file" && probe !== null) {
    return probe.readText(attachment.identity);
  }
  return null;
}
