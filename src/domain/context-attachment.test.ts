/**
 * Attachment handles and `@` mention parsing (#278).
 */

import { describe, expect, test } from "bun:test";
import {
  type AttachmentDescriptor,
  describeAttachments,
  isBlockingAttachment,
  moveAttachment,
  parseMentions,
  removeAttachment,
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
});
