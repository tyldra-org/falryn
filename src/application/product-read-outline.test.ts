/** Index-informed Product Read outline projections. */

import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";

import {
  artifactId,
  buildIndexGeneration,
  CONTENT_DIGEST_ALGORITHM,
  contentDigest,
  localPath,
  type WorkspaceFileRead,
} from "../domain/index.ts";
import { projectIndexedRead } from "./product-read-outline.ts";

function readFor(source: string, logical = "src/large.ts"): WorkspaceFileRead {
  const bytes = new TextEncoder().encode(source);
  const digest = contentDigest.from(
    `${CONTENT_DIGEST_ALGORITHM}:${createHash("sha256").update(bytes).digest("hex")}`,
  );
  return {
    bound: {
      root: localPath("/work/project"),
      requested: logical,
      resolved: localPath(`/work/project/${logical}`),
      logical,
    },
    kind: "file",
    byteLength: bytes.byteLength,
    requestedTarget: logical,
    resolvedTarget: `/work/project/${logical}`,
    sourceIdentity: `file:${logical}`,
    revision: "revision-1",
    digest,
    completeness: "partial",
    fidelity: "exact",
    encoding: "utf-8",
    newline: "lf",
    range: null,
    actualRange: null,
    inlineByteLength: 16,
    lines: [{ number: 1, text: "export const first = 1;" }],
    truncated: true,
    continuation: null,
    expansion: {
      kind: "artifact",
      artifactId: artifactId.from("artifact-large"),
      digest,
      byteLength: bytes.byteLength,
      mediaType: "text/plain",
    },
    diagnostics: [],
  };
}

function generationFor(read: WorkspaceFileRead, source: string) {
  const built = buildIndexGeneration(
    {
      sources: [{ logical: read.bound.logical, revision: String(read.digest), text: source }],
    },
    "generation-7",
  );
  if (!built.ok) {
    throw new Error(built.error.code);
  }
  return built.value.generation;
}

describe("projectIndexedRead", () => {
  test("renders source lines and omissions from digest-bound structural records", () => {
    const source = [
      "export const first = 1;",
      "",
      "const setup = true;",
      "",
      "export function composeTurn() {",
      "  return setup;",
      "}",
      "",
      "export class ProductRead {}",
      "",
      "export const last = true;",
    ].join("\n");
    const read = readFor(source);
    const projected = projectIndexedRead(read, generationFor(read, source), 4_096);

    expect(projected).not.toBeNull();
    expect(projected?.kind).toBe("indexed-outline");
    expect(projected?.text).toContain("src/large.ts [indexed outline");
    expect(projected?.text).toContain("5 | export function composeTurn()");
    expect(projected?.text).toContain("9 | export class ProductRead");
    expect(projected?.text).toContain("lines 6-8 omitted");
    expect(projected?.selectedLines).toContain(5);
    expect(projected?.byteLength).toBeLessThanOrEqual(4_096);
  });

  test("rejects stale records and structure-free files", () => {
    const source = "first line\nsecond line\nthird line\n";
    const read = readFor(source, "notes.txt");
    const current = generationFor(read, source);
    expect(projectIndexedRead(read, current, 4_096)).toBeNull();

    const stale = {
      ...current,
      records: current.records.map((record) => ({ ...record, revision: "stale" })),
    };
    const structuredRead = readFor("export function current() {}\n");
    expect(projectIndexedRead(structuredRead, stale, 4_096)).toBeNull();
  });
});
