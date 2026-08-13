import { describe, expect, test } from "bun:test";
import { createInMemoryFileSystem, type LanguageBackendPort, localPath } from "../domain/index.ts";
import { createLanguageReader } from "./language-read.ts";
import { createWorkspaceReader } from "./workspace-read.ts";

const root = localPath("/work/project");
const source = "function greet(name: string) {\n  return name;\n}\n";

function workspaceReader() {
  return createWorkspaceReader(
    createInMemoryFileSystem({
      nodes: {
        "/work/project": { kind: "directory" },
        "/work/project/src": { kind: "directory" },
        "/work/project/src/a.ts": { kind: "file", text: source },
      },
    }),
  );
}

function symbolOutcome(
  path = "src/a.ts",
  range = {
    start: { line: 0, character: 0 },
    end: { line: 2, character: 1 },
  },
): Extract<Awaited<ReturnType<LanguageBackendPort["readSymbol"]>>, { status: "found" }> {
  return {
    status: "found",
    value: {
      document: { path, version: 1, generation: "g1" },
      symbol: {
        name: "greet",
        kind: "function",
        range,
        declarationRange: range,
        selectionRange: {
          start: { line: 0, character: 9 },
          end: { line: 0, character: 14 },
        },
        containerName: null,
      },
      related: [
        {
          kind: "signature",
          label: "greet signature",
          location: { path, range },
        },
      ],
      provenance: {
        backend: "symbol-index",
        generation: "g1",
        confidence: "semantic",
        fallback: false,
      },
      omissions: [],
    },
  };
}

function backendWithSymbol(
  readSymbol: LanguageBackendPort["readSymbol"],
  readChangedRegions: LanguageBackendPort["readChangedRegions"] = async () => ({
    status: "found",
    value: {
      comparison: { kind: "working-tree" },
      regions: [],
      provenance: {
        backend: "syntax",
        generation: "g1",
        confidence: "structural",
        fallback: false,
      },
      omissions: [],
    },
  }),
): LanguageBackendPort {
  return { readSymbol, readChangedRegions };
}

