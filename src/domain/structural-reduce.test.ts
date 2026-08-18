/**
 * Structural lossless reducers for files, diffs, diagnostics, and tools.
 */

import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";

import { CONTENT_DIGEST_ALGORITHM, contentDigest } from "./artifact.ts";
import type { ContentHasherPort } from "./blob.ts";
import {
  DEFAULT_STRUCTURAL_MAX_DIAGNOSTICS,
  DEFAULT_STRUCTURAL_MAX_HUNKS,
  DEFAULT_STRUCTURAL_MAX_ROWS,
  describeStructuralError,
  reduceStructural,
  STRUCTURAL_REDUCER_VERSION,
} from "./structural-reduce.ts";

const encoder = new TextEncoder();

function hasher(): ContentHasherPort {
  return {
    create() {
      const hash = createHash("sha256");
      return {
        update(chunk) {
          hash.update(chunk);
        },
        digest() {
          return contentDigest.from(`${CONTENT_DIGEST_ALGORITHM}:${hash.digest("hex")}`);
        },
      };
    },
  };
}

function digestOf(text: string) {
  return contentDigest.from(
    `${CONTENT_DIGEST_ALGORITHM}:${createHash("sha256").update(encoder.encode(text)).digest("hex")}`,
  );
}

function prettyJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

