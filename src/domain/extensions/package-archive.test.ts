import { expect, test } from "bun:test";
import { gzipSync } from "node:zlib";
import { readPackageArchive } from "./package-archive.ts";
import { archiveBytes, packageArchiveEntries, tarBytes } from "./package-archive-fixtures.ts";

const read = (entries: Parameters<typeof archiveBytes>[0], options?: { end?: boolean }) =>
  readPackageArchive(archiveBytes(entries, options));
const paths = (result: ReturnType<typeof readPackageArchive>) =>
  result.ok ? result.value.map((file) => file.path) : result.error;

test("a single top-level directory becomes the package root; a root manifest keeps the root", () => {
  expect(paths(read(packageArchiveEntries()))).toEqual(["plugin.json", "skills/review/SKILL.md"]);
  expect(paths(read(packageArchiveEntries("a", "1.0.0", "")))).toEqual([
    "plugin.json",
    "skills/review/SKILL.md",
  ]);
  const text = read([{ path: "./plugin.json", text: "{}" }]);
  expect(text.ok && new TextDecoder().decode(text.value[0]?.bytes)).toBe("{}");
  // A long path carried by a pax record is honoured.
  const long = `package/${"deep/".repeat(30)}file.md`;
  expect(
    paths(
      read([
        { path: "package/plugin.json", text: "{}" },
        { path: long, text: "x", pax: true },
      ]),
    ),
  ).toContain(long.slice("package/".length));
  expect(
    paths(
      read([
        { path: "a/plugin.json", text: "{}" },
        { path: "b/x", text: "" },
      ]),
    ),
  ).toBe("archive-root-ambiguous");
});

test("links, special files and unsafe paths are refused with their own codes", () => {
  const base = { path: "plugin.json", text: "{}" };
  expect(paths(read([base, { path: "link", type: "2", linkname: "/etc/passwd" }]))).toBe(
    "archive-entry-link",
  );
  expect(paths(read([base, { path: "hard", type: "1", linkname: "plugin.json" }]))).toBe(
    "archive-entry-link",
  );
  expect(paths(read([base, { path: "dev", type: "3" }]))).toBe("archive-entry-special");
  expect(paths(read([base, { path: "fifo", type: "6" }]))).toBe("archive-entry-special");
  for (const path of ["../evil", "/etc/passwd", "a\\b", "a/../b", "a//b", "con.txt", "x:y"])
    expect(paths(read([base, { path, text: "x" }]))).toBe("archive-path-invalid");
  expect(paths(read([base, { path: `${"a/".repeat(40)}f`, text: "x", pax: true }]))).toBe(
    "archive-path-invalid",
  );
  expect(paths(read([base, { path: "plugin.json", text: "{}" }]))).toBe("archive-path-duplicate");
  expect(
    paths(read([base, { path: "Readme.md", text: "" }, { path: "README.md", text: "" }])),
  ).toBe("archive-path-duplicate");
  expect(paths(read([base, { path: "doc", text: "" }, { path: "doc/x", text: "" }]))).toBe(
    "archive-path-duplicate",
  );
});

test("malformed, truncated, oversized and non-gzip input is refused", () => {
  const base = { path: "plugin.json", text: "{}" };
  expect(readPackageArchive(tarBytes([base]))).toEqual({ ok: false, error: "archive-not-gzip" });
  expect(paths(read([base], { end: false }))).toBe("archive-malformed");
  expect(paths(read([{ ...base, badChecksum: true }]))).toBe("archive-malformed");
  const truncated = tarBytes([{ path: "plugin.json", text: "x".repeat(2000) }]).slice(0, 1024);
  expect(readPackageArchive(new Uint8Array(gzipSync(truncated)))).toEqual({
    ok: false,
    error: "archive-malformed",
  });
  // A decompression bomb stops at the expanded ceiling.
  const bomb = new Uint8Array(gzipSync(new Uint8Array(70_000_000)));
  expect(readPackageArchive(bomb)).toEqual({ ok: false, error: "archive-expanded-too-large" });
  const many = Array.from({ length: 4097 }, (_, index) => ({ path: `f${index}`, text: "" }));
  expect(paths(read([base, ...many]))).toBe("archive-too-many-entries");
});
