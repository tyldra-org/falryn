import { expect, test } from "bun:test";
import { projectResource } from "./resource-projection.ts";

test("UTF-8 BOM and byte ranges preserve exact source rather than normalized text", () => {
  const bytes = new TextEncoder().encode("\ufeffα\r\nβ\n");
  const result = projectResource(bytes, { kind: "exact" }, 1024);
  expect(result).toMatchObject({
    ok: true,
    value: {
      complete: true,
      segments: [{ text: "\ufeffα\r\nβ\n", offset: 0, length: bytes.length }],
    },
  });
  expect(
    projectResource(bytes, { kind: "ranges", ranges: [{ offset: 4, length: 1 }] }, 100),
  ).toMatchObject({ ok: false, error: { code: "invalid-utf8-range" } });
  expect(
    projectResource(bytes, { kind: "ranges", ranges: [{ offset: 100, length: 2 }] }, 100),
  ).toMatchObject({ ok: false, error: { code: "range-out-of-bounds" } });
});

test("head-tail and outlines report selection fidelity, bounded output and omissions", () => {
  const bytes = new TextEncoder().encode("# Title\nbody\nlast\n");
  expect(
    projectResource(bytes, { kind: "head-tail", headBytes: 8, tailBytes: 5 }, 13),
  ).toMatchObject({
    ok: true,
    value: {
      complete: false,
      used: 13,
      omissions: ["selected-ranges"],
      segments: [{ text: "# Title\n" }, { text: "last\n" }],
    },
  });
  expect(projectResource(bytes, { kind: "outline" }, 100)).toMatchObject({
    ok: true,
    value: { fidelity: "structural", complete: false },
  });
  expect(projectResource(bytes, { kind: "exact" }, 3)).toMatchObject({
    ok: true,
    value: { used: 3, omissions: ["output-limit"] },
  });
  expect(projectResource(new Uint8Array([0, 255]), { kind: "exact" }, 5)).toMatchObject({
    ok: false,
    error: { code: "unsupported-media" },
  });
});

test("bounded literal matches distinguish hit-limit omission from exact file coverage", () => {
  const bytes = new TextEncoder().encode("hit\n".repeat(1000));
  expect(projectResource(bytes, { kind: "search", query: "hit", maxHits: 2 }, 100)).toMatchObject({
    ok: true,
    value: { complete: false, used: 8, omissions: ["hit-limit"] },
  });
  expect(
    projectResource(bytes, { kind: "search", query: "absent", maxHits: 2 }, 100),
  ).toMatchObject({ ok: true, value: { complete: false, used: 0, segments: [] } });
});

test("automatic tail boundaries and CR-only lines preserve original byte offsets", () => {
  const bytes = new TextEncoder().encode("α\rβ\rγ");
  expect(projectResource(bytes, { kind: "lines", start: 2, end: 2 }, 100)).toMatchObject({
    ok: true,
    value: { segments: [{ offset: 3, length: 3, text: "β\r" }] },
  });
  expect(
    projectResource(bytes, { kind: "head-tail", headBytes: 2, tailBytes: 1 }, 100),
  ).toMatchObject({
    ok: true,
    value: { segments: [{ offset: 0, length: 2, text: "α" }], omissions: ["utf8-boundary"] },
  });
});