describe("reduceStructural", () => {
  test("projects JSON keys and never claims exact-source", () => {
    const text = prettyJson({
      keep: "visible",
      drop: "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
      nested: { inner: 1 },
    });
    const result = reduceStructural({ family: "file", text, keys: ["keep"] }, hasher());
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.value.reducerVersion).toBe(STRUCTURAL_REDUCER_VERSION);
    expect(result.value.fidelity).toBe("structural");
    expect(result.value.evidenceFidelity).toBe("deterministic-transform");
    expect(result.value.claimsExact).toBe(false);
    expect(result.value.text).toBe('{"keep":"visible"}');
    expect(result.value.omissions.some((item) => item.kind === "keys")).toBe(true);
    expect(result.value.expansion).toEqual({
      kind: "inline",
      digest: digestOf(text),
      byteLength: encoder.encode(text).byteLength,
    });
  });

  test("passes through compact JSON that is not smaller", () => {
    const text = '{"ok":true}';
    const result = reduceStructural({ family: "file", text }, hasher());
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.value.fidelity).toBe("passthrough");
    expect(result.value.evidenceFidelity).toBe("exact-source");
    expect(result.value.claimsExact).toBe(true);
    expect(result.value.complete).toBe(true);
    expect(result.value.text).toBe(text);
  });

  test("caps CSV rows and strips configuration comments", () => {
    const header = "id,name";
    const rows = Array.from(
      { length: DEFAULT_STRUCTURAL_MAX_ROWS + 4 },
      (_, index) => `${index},row-${index}`,
    );
    const csv = [header, ...rows].join("\n");
    const table = reduceStructural({ family: "file", text: csv }, hasher());
    expect(table.ok).toBe(true);
    if (!table.ok) {
      return;
    }
    expect(table.value.claimsExact).toBe(false);
    expect(table.value.omissions).toEqual([{ kind: "rows", count: 4, path: null }]);
    expect(table.value.text.split("\n")).toHaveLength(DEFAULT_STRUCTURAL_MAX_ROWS + 1);

    const config = "# comment\nname = falryn\n\n// ignore\nenv = test\n";
    const reduced = reduceStructural({ family: "file", text: config }, hasher());
    expect(reduced.ok).toBe(true);
    if (!reduced.ok) {
      return;
    }
    expect(reduced.value.claimsExact).toBe(false);
    expect(reduced.value.text).toBe("name = falryn\nenv = test");
  });

  test("caps unified-diff hunks while preserving file order", () => {
    const hunks = Array.from({ length: DEFAULT_STRUCTURAL_MAX_HUNKS + 2 }, (_, index) => {
      const line = 10 + index;
      return `@@ -${line},1 +${line},1 @@\n-old-${index}\n+new-${index}`;
    });
    const text = `diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n${hunks.join("\n")}\ndiff --git a/src/b.ts b/src/b.ts\n--- a/src/b.ts\n+++ b/src/b.ts\n@@ -1,1 +1,1 @@\n-old-b\n+new-b`;
    const result = reduceStructural({ family: "diff", text }, hasher());
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.value.claimsExact).toBe(false);
    expect(result.value.omissions.some((item) => item.kind === "hunks" && item.count === 2)).toBe(
      true,
    );
    expect(result.value.text.startsWith("diff --git a/src/a.ts")).toBe(true);
    expect(result.value.text).toContain("diff --git a/src/b.ts");
    expect(result.value.text).not.toContain(`old-${DEFAULT_STRUCTURAL_MAX_HUNKS}`);
  });

  test("keeps errors ahead of warnings and never drops all errors", () => {
    const diagnostics = [
      ...Array.from({ length: DEFAULT_STRUCTURAL_MAX_DIAGNOSTICS }, (_, index) => ({
        path: "src/warn.ts",
        severity: "warning",
        message: `warn-${index}`,
        line: index + 1,
      })),
      { path: "src/fail.ts", severity: "error", message: "boom", line: 9, code: "E001" },
    ];
    const original = diagnostics
      .map((item) => `${item.path}:${item.line}: ${item.severity} ${item.message}`)
      .join("\n");
    const result = reduceStructural(
      { family: "diagnostic", text: original, diagnostics },
      hasher(),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.value.claimsExact).toBe(false);
    expect(result.value.text.startsWith("src/fail.ts:9: error E001 boom")).toBe(true);
    expect(result.value.text).not.toContain(`warn-${DEFAULT_STRUCTURAL_MAX_DIAGNOSTICS - 1}`);
    expect(result.value.omissions).toEqual([{ kind: "diagnostics", count: 1, path: null }]);
  });

  test("keeps tool status, effect, error, and artifact ids", () => {
    const text = prettyJson({
      status: "failed",
      effect: "read",
      error: "blocked",
      errorCode: "E_SCOPE",
      ok: false,
      noise: "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
      artifacts: [{ artifactId: "art-1", bytes: "secret-payload" }],
      diagnostics: [{ code: "D1", level: "error", message: "too long to keep" }],
      value: { nested: { deep: { keep: true } } },
    });
    const result = reduceStructural({ family: "tool", text }, hasher());
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.value.claimsExact).toBe(false);
    const parsed = JSON.parse(result.value.text) as {
      status: string;
      effect: string;
      artifacts: Array<{ artifactId: string }>;
      diagnostics: Array<{ code: string; level?: string }>;
    };
    expect(parsed.status).toBe("failed");
    expect(parsed.effect).toBe("read");
    expect(parsed.artifacts).toEqual([{ artifactId: "art-1" }]);
    expect(parsed.diagnostics).toEqual([{ code: "D1", level: "error" }]);
    expect(result.value.text).not.toContain("secret-payload");
    expect(result.value.text).not.toContain("too long to keep");
  });

  test("refuses restricted, empty, NUL, and cancelled input", () => {
    const restricted = reduceStructural(
      { family: "file", text: "{}", sensitivity: "restricted" },
      hasher(),
    );
    expect(restricted.ok).toBe(false);
    if (restricted.ok) {
      return;
    }
    expect(restricted.error).toEqual({ kind: "structural", code: "secret", field: "sensitivity" });

    const empty = reduceStructural({ family: "file", text: "" }, hasher());
    expect(empty.ok).toBe(false);
    if (empty.ok) {
      return;
    }
    expect(empty.error).toEqual({ kind: "structural", code: "empty", field: "text" });

    const binary = reduceStructural({ family: "file", text: "a\0b" }, hasher());
    expect(binary.ok).toBe(false);
    if (binary.ok) {
      return;
    }
    expect(binary.error).toEqual({ kind: "structural", code: "unsupported", field: "text" });

    const cancelled = reduceStructural({ family: "file", text: "{}", cancelled: true }, hasher());
    expect(cancelled.ok).toBe(false);
    if (cancelled.ok) {
      return;
    }
    expect(cancelled.error).toEqual({ kind: "structural", code: "unavailable", field: "signal" });
    expect(
      describeStructuralError({ kind: "structural", code: "secret", field: "sensitivity" }),
    ).toBe("secret sensitivity");
  });
});
