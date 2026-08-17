import { describe, expect, test } from "bun:test";
import {
  codeActionToPatchPlan,
  fileUriToWorkspaceRelativePath,
  parseCodeActionResult,
  parseWorkspaceEdit,
  validateFormatRequest,
  validateRenameRequest,
  workspaceEditToPatchPlan,
} from "./language-server-edits.ts";
import type { LanguageServerOpenDocument } from "./language-server-sync.ts";

describe("language-server edit contracts", () => {
  test("validates format and rename requests", () => {
    expect(validateFormatRequest({ uri: "file:///tmp/a.ts" })).toBeNull();
    expect(validateFormatRequest({ uri: "relative" })).toBe("invalid-uri");
    expect(
      validateRenameRequest({
        uri: "file:///tmp/a.ts",
        position: { line: 0, character: 1 },
        newName: "y",
      }),
    ).toBeNull();
    expect(
      validateRenameRequest({
        uri: "file:///tmp/a.ts",
        position: { line: 0, character: 1 },
        newName: "",
      }),
    ).toBe("invalid-rename");
  });

  test("parses workspace edits and rejects resource operations", () => {
    expect(
      parseWorkspaceEdit({
        changes: {
          "file:///tmp/demo/a.ts": [
            {
              range: { start: { line: 0, character: 6 }, end: { line: 0, character: 7 } },
              newText: "y",
            },
          ],
        },
      }),
    ).toMatchObject({
      ok: true,
      value: {
        documentEdits: [
          {
            textDocument: { uri: "file:///tmp/demo/a.ts", version: null },
          },
        ],
      },
    });

    expect(
      parseWorkspaceEdit({
        documentChanges: [{ kind: "create", uri: "file:///tmp/demo/b.ts" }],
      }),
    ).toEqual({ ok: false, error: "unsupported-resource-operation" });
  });

  test("converts workspace edits into patch plans with stale rejection", () => {
    const open = new Map<string, LanguageServerOpenDocument>([
      [
        "file:///tmp/demo/a.ts",
        {
          uri: "file:///tmp/demo/a.ts",
          languageId: "typescript",
          version: 2,
          text: "const x = 1;\n",
        },
      ],
    ]);
    const folders = ["file:///tmp/demo"];

    expect(fileUriToWorkspaceRelativePath("file:///tmp/demo/a.ts", folders)).toEqual({
      ok: true,
      value: "a.ts",
    });

    const converted = workspaceEditToPatchPlan(
      {
        documentEdits: [
          {
            textDocument: { uri: "file:///tmp/demo/a.ts", version: 2 },
            edits: [
              {
                range: { start: { line: 0, character: 6 }, end: { line: 0, character: 7 } },
                newText: "y",
              },
            ],
          },
        ],
      },
      open,
      folders,
    );
    expect(converted.ok).toBe(true);
    if (!converted.ok) {
      return;
    }
    expect(converted.value.plan.targets).toHaveLength(1);
    expect(converted.value.plan.targets[0]?.path).toBe("a.ts");
    expect(converted.value.plan.targets[0]?.hunks[0]?.newLines).toEqual(["const y = 1;"]);

    expect(
      workspaceEditToPatchPlan(
        {
          documentEdits: [
            {
              textDocument: { uri: "file:///tmp/demo/a.ts", version: 1 },
              edits: [],
            },
          ],
        },
        open,
        folders,
      ),
    ).toEqual({ ok: false, error: "stale-document" });
  });

  test("defers code-action commands without executing them", () => {
    const parsed = parseCodeActionResult([
      {
        title: "Organize imports",
        kind: "source.organizeImports",
        edit: {
          changes: {
            "file:///tmp/demo/a.ts": [],
          },
        },
        command: { title: "organize", command: "editor.action.organizeImports" },
      },
    ]);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok || parsed.value.kind !== "actions") {
      return;
    }
    const open = new Map<string, LanguageServerOpenDocument>([
      [
        "file:///tmp/demo/a.ts",
        {
          uri: "file:///tmp/demo/a.ts",
          languageId: "typescript",
          version: 1,
          text: "import 'x';\n",
        },
      ],
    ]);
    const action = parsed.value.actions[0];
    if (action === undefined) {
      return;
    }
    const patch = codeActionToPatchPlan(action, open, ["file:///tmp/demo"]);
    expect(patch.ok).toBe(true);
    if (!patch.ok) {
      return;
    }
    expect(patch.value.deferredCommands).toEqual([
      { title: "organize", command: "editor.action.organizeImports" },
    ]);
  });
});
