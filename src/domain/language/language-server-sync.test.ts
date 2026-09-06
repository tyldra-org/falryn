import { describe, expect, test } from "bun:test";
import {
  applyContentChanges,
  mergeWorkspaceFolders,
  parseRegisterCapabilityParams,
  validateChangeDocumentRequest,
  validateOpenDocumentRequest,
  validateWorkspaceFoldersChange,
} from "./language-server-sync.ts";

describe("language-server document sync contracts", () => {
  test("validates open and change requests", () => {
    expect(
      validateOpenDocumentRequest({
        uri: "file:///tmp/a.ts",
        languageId: "typescript",
        text: "const x = 1;\n",
      }),
    ).toBeNull();
    expect(
      validateOpenDocumentRequest({
        uri: "not-a-uri",
        languageId: "typescript",
        text: "x",
      }),
    ).toBe("invalid-uri");
    expect(
      validateChangeDocumentRequest({
        uri: "file:///tmp/a.ts",
        version: 2,
        contentChanges: [{ kind: "full", text: " cons\n" }],
      }),
    ).toBeNull();
    expect(
      validateChangeDocumentRequest({
        uri: "file:///tmp/a.ts",
        version: 0,
        contentChanges: [{ kind: "full", text: "x" }],
      }),
    ).toBe("invalid-version");
  });

  test("applies full and incremental content changes", () => {
    expect(applyContentChanges("hello\nworld", [{ kind: "full", text: "bye" }])).toEqual({
      ok: true,
      value: "bye",
    });
    expect(
      applyContentChanges("hello\nworld", [
        {
          kind: "incremental",
          text: "Hi",
          range: {
            start: { line: 0, character: 0 },
            end: { line: 0, character: 5 },
          },
        },
      ]),
    ).toEqual({ ok: true, value: "Hi\nworld" });
  });

  test("merges workspace folders and parses capability registration", () => {
    expect(
      validateWorkspaceFoldersChange({
        added: [{ uri: "file:///tmp/b", name: "b" }],
        removed: [],
      }),
    ).toBeNull();
    expect(
      mergeWorkspaceFolders([{ uri: "file:///tmp/a", name: "a" }], {
        added: [{ uri: "file:///tmp/b", name: "b" }],
        removed: [{ uri: "file:///tmp/a", name: "a" }],
      }),
    ).toEqual({
      ok: true,
      value: [{ uri: "file:///tmp/b", name: "b" }],
    });
    expect(
      parseRegisterCapabilityParams({
        registrations: [{ id: "1", method: "textDocument/diagnostic", registerOptions: null }],
      }),
    ).toEqual({
      ok: true,
      value: [{ id: "1", method: "textDocument/diagnostic", registerOptions: null }],
    });
  });
});