describe("createLanguageReader", () => {
  test("returns exact current source with document and related evidence", async () => {
    const backend = backendWithSymbol(async () => symbolOutcome());
    const reader = createLanguageReader(backend, workspaceReader());

    const result = await reader.readSymbol(root, {
      path: "src/a.ts",
      symbol: "greet",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error("expected a symbol result");
    }
    expect(result.value.source.text).toBe("function greet(name: string) {\n  return name;\n}");
    expect(result.value.source.exact).toBe(true);
    expect(result.value.document.path.logical).toBe("src/a.ts");
    expect(result.value.related[0]?.location.path.logical).toBe("src/a.ts");
    expect(result.value.provenance).toEqual({
      backend: "symbol-index",
      generation: "g1",
      confidence: "semantic",
      fallback: false,
      derived: true,
    });
  });

  test("keeps lexical fallback visible", async () => {
    const backend = backendWithSymbol(async () => ({
      ...symbolOutcome(),
      value: {
        ...symbolOutcome().value,
        provenance: {
          backend: "lexical" as const,
          generation: "g1",
          confidence: "lexical" as const,
          fallback: true,
        },
      },
    }));
    const reader = createLanguageReader(backend, workspaceReader());

    const result = await reader.readSymbol(root, { path: "src/a.ts", symbol: "greet" });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error("expected a lexical result");
    }
    expect(result.value.provenance.confidence).toBe("lexical");
    expect(result.value.provenance.fallback).toBe(true);
  });

  test("rejects backend documents outside the workspace", async () => {
    const backend = backendWithSymbol(async () => symbolOutcome("/etc/passwd"));
    const reader = createLanguageReader(backend, workspaceReader());

    const result = await reader.readSymbol(root, { path: "src/a.ts", symbol: "greet" });

    expect(result).toEqual({
      ok: false,
      error: { code: "absolute-unscoped" },
    });
  });

  test("returns stale when backend generation is stale", async () => {
    const backend = backendWithSymbol(async () => ({
      status: "stale" as const,
      expectedGeneration: "g1",
      actualGeneration: "g2",
    }));
    const reader = createLanguageReader(backend, workspaceReader());

    const result = await reader.readSymbol(root, { path: "src/a.ts", symbol: "greet" });

    expect(result).toEqual({
      ok: false,
      error: { code: "stale", expectedGeneration: "g1", actualGeneration: "g2" },
    });
  });

  test("rejects a symbol range that is stale against current source", async () => {
    const backend = backendWithSymbol(async () =>
      symbolOutcome("src/a.ts", {
        start: { line: 10, character: 0 },
        end: { line: 10, character: 1 },
      }),
    );
    const reader = createLanguageReader(backend, workspaceReader());

    const result = await reader.readSymbol(root, { path: "src/a.ts", symbol: "greet" });

    expect(result).toEqual({
      ok: false,
      error: { code: "stale", expectedGeneration: "g1", actualGeneration: undefined },
    });
  });

  test("reads changed regions, diagnostics, dependencies, and deleted ranges", async () => {
    const backend = backendWithSymbol(
      async () => symbolOutcome(),
      async (request) => ({
        status: "found",
        value: {
          comparison: request.comparison,
          regions: [
            {
              path: "src/a.ts",
              range: {
                start: { line: 1, character: 2 },
                end: { line: 1, character: 14 },
              },
              change: "modified",
              symbol: null,
              diagnostics: [
                {
                  severity: "warning",
                  code: "TS1",
                  message: "example diagnostic",
                  location: {
                    path: "src/a.ts",
                    range: {
                      start: { line: 1, character: 2 },
                      end: { line: 1, character: 14 },
                    },
                  },
                },
              ],
              dependencies: [
                {
                  path: "src/a.ts",
                  range: {
                    start: { line: 0, character: 0 },
                    end: { line: 0, character: 8 },
                  },
                },
              ],
            },
            {
              path: "src/old.ts",
              range: {
                start: { line: 0, character: 0 },
                end: { line: 1, character: 0 },
              },
              change: "deleted",
              symbol: {
                name: "old",
                kind: "function",
                range: {
                  start: { line: 0, character: 0 },
                  end: { line: 1, character: 0 },
                },
              },
              diagnostics: [],
              dependencies: [],
            },
          ],
          provenance: {
            backend: "syntax",
            generation: "g1",
            confidence: "structural",
            fallback: false,
          },
          omissions: [],
        },
      }),
    );
    const reader = createLanguageReader(backend, workspaceReader());

    const result = await reader.readChangedRegions(root, {
      comparison: { kind: "working-tree" },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error("expected changed regions");
    }
    expect(result.value.status).toBe("complete");
    expect(result.value.regions[0]?.source?.text).toBe("return name;");
    expect(result.value.regions[0]?.diagnostics[0]?.location?.path.logical).toBe("src/a.ts");
    expect(result.value.regions[1]?.source).toBeNull();
    expect(result.value.regions[1]?.path.logical).toBe("src/old.ts");
  });

  test("returns a partial result when the region cap is reached", async () => {
    const backend = backendWithSymbol(
      async () => symbolOutcome(),
      async () => ({
        status: "found",
        value: {
          comparison: { kind: "working-tree" },
          regions: [
            {
              path: "src/a.ts",
              range: {
                start: { line: 0, character: 0 },
                end: { line: 0, character: 8 },
              },
              change: "modified",
              symbol: null,
              diagnostics: [],
              dependencies: [],
            },
            {
              path: "src/a.ts",
              range: {
                start: { line: 1, character: 2 },
                end: { line: 1, character: 14 },
              },
              change: "modified",
              symbol: null,
              diagnostics: [],
              dependencies: [],
            },
          ],
          provenance: {
            backend: "syntax",
            generation: "g1",
            confidence: "structural",
            fallback: false,
          },
          omissions: [],
        },
      }),
    );
    const reader = createLanguageReader(backend, workspaceReader());

    const result = await reader.readChangedRegions(root, {
      limits: { maxRegions: 1 },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error("expected partial changed regions");
    }
    expect(result.value.status).toBe("partial");
    expect(result.value.regions).toHaveLength(1);
    expect(result.value.omissions).toContainEqual({ kind: "regions", count: 1 });
  });

  test("rejects an out-of-root path filter before invoking the backend", async () => {
    let called = false;
    const backend = backendWithSymbol(
      async () => {
        called = true;
        return symbolOutcome();
      },
      async () => {
        called = true;
        return {
          status: "found",
          value: {
            comparison: { kind: "working-tree" },
            regions: [],
            provenance: {
              backend: "syntax",
              generation: "g1",
              confidence: "structural",
              fallback: false,
            },
            omissions: [],
          },
        };
      },
    );
    const reader = createLanguageReader(backend, workspaceReader());

    const result = await reader.readChangedRegions(root, { paths: ["../../outside"] });

    expect(result).toEqual({
      ok: false,
      error: { code: "escaped" },
    });
    expect(called).toBe(false);
  });

  test("returns typed unsupported and cancellation outcomes", async () => {
    const unsupported = backendWithSymbol(async () => ({
      status: "unsupported" as const,
      capability: "read_symbol" as const,
    }));
    const reader = createLanguageReader(unsupported, workspaceReader());
    expect(await reader.readSymbol(root, { path: "src/a.ts", symbol: "greet" })).toEqual({
      ok: false,
      error: { code: "unsupported", capability: "read_symbol" },
    });
    expect(
      await reader.readChangedRegions(
        root,
        { comparison: { kind: "working-tree" } },
        AbortSignal.abort(),
      ),
    ).toEqual({
      ok: false,
      error: { code: "cancelled" },
    });
  });
});
