/**
 * Attachment handles and `@` mention parsing (#278, #620).
 */

import { describe, expect, test } from "bun:test";
import {
  type AttachmentDescriptor,
  alreadyIncludedAttachmentReason,
  describeAttachments,
  findAttachmentByIdentity,
  includeTranscriptAttachment,
  isBlockingAttachment,
  moveAttachment,
  parseMentions,
  removeAttachment,
  transcriptAttachmentIdentity,
  upsertAttachment,
} from "./context-attachment.ts";

function file(
  identity: string,
  status: AttachmentDescriptor["status"] = "ready",
): AttachmentDescriptor {
  return {
    id: `file-${identity}`,
    kind: "file",
    identity,
    status,
    byteLength: 4,
    characters: null,
    lines: null,
    digest: null,
    revision: "1",
    mediaType: "text/plain",
    secret: false,
  };
}

function transcript(
  blockKey: string,
  rangeDigest: string | null = null,
  status: AttachmentDescriptor["status"] = "ready",
): AttachmentDescriptor {
  const identity = transcriptAttachmentIdentity(blockKey, rangeDigest);
  return {
    id: `att-${identity}`,
    kind: "transcript",
    identity,
    status,
    byteLength: 12,
    characters: 12,
    lines: 1,
    digest: "sha256:deadbeef",
    revision: null,
    mediaType: "text/plain",
    secret: false,
  };
}

describe("parseMentions", () => {
  test("finds explicit paths and skips email-shaped tokens", () => {
    const spans = parseMentions("see @src/foo.ts and write user@example.com then @mcp:res");
    expect(spans.map((span) => span.identity)).toEqual(["src/foo.ts", "mcp:res"]);
    expect(spans[0]?.kind).toBe("file");
    expect(spans[1]?.kind).toBe("unsupported");
  });

  test("names a paste handle", () => {
    const spans = parseMentions("include @paste:att-1");
    expect(spans).toEqual([
      {
        start: 8,
        end: 20,
        raw: "@paste:att-1",
        kind: "paste",
        identity: "paste:att-1",
      },
    ]);
  });

  test("names a transcript handle without treating it as a file", () => {
    const spans = parseMentions("see @transcript:blk-1:range-a");
    expect(spans).toEqual([
      {
        start: 4,
        end: 29,
        raw: "@transcript:blk-1:range-a",
        kind: "transcript",
        identity: "transcript:blk-1:range-a",
      },
    ]);
  });
});

describe("transcript attachment identity", () => {
  test("uses block key alone, then appends a range digest", () => {
    expect(transcriptAttachmentIdentity("msg-3")).toBe("transcript:msg-3");
    expect(transcriptAttachmentIdentity("msg-3", null)).toBe("transcript:msg-3");
    expect(transcriptAttachmentIdentity("msg-3", "")).toBe("transcript:msg-3");
    expect(transcriptAttachmentIdentity("msg-3", "abcd")).toBe("transcript:msg-3:abcd");
  });
});

describe("attachment list", () => {
  test("deduplicates by identity and can reorder and remove", () => {
    const first = file("a.ts");
    const second = file("b.ts");
    const replaced = { ...first, status: "changed" as const };
    const list = upsertAttachment(upsertAttachment([first], second), replaced);
    expect(list.map((item) => item.identity)).toEqual(["a.ts", "b.ts"]);
    expect(list[0]?.status).toBe("changed");

    const moved = moveAttachment(list, second.id, "earlier");
    expect(moved.map((item) => item.identity)).toEqual(["b.ts", "a.ts"]);
    expect(removeAttachment(moved, second.id).map((item) => item.identity)).toEqual(["a.ts"]);
  });

  test("describes handles without payloads", () => {
    const listed = describeAttachments([file("src/a.ts"), { ...file("secret.env"), secret: true }]);
    expect(listed).toContain("src/a.ts");
    expect(listed).toContain("credential");
    expect(listed).not.toContain("payload");
    expect(isBlockingAttachment(file("gone.ts", "inaccessible"))).toBe(true);
    expect(isBlockingAttachment(file("ok.ts"))).toBe(false);
  });

  test("includes a transcript handle once and reports already-included on repeat", () => {
    const first = transcript("blk-1");
    const included = includeTranscriptAttachment([], first);
    expect(included.ok).toBe(true);
    if (!included.ok) {
      return;
    }
    expect(included.attachments).toEqual([first]);
    expect(findAttachmentByIdentity(included.attachments, first.identity)).toEqual(first);

    const again = includeTranscriptAttachment(included.attachments, {
      ...first,
      id: "att-other",
      digest: "sha256:other",
    });
    expect(again).toEqual({
      ok: false,
      reason: alreadyIncludedAttachmentReason(first.identity),
      attachments: included.attachments,
    });
  });

  test("treats distinct ranges of the same block as separate identities", () => {
    const whole = transcript("blk-1");
    const range = transcript("blk-1", "range-a");
    const withWhole = includeTranscriptAttachment([], whole);
    expect(withWhole.ok).toBe(true);
    if (!withWhole.ok) {
      return;
    }
    const withBoth = includeTranscriptAttachment(withWhole.attachments, range);
    expect(withBoth.ok).toBe(true);
    if (!withBoth.ok) {
      return;
    }
    expect(withBoth.attachments.map((item) => item.identity)).toEqual([
      "transcript:blk-1",
      "transcript:blk-1:range-a",
    ]);
  });

  test("marks oversized and other blocking statuses as blocking", () => {
    expect(isBlockingAttachment(transcript("blk-1", null, "oversized"))).toBe(true);
    expect(isBlockingAttachment(transcript("blk-1", null, "ready"))).toBe(false);
  });
});
