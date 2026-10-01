import { expect, test } from "bun:test";
import { createRequire } from "node:module";

type File = { readonly filename: string; readonly additions: number; readonly deletions: number };
type Target = { readonly owner: string; readonly repo: string; readonly issue_number: number };
type Labels = {
  readonly SIZE_LABELS: readonly string[];
  readonly VOUCH_LABELS: readonly string[];
  readonly sizeLabel: (files: readonly File[]) => {
    readonly label: string;
    readonly changed: number;
  };
  readonly vouchLabel: (status: string) => string;
  readonly setExclusiveLabel: (
    github: unknown,
    target: Target,
    family: readonly string[],
    next: string,
  ) => Promise<void>;
};

const require = createRequire(import.meta.url);
const labels = require("../../.github/scripts/pr-labels.cjs") as Labels;

const file = (filename: string, additions: number): File => ({ filename, additions, deletions: 0 });

test("size counts changed non-test lines, and test lines only when nothing else changed", () => {
  expect(labels.sizeLabel([file("src/a.ts", 49), file("src/a.test.ts", 900)]).label).toBe(
    "size: XS",
  );
  expect(labels.sizeLabel([file("src/a.test.ts", 300)])).toMatchObject({
    label: "size: M",
    changed: 300,
  });
  for (const [lines, label] of [
    [50, "size: S"],
    [199, "size: S"],
    [500, "size: L"],
    [999, "size: L"],
    [1000, "size: XL"],
  ] as const)
    expect(labels.sizeLabel([file("src/a.ts", lines)]).label).toBe(label);
  expect(labels.sizeLabel([file("tests/fixture.json", 60), file("docs/a.md", 0)]).label).toBe(
    "size: S",
  );
});

test("vouch status maps to exactly one managed label", () => {
  expect(labels.vouchLabel("denounced")).toBe("vouch: blocked");
  for (const status of ["bot", "collaborator", "vouched"])
    expect(labels.vouchLabel(status)).toBe("vouch: trusted");
  for (const status of ["unknown", "", "error"])
    expect(labels.vouchLabel(status)).toBe("vouch: unvouched");
  expect(labels.VOUCH_LABELS).toContain(labels.vouchLabel("denounced"));
});

test("setting a label removes the rest of its family, keeps other labels, and tolerates a race", async () => {
  const writes: string[] = [];
  const current = ["size: XL", "size: S", "area: cli"];
  const github = {
    rest: {
      issues: {
        listLabelsOnIssue: async () => ({ data: current.map((name) => ({ name })) }),
        removeLabel: async ({ name }: { name: string }) => {
          writes.push(`remove ${name}`);
          if (name === "size: S") throw Object.assign(new Error("gone"), { status: 404 });
        },
        addLabels: async ({ labels: added }: { labels: string[] }) => {
          writes.push(`add ${added.join(",")}`);
        },
      },
    },
  };
  const target = { owner: "o", repo: "r", issue_number: 7 };
  await labels.setExclusiveLabel(github, target, labels.SIZE_LABELS, "size: M");
  expect(writes).toEqual(["remove size: XL", "remove size: S", "add size: M"]);

  writes.length = 0;
  current.splice(0, current.length, "size: M");
  await labels.setExclusiveLabel(github, target, labels.SIZE_LABELS, "size: M");
  expect(writes).toEqual([]);

  const failing = {
    rest: {
      issues: {
        ...github.rest.issues,
        listLabelsOnIssue: async () => ({ data: [{ name: "size: XL" }] }),
        removeLabel: async () => {
          throw Object.assign(new Error("denied"), { status: 403 });
        },
      },
    },
  };
  await expect(
    labels.setExclusiveLabel(failing, target, labels.SIZE_LABELS, "size: M"),
  ).rejects.toThrow("denied");
});
