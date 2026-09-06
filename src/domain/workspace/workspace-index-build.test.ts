import { describe, expect, test } from "bun:test";
import {
  buildIndexGeneration,
  extractIndexRecordsFromText,
  WORKSPACE_INDEX_SCHEMA,
} from "./workspace-index-build.ts";

describe("workspace index build contracts", () => {
  test("extracts symbols, headings, and lexical chunks", () => {
    const records = extractIndexRecordsFromText({
      logical: "src/a.ts",
      revision: "rev-1",
      text: "export function foo() {}\nconst bar = 1;\n",
    });
    expect(records.some((record) => record.kind === "symbol" && record.name === "foo")).toBe(true);
    expect(records.some((record) => record.kind === "symbol" && record.name === "bar")).toBe(true);
    expect(records.some((record) => record.kind === "chunk")).toBe(true);

    const markdown = extractIndexRecordsFromText({
      logical: "README.md",
      revision: "rev-2",
      text: "# Title\n\nbody line\n",
    });
    expect(markdown.some((record) => record.kind === "heading" && record.name === "Title")).toBe(
      true,
    );
  });

  test("builds a ready generation with capacity omissions", () => {
    const built = buildIndexGeneration(
      {
        sources: [
          {
            logical: "a.ts",
            revision: "r1",
            text: "export function alpha() {}\n",
          },
          {
            logical: "b.ts",
            revision: "r2",
            text: "x".repeat(100),
          },
        ],
        limits: { maxFiles: 8, maxFileBytes: 50, maxRecords: 100 },
      },
      "gen-test",
    );
    expect(built.ok).toBe(true);
    if (!built.ok) {
      return;
    }
    expect(built.value.generation.id).toBe("gen-test");
    expect(built.value.generation.schema).toBe(WORKSPACE_INDEX_SCHEMA);
    expect(built.value.generation.lifecycle).toBe("ready");
    expect(built.value.omittedFiles).toBe(1);
    expect(built.value.fileCount).toBe(1);
  });
});
