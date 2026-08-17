import { describe, expect, test } from "bun:test";
import {
  ok,
  type StructuralParserPort,
  type WorkspaceIndexBuildSource,
  type WorkspaceIndexGeneration,
  type WorkspaceIndexRecord,
  type WorkspaceIndexWritePort,
} from "../domain/index.ts";
import { createWorkspaceIndexBuilder } from "./workspace-index-build.ts";

function memoryWritePort(): WorkspaceIndexWritePort & {
  readonly generations: WorkspaceIndexGeneration[];
} {
  const generations: WorkspaceIndexGeneration[] = [];
  return {
    generations,
    async rebuild(generation, signal) {
      if (signal?.aborted === true) {
        return { ok: false, error: { code: "cancelled" } };
      }
      generations.push(generation);
      return ok(generation);
    },
  };
}

describe("createWorkspaceIndexBuilder structural qualification", () => {
  test("invokes structural parser only when regex finds no symbols", async () => {
    const calls: string[] = [];
    const parser: StructuralParserPort = {
      async parseSymbols(source) {
        calls.push(source.logical);
        const symbols: WorkspaceIndexRecord[] = [
          {
            logical: source.logical,
            kind: "symbol",
            name: "parsed",
            text: "parsed",
            startLine: 1,
            endLine: 1,
            revision: source.revision,
          },
        ];
        return ok(symbols);
      },
    };
    const store = memoryWritePort();
    const builder = createWorkspaceIndexBuilder({ index: store, structuralParser: parser });

    const withRegexSymbols: WorkspaceIndexBuildSource = {
      logical: "src/known.ts",
      revision: "r1",
      text: `${"export function known() {}\n"}${"// pad\n".repeat(20)}`,
    };
    const withoutRegexSymbols: WorkspaceIndexBuildSource = {
      logical: "src/obscure.ts",
      revision: "r2",
      text: `${"x = 1\ny = 2\n"}${"# pad\n".repeat(30)}`,
    };

    const rebuilt = await builder.rebuildFromSources([withRegexSymbols, withoutRegexSymbols]);
    expect(rebuilt.ok).toBe(true);
    if (!rebuilt.ok) {
      return;
    }
    expect(calls).toEqual(["src/obscure.ts"]);
    expect(rebuilt.value.structuralParsingUsed).toBe(1);
    expect(rebuilt.value.structuralParsingSkipped).toBe(1);
  });
});
