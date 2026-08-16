/**
 * Composer attachment handles and `@` mention tokens (#278).
 *
 * These are identities, not content. A descriptor names a paste, a workspace
 * file, or a session artifact and says whether it is ready to send. Bytes live
 * behind a payload port or on disk; chrome, composer state, and the submission
 * snapshot never carry a body.
 *
 * Parsing mentions is lexical: an `@` token in the draft is a reference the
 * submit path must resolve, not a search popup. Kinds this build cannot resolve
 * stay `unsupported` rather than guessing.
 */

export const ATTACHMENT_KINDS = ["paste", "file", "artifact"] as const;
export type AttachmentKind = (typeof ATTACHMENT_KINDS)[number];

export const ATTACHMENT_STATUSES = [
  "ready",
  "unavailable",
  "stale",
  "changed",
  "oversized",
  "unsupported",
  "inaccessible",
  "partial",
] as const;
export type AttachmentStatus = (typeof ATTACHMENT_STATUSES)[number];

/** Statuses that must not ride a submission. */
export const BLOCKING_ATTACHMENT_STATUSES: readonly AttachmentStatus[] = [
  "unavailable",
  "stale",
  "changed",
  "oversized",
  "unsupported",
  "inaccessible",
  "partial",
];

export type AttachmentDescriptor = {
  readonly id: string;
  readonly kind: AttachmentKind;
  /** Stable display identity used for deduplication. */
  readonly identity: string;
  readonly status: AttachmentStatus;
  readonly byteLength: number;
  readonly characters: number | null;
  readonly lines: number | null;
  readonly digest: string | null;
  /** Adapter revision from stat, files only. Compared at submit. */
  readonly revision: string | null;
  readonly mediaType: string;
  readonly secret: boolean;
};

export const MENTION_KINDS = ["file", "paste", "artifact", "unsupported"] as const;
export type MentionKind = (typeof MENTION_KINDS)[number];

export type MentionSpan = {
  readonly start: number;
  readonly end: number;
  readonly raw: string;
  readonly kind: MentionKind;
  readonly identity: string;
};

const MENTION_TOKEN = /^[A-Za-z0-9_./:-]+$/;

/**
 * `@` mentions in a draft.
 *
 * A token starts at `@` that is not part of an email (the previous character
 * is not alphanumeric or `_`) and runs through path-safe characters. `session:`
 * and `mcp:` prefixes are recorded as unsupported rather than resolved.
 */
export function parseMentions(text: string): readonly MentionSpan[] {
  const spans: MentionSpan[] = [];
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] !== "@") {
      continue;
    }
    const previous = index === 0 ? "" : (text[index - 1] ?? "");
    if (previous !== "" && /[A-Za-z0-9_]/.test(previous)) {
      continue;
    }
    let end = index + 1;
    while (end < text.length && MENTION_TOKEN.test(text[end] ?? "")) {
      end += 1;
    }
    if (end === index + 1) {
      continue;
    }
    const identity = text.slice(index + 1, end);
    spans.push({
      start: index,
      end,
      raw: text.slice(index, end),
      kind: mentionKindOf(identity),
      identity,
    });
  }
  return spans;
}

function mentionKindOf(identity: string): MentionKind {
  if (identity.startsWith("session:") || identity.startsWith("mcp:")) {
    return "unsupported";
  }
  if (identity.startsWith("paste:")) {
    return "paste";
  }
  if (identity.startsWith("artifact:")) {
    return "artifact";
  }
  return "file";
}

export function attachmentKey(attachment: AttachmentDescriptor): string {
  return `${attachment.kind}:${attachment.identity}`;
}

export function isBlockingAttachment(attachment: AttachmentDescriptor): boolean {
  return (BLOCKING_ATTACHMENT_STATUSES as readonly string[]).includes(attachment.status);
}

export function blockingAttachments(
  attachments: readonly AttachmentDescriptor[],
): readonly AttachmentDescriptor[] {
  return attachments.filter(isBlockingAttachment);
}

/**
 * Insert or replace by identity. Order is preserved; a duplicate identity
 * keeps the incoming descriptor at the earlier slot.
 */
export function upsertAttachment(
  attachments: readonly AttachmentDescriptor[],
  incoming: AttachmentDescriptor,
): readonly AttachmentDescriptor[] {
  const key = attachmentKey(incoming);
  const index = attachments.findIndex((item) => attachmentKey(item) === key);
  if (index === -1) {
    return [...attachments, incoming];
  }
  return attachments.map((item, itemIndex) => (itemIndex === index ? incoming : item));
}

export function removeAttachment(
  attachments: readonly AttachmentDescriptor[],
  id: string,
): readonly AttachmentDescriptor[] {
  return attachments.filter((item) => item.id !== id);
}

export function moveAttachment(
  attachments: readonly AttachmentDescriptor[],
  id: string,
  direction: "earlier" | "later",
): readonly AttachmentDescriptor[] {
  const index = attachments.findIndex((item) => item.id === id);
  if (index === -1) {
    return attachments;
  }
  const swapWith = direction === "earlier" ? index - 1 : index + 1;
  if (swapWith < 0 || swapWith >= attachments.length) {
    return attachments;
  }
  const next = [...attachments];
  const current = next[index];
  const neighbour = next[swapWith];
  if (current === undefined || neighbour === undefined) {
    return attachments;
  }
  next[index] = neighbour;
  next[swapWith] = current;
  return next;
}

export function describeAttachmentStatus(status: AttachmentStatus): string {
  switch (status) {
    case "ready":
      return "ready";
    case "unavailable":
      return "unavailable";
    case "stale":
      return "stale";
    case "changed":
      return "changed";
    case "oversized":
      return "oversized";
    case "unsupported":
      return "unsupported";
    case "inaccessible":
      return "inaccessible";
    case "partial":
      return "partially resolved";
    default: {
      const exhaustive: never = status;
      return exhaustive;
    }
  }
}

/** One chrome row naming attachments without their bodies. */
export function describeAttachments(attachments: readonly AttachmentDescriptor[]): string {
  if (attachments.length === 0) {
    return "";
  }
  const names = attachments.map((item) => {
    const status =
      item.status === "ready"
        ? item.identity
        : `${item.identity} (${describeAttachmentStatus(item.status)})`;
    return item.secret ? `${status} credential` : status;
  });
  return `Attached: ${names.join(" · ")}`;
}

export function describeBlockingReason(attachments: readonly AttachmentDescriptor[]): string {
  const blocking = blockingAttachments(attachments);
  if (blocking.length === 0) {
    return "an attachment is not ready";
  }
  const first = blocking[0];
  if (first === undefined) {
    return "an attachment is not ready";
  }
  return `${first.identity} is ${describeAttachmentStatus(first.status)}`;
}
