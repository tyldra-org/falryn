import { expect, test } from "bun:test";
import {
  type ChangeEvidence,
  classifyChange,
  classifyPaths,
  needsSelection,
  parseSelection,
  SCOPED_MAX_CHANGED_PATHS,
  SCOPED_MAX_TEST_FILES,
} from "./ci-profile.ts";

const few = { selected: 25, total: 743 };
const change = (
  changedPaths: readonly string[] | null,
  selection: ChangeEvidence["selection"] = few,
  event = "pull_request",
) => classifyChange({ event, changedPaths, selection });

test("a few source modules that only a few tests reach are a scoped change", () => {
  const result = change([
    "src/application/extensions/package-notices.ts",
    "src/application/extensions/package-notices.test.ts",
    "src/cli/commands/extension-notices.ts",
    "src/cli/runtime/native-packages.ts",
    "src/tui/composer/composer-model.ts",
    "src/presentation/blocks.ts",
    "src/integrations/process/host-process.ts",
    "src/data/extensions/package-health-repository.ts",
  ]);
  expect(result.profile).toBe("scoped");
  expect(result.reason).toContain("25 of 743");
});

test("documentation alone is its own tier and needs no test count", () => {
  const paths = ["README.md", "CURRENT-STATE.md", "DEVELOPMENT.md", "docs/guide.md"];
  expect(needsSelection("pull_request", paths)).toBe(false);
  expect(change(paths, null)).toMatchObject({ profile: "docs" });
});

test("documentation beside source is scoped, never the documentation tier", () => {
  const paths = ["README.md", "src/application/extensions/package-notices.ts"];
  expect(needsSelection("pull_request", paths)).toBe(true);
  expect(change(paths).profile).toBe("scoped");
});

test("a Markdown file inside the source tree is not documentation", () => {
  expect(change(["src/cli/README.md"], null).profile).toBe("full");
});

test("anything that is not a pull request runs the full matrix", () => {
  for (const event of ["push", "workflow_dispatch", "merge_group", "schedule", "unknown"])
    expect(change(["README.md"], few, event)).toMatchObject({ profile: "full" });
});

test("an unreadable diff, an empty diff and a wide diff run the full matrix", () => {
  expect(change(null).profile).toBe("full");
  expect(change([]).profile).toBe("full");
  const wide = Array.from(
    { length: SCOPED_MAX_CHANGED_PATHS + 1 },
    (_, index) => `src/application/a${index}.ts`,
  );
  expect(change(wide).profile).toBe("full");
  expect(change(wide.slice(0, SCOPED_MAX_CHANGED_PATHS)).profile).toBe("scoped");
});

test("an unmeasured or large reachable test set runs the full matrix", () => {
  const paths = ["src/application/extensions/package-notices.ts"];
  expect(change(paths, null)).toMatchObject({ profile: "full" });
  expect(change(paths, { selected: SCOPED_MAX_TEST_FILES + 1, total: 743 }).profile).toBe("full");
  expect(change(paths, { selected: SCOPED_MAX_TEST_FILES, total: 743 }).profile).toBe("scoped");
  expect(change(paths, { selected: 0, total: 0 }).profile).toBe("scoped");
});

test.each([
  ".github/workflows/ci.yml",
  ".github/test-timings/linux.json",
  "tools/quality/test-shards.ts",
  "package.json",
  "bun.lock",
  "biome.json",
  "tsconfig.json",
  ".gitignore",
  "src/main.ts",
  "src/providers/catalog/builtin/openai.json",
  "src/data/migrations/0001.sql",
  "assets/falryn-mark.png",
  "examples/anything.ts",
  "scripts/release.sh",
  "src/newlayer/thing.py",
  "docs/nested/../../package.json",
  "/etc/passwd",
  "src\\application\\a.ts",
])("%s needs the full matrix even beside scoped changes", (path) => {
  expect(change(["src/application/extensions/package-notices.ts", path]).profile).toBe("full");
});

test("a rename counts both sides, so moving a file out of src is still full", () => {
  // `git diff --no-renames` lists the old path as a deletion and the new path as an addition.
  const result = change(["src/application/a.ts", "tools/quality/a.ts"]);
  expect(result.profile).toBe("full");
  expect(result.reason).toContain("tools/quality/a.ts");
});

test("the four recent failures that only macOS or Windows caught stay covered", () => {
  // Each was found by a test that imports the changed code, so the scoped run selects it on macOS,
  // or by a compiled suite, which the smoke jobs run whole for every pull request.
  for (const path of [
    "src/integrations/process/host-process-capture.ts",
    "src/cli/runtime/product-working-profiles.ts",
    "src/main.compiled.test.ts",
    "src/tui/runtime/shell.compiled.test.ts",
  ])
    expect(classifyPaths("pull_request", [path])).toBeNull();
});

test("the entrypoint, and a hub whose reach is large, still run the full matrix", () => {
  expect(change(["src/main.ts"]).profile).toBe("full");
  const hub = change(["src/domain/foundation/result.ts"], { selected: 625, total: 743 });
  expect(hub.profile).toBe("full");
  expect(hub.reason).toContain("625 of 743");
});

test("vendored skill documentation is documentation, but workflow policy beside it is not", () => {
  expect(change([".agents/skills/falryn-work/references/work.md"], null).profile).toBe("docs");
  expect(change([".github/workflows/README.md"], null).profile).toBe("full");
  expect(change([".github/PULL_REQUEST_TEMPLATE.md"], null).profile).toBe("full");
  expect(change([".agents/skills/falryn-work/scripts/select_next.py"], null).profile).toBe("full");
});

test("only the path part is decided before a count is needed", () => {
  expect(classifyPaths("pull_request", ["src/application/a.ts"])).toBeNull();
  expect(needsSelection("pull_request", ["src/application/a.ts"])).toBe(true);
  expect(needsSelection("pull_request", ["package.json"])).toBe(false);
  expect(needsSelection("push", ["src/application/a.ts"])).toBe(false);
});

test("Bun's selection line is read with and without colour, and its absence is unmeasured", () => {
  expect(parseSelection("--changed: 33 changed files, running 262/743 test files")).toEqual({
    selected: 262,
    total: 743,
  });
  expect(parseSelection("--changed: 2 changed files, but no test files are affected")).toEqual({
    selected: 0,
    total: 0,
  });
  const coloured =
    "\u001b[0m\u001b[2m--changed:\u001b[0m 2 changed files, running 25/743 test files\n";
  expect(parseSelection(coloured)).toEqual({ selected: 25, total: 743 });
  expect(parseSelection("bun test v1.4.1")).toBeNull();
  expect(parseSelection("")).toBeNull();
});
