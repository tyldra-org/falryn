import { describe, expect, test } from "bun:test";

import { createInMemoryFileSystem, localPath } from "../domain/index.ts";
import { createCompactDocumentReader } from "./compact-document-read.ts";
import { createWorkspaceReader } from "./workspace-read.ts";

const root = localPath("/work/project");

function reader() {
  const fileSystem = createInMemoryFileSystem({
    nodes: {
      "/work/project": { kind: "directory" },
      "/work/project/README.md": {
        kind: "file",
        text: "# Root\nintro\n## Child\nneedle one\nbody\n### Leaf\nleaf body\ntail\n",
      },
      "/work/project/src/main.ts": {
        kind: "file",
        text: "export class App {\n  function run() {}\n}\n",
      },
      "/work/project/config/settings.toml": {
        kind: "file",
        text: "[server]\nport = 3000\n",
      },
      "/work/project/logs/app.log": {
        kind: "file",
        text: "INFO boot\nERROR needle\nINFO stopped\n",
      },
      "/work/project/empty.md": { kind: "file", text: "" },
      "/work/project/binary.md": { kind: "file", text: "secret\0bytes" },
      "/work/project/huge.md": { kind: "file", text: "0123456789" },
      "/work/project/utf.md": { kind: "file", text: "é" },
      "/work/project/out": { kind: "symlink", target: "/etc/passwd" },
      "/etc/passwd": { kind: "file", text: "outside" },
    },
  });
  return createCompactDocumentReader(createWorkspaceReader(fileSystem));
}

describe("createCompactDocumentReader", () => {
  test("returns a compact outline with exact heading paths and recovery ranges", async () => {
    const result = await reader().read(root, { path: "README.md", mode: "outline" });
    expect(result.ok).toBe(true);
    if (!result.ok || result.value.status === "empty") {
      throw new Error("expected outline");
    }
    expect(result.value.projection).toBe("compact");
    expect(result.value.complete).toBe(false);
    expect(result.value.extraction).toBe("outline");
    expect(result.value.spans.map((span) => span.label)).toEqual(["Root", "Child", "Leaf"]);
    expect(result.value.spans[1]?.sourceRange).toEqual({ start: 3, end: 3 });
    expect(result.value.spans[2]?.headingPath).toEqual(["Root", "Child", "Leaf"]);
    expect(result.value.omissions[0]?.kind).toBe("lines");
    expect(result.value.recoveryRanges.length).toBeGreaterThan(0);
  });

  test("returns only an explicit symbol range without widening it", async () => {
    const result = await reader().read(root, {
      path: "README.md",
      mode: "ranges",
      ranges: [{ start: 3, end: 4, kind: "symbol", label: "Child" }],
    });
    expect(result.ok).toBe(true);
    if (!result.ok || result.value.status === "empty") {
      throw new Error("expected explicit range");
    }
    expect(result.value.spans).toEqual([
      {
        kind: "symbol",
        label: "Child",
        sourceRange: { start: 3, end: 4 },
        text: "## Child\nneedle one",
        headingPath: ["Root", "Child"],
        symbolPath: [],
        truncated: false,
      },
    ]);
    expect(result.value.status).toBe("partial");
  });

  test("keeps head and tail ordered while exposing the omitted middle", async () => {
    const result = await reader().read(root, {
      path: "README.md",
      mode: "head-tail",
      headLines: 2,
      tailLines: 2,
    });
    expect(result.ok).toBe(true);
    if (!result.ok || result.value.status === "empty") {
      throw new Error("expected head-tail projection");
    }
    expect(result.value.spans.map((span) => span.sourceRange)).toEqual([
      { start: 1, end: 2 },
      { start: 7, end: 8 },
    ]);
    expect(result.value.recoveryRanges).toContainEqual({ start: 3, end: 6 });
    expect(result.value.status).toBe("partial");
  });

  test("returns deterministic relevant spans with bounded context", async () => {
    const result = await reader().read(root, {
      path: "README.md",
      mode: "relevant",
      query: "needle",
      limits: { maxContextLines: 1 },
    });
    expect(result.ok).toBe(true);
    if (!result.ok || result.value.status === "empty") {
      throw new Error("expected relevant spans");
    }
    expect(result.value.spans[0]?.sourceRange).toEqual({ start: 3, end: 5 });
    expect(result.value.spans[0]?.text).toBe("## Child\nneedle one\nbody");
    expect(result.value.spans[0]?.label).toBe("needle");
    expect(result.value.extraction).toBe("relevant-spans");
  });

  test("covers source, configuration, and log families without provider adapters", async () => {
    const compact = reader();
    const source = await compact.read(root, { path: "src/main.ts", mode: "outline" });
    const configuration = await compact.read(root, {
      path: "config/settings.toml",
      mode: "outline",
    });
    const log = await compact.read(root, {
      path: "logs/app.log",
      mode: "relevant",
      query: "error",
    });
    expect(source.ok && source.value.status !== "empty" ? source.value.document.family : null).toBe(
      "source",
    );
    expect(
      configuration.ok && configuration.value.status !== "empty"
        ? configuration.value.document.family
        : null,
    ).toBe("configuration");
    expect(log.ok && log.value.status !== "empty" ? log.value.document.family : null).toBe("log");
  });

  test("enforces output budgets without admitting extra bytes", async () => {
    const result = await reader().read(root, {
      path: "README.md",
      mode: "ranges",
      ranges: [{ start: 1, end: 1 }],
      limits: { maxOutputBytes: 4, maxOutputLines: 1 },
    });
    expect(result.ok).toBe(true);
    if (!result.ok || result.value.status === "empty") {
      throw new Error("expected budgeted result");
    }
    expect(Buffer.byteLength(result.value.spans[0]?.text ?? "", "utf8")).toBeLessThanOrEqual(4);
    expect(result.value.spans[0]?.truncated).toBe(true);
    expect(result.value.status).toBe("partial");
  });

  test("types empty, malformed, binary, oversized, missing, symlink, cancellation, and budget outcomes", async () => {
    const compact = reader();
    const empty = await compact.read(root, { path: "empty.md", mode: "outline" });
    expect(empty.ok && empty.value.status === "empty" ? empty.value.emptyReason : null).toBe(
      "empty-source",
    );
    expect(await compact.read(root, { path: "missing.md", mode: "outline" })).toEqual({
      ok: false,
      error: { code: "not-found" },
    });
    expect(await compact.read(root, { path: "out", mode: "outline" })).toEqual({
      ok: false,
      error: { code: "symlink-escape" },
    });
    expect(await compact.read(root, { path: "binary.md", mode: "outline" })).toEqual({
      ok: false,
      error: { code: "binary" },
    });
    expect(
      await compact.read(root, {
        path: "huge.md",
        mode: "outline",
        limits: { maxSourceBytes: 4 },
      }),
    ).toEqual({
      ok: false,
      error: { code: "oversized", byteLength: 10 },
    });
    expect(
      await compact.read(root, { path: "README.md", mode: "outline" }, AbortSignal.abort()),
    ).toEqual({
      ok: false,
      error: { code: "cancelled" },
    });
    expect(
      await compact.read(root, {
        path: "utf.md",
        mode: "head-tail",
        limits: { maxOutputBytes: 1 },
      }),
    ).toEqual({
      ok: false,
      error: { code: "budget-exhausted", budget: "output-bytes" },
    });
    expect(
      await compact.read(root, {
        path: "README.md",
        mode: "outline",
        ranges: [{ start: 1, end: 1 }],
      }),
    ).toEqual({
      ok: false,
      error: { code: "malformed-request", field: "ranges" },
    });
  });
});
