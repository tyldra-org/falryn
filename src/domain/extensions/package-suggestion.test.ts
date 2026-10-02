import { expect, test } from "bun:test";
import { ingestCuratedCatalog } from "./curated-catalog.ts";
import { catalogBytes, curatedDocument, curatedEntry } from "./curated-catalog-fixtures.ts";
import {
  executableName,
  PACKAGE_SUGGESTION_LIMITS,
  packageSuggestionId,
  packageSuggestionPreferencesSchema,
  relevanceMatch,
  scanPackageHints,
} from "./package-suggestion.ts";

const bytes = (text: string) => new TextEncoder().encode(text);
const hint = (value: Record<string, unknown>) => `falryn-package-hint/1 ${JSON.stringify(value)}`;
const valid = { sourceId: "market", listingId: "tools/lint", packageId: "tools-lint" };

test("a whole marker line decodes; surrounding output and quoted copies stay inert text", () => {
  const scan = scanPackageHints(
    bytes(
      [
        "error: lint config missing",
        hint({ ...valid, packageVersion: "1.2.0" }),
        `  ${hint(valid)}`,
        `echo "${hint(valid).replaceAll('"', '\\"')}"`,
        `note ${hint(valid)}`,
        "done",
      ].join("\r\n"),
    ),
  );
  expect(scan).toEqual({
    hints: [{ ...valid, packageVersion: "1.2.0" }],
    diagnostics: [],
    omitted: 0,
  });
});

test("malformed, oversized and unknown-codec markers are refused without keeping their text", () => {
  const scan = scanPackageHints(
    bytes(
      [
        "falryn-package-hint/1 {not json",
        hint({ ...valid, url: "https://evil.example.test/install.sh" }),
        hint({ ...valid, command: "curl | sh" }),
        hint({ ...valid, sourceId: "../market" }),
        `falryn-package-hint/1 ${JSON.stringify({ ...valid, packageId: "x".repeat(5_000) })}`,
        hint({ ...valid }).replace("/1 ", "/2 "),
        "falryn-package-hint/1",
      ].join("\n"),
    ),
  );
  expect(scan.hints).toEqual([]);
  expect(scan.diagnostics).toEqual([
    "marker-malformed",
    "marker-malformed",
    "marker-malformed",
    "marker-malformed",
    "marker-oversized",
    "marker-codec-unknown",
    "marker-codec-unknown",
  ]);
  expect(JSON.stringify(scan)).not.toContain("evil.example.test");
});

test("invalid UTF-8 in a marker line is malformed rather than decoded loosely", () => {
  const prefix = bytes("falryn-package-hint/1 ");
  const line = new Uint8Array([...prefix, 0xff, 0xfe]);
  expect(scanPackageHints(line).diagnostics).toEqual(["marker-malformed"]);
});

test("duplicate markers collapse and a stream keeps at most the per-stream limit", () => {
  const lines = [hint(valid), hint(valid)];
  for (let index = 0; index < PACKAGE_SUGGESTION_LIMITS.hintsPerStream + 2; index += 1)
    lines.push(hint({ ...valid, packageId: `tools-lint-${index}` }));
  const scan = scanPackageHints(bytes(lines.join("\n")));
  expect(scan.hints).toHaveLength(PACKAGE_SUGGESTION_LIMITS.hintsPerStream);
  expect(scan.hints[0]).toEqual({ ...valid, packageVersion: null });
  expect(scan.omitted).toBe(3);
});

test("relevance compares executable names and capability kinds exactly and files through the glob codec", () => {
  const declaration = {
    executables: ["eslint"],
    files: ["*.lint.json", "config/**/*.yml"],
    capabilities: ["lsp" as const],
  };
  expect(relevanceMatch(declaration, { kind: "executable", name: "eslint" })).toBe("eslint");
  expect(relevanceMatch(declaration, { kind: "executable", name: "eslint.js" })).toBeNull();
  expect(relevanceMatch(declaration, { kind: "capability", capability: "lsp" })).toBe("lsp");
  expect(relevanceMatch(declaration, { kind: "capability", capability: "dap" })).toBeNull();
  expect(relevanceMatch(declaration, { kind: "file", path: "pkg/app.lint.json" })).toBe(
    "*.lint.json",
  );
  expect(relevanceMatch(declaration, { kind: "file", path: "config/a/b.yml" })).toBe(
    "config/**/*.yml",
  );
  expect(relevanceMatch(declaration, { kind: "file", path: "other/b.yml" })).toBeNull();
  expect(executableName("/usr/local/bin/eslint")).toBe("eslint");
  expect(executableName("/bin/")).toBeNull();
});

test("catalog relevance is optional, normalized and validated per entry", () => {
  const plain = ingestCuratedCatalog(catalogBytes(curatedDocument([curatedEntry("tools/plain")])));
  if (plain.kind !== "ingested") throw new Error("expected ingestion");
  expect("relevance" in (plain.catalog.entries[0] ?? {})).toBe(false);

  const declared = ingestCuratedCatalog(
    catalogBytes(
      curatedDocument([
        {
          ...curatedEntry("tools/lint"),
          relevance: {
            executables: ["eslint", "eslint"],
            files: ["*.ts", "*.js"],
            capabilities: ["process", "lsp", "lsp"],
          },
        },
        { ...curatedEntry("tools/bad"), relevance: { executables: ["../sh"] } },
        { ...curatedEntry("tools/empty"), relevance: {} },
        { ...curatedEntry("tools/regex"), relevance: { files: ["src/[a-"] } },
        { ...curatedEntry("tools/kind"), relevance: { capabilities: ["shell-script"] } },
      ]),
    ),
  );
  if (declared.kind !== "ingested") throw new Error("expected ingestion");
  expect(declared.catalog.entries.map((entry) => entry.listingId)).toEqual(["tools/lint"]);
  expect(declared.catalog.entries[0]?.relevance).toEqual({
    executables: ["eslint"],
    files: ["*.js", "*.ts"],
    capabilities: ["lsp", "process"],
  });
  expect(declared.rejected).toEqual(["tools/bad", "tools/empty", "tools/kind", "tools/regex"]);
});

test("preferences refuse duplicates, and a suggestion's identity ignores the version", () => {
  expect(
    packageSuggestionPreferencesSchema.safeParse({ sources: ["a", "a"], dismissed: [] }).success,
  ).toBe(false);
  expect(
    packageSuggestionPreferencesSchema.safeParse({
      dismissed: [
        { sourceId: "a", packageId: "p" },
        { sourceId: "a", packageId: "p" },
      ],
    }).success,
  ).toBe(false);
  expect(packageSuggestionPreferencesSchema.parse({})).toEqual({ sources: [], dismissed: [] });
  expect(packageSuggestionId("a", "p")).toBe(packageSuggestionId("a", "p"));
  expect(packageSuggestionId("a", "p")).not.toBe(packageSuggestionId("b", "p"));
});
