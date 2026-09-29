import { expect, test } from "bun:test";
import type { ComposerSnapshot } from "../composer/index.ts";
import type { ComposerSuggestionSource, SuggestionRow } from "../composer/suggestions.ts";
import { mount } from "../runtime/harness.tsx";
import { ShellApp } from "./shell-app.tsx";
import { known, type ShellModel, unavailable } from "./view-model.ts";

const model: Omit<ShellModel, "overlay" | "commands" | "transcript" | "composer" | "activity"> = {
  header: {
    workspace: known("workspace"),
    branch: unavailable("none"),
    session: known("alice"),
    model: unavailable("none"),
  },
  status: { status: "informational", message: "Ready", hints: [] },
  help: [],
};
const theme = {
  variant: "dark",
  colorLevel: "truecolor",
  symbols: "unicode",
  reducedMotion: true,
  generation: 1,
} as const;

function row(name: string, extra: Partial<SuggestionRow> = {}): SuggestionRow {
  return {
    id: name,
    label: `$${name}`,
    kind: "package",
    detail: `package · ${name} 1.0.0`,
    exact: false,
    unavailable: null,
    pick: {
      trigger: "$",
      kind: "package",
      identity: `package:${name}@1`,
      label: `$${name}`,
      source: `${name} 1.0.0`,
      generation: "g1",
    },
    ...extra,
  };
}

const CATALOG = [
  row("gmail"),
  row("github", { unavailable: { reason: "not trusted", repair: "/extensions github" } }),
  row("outlook"),
];

async function shellWith(queries: string[] = []) {
  const submitted: ComposerSnapshot[] = [];
  const source: ComposerSuggestionSource = {
    trigger: "$",
    async query(query) {
      queries.push(query);
      const rows = CATALOG.filter((item) => item.label.slice(1).startsWith(query)).map((item) => ({
        ...item,
        exact: item.label === `$${query}`,
      }));
      return { rows, total: rows.length, notice: null };
    },
  };
  const shell = await mount(
    <ShellApp
      theme={theme}
      model={model}
      onExit={() => {}}
      submission={{
        submit(snapshot) {
          submitted.push(snapshot);
          return { kind: "accepted", snapshot };
        },
        mentionSources: [source],
      }}
    />,
    { shape: { columns: 120, rows: 30 } },
  );
  await shell.frame();
  await shell.press("\t");
  await shell.press("\t");
  return { shell, submitted };
}

test("typing $ lists capabilities, Tab picks one, and the submission carries the token", async () => {
  const { shell, submitted } = await shellWith();
  using _ = shell;
  await shell.type("find the invoice using $g");
  const listed = await shell.frame("$github");
  expect(listed).toContain("› $gmail");
  expect(listed).toContain("unavailable: not trusted");
  await shell.press("\t");
  expect(await shell.frame("find the invoice using $gmail")).not.toContain("$github");
  await shell.type("and reply");
  await shell.press("\r");
  await shell.frame();
  expect(
    submitted.map((item) => [item.text.trim(), item.tokens.map((token) => token.label)]),
  ).toEqual([["find the invoice using $gmail and reply", ["$gmail"]]]);
});

test("a narrow terminal shows five rows without the source column, and no colour still marks the selection", async () => {
  const many = Array.from({ length: 9 }, (_, index) => row(`pkg${index}`));
  const source: ComposerSuggestionSource = {
    trigger: "$",
    query: async () => ({ rows: many, total: many.length, notice: null }),
  };
  const shell = await mount(
    <ShellApp
      theme={{ ...theme, colorLevel: "none" }}
      model={model}
      onExit={() => {}}
      submission={{
        submit: (snapshot) => ({ kind: "accepted", snapshot }),
        mentionSources: [source],
      }}
    />,
    { shape: { columns: 40, rows: 30 } },
  );
  using _ = shell;
  await shell.frame();
  await shell.press("\t");
  await shell.press("\t");
  await shell.type("$");
  const frame = await shell.frame("› $pkg0");
  expect(frame).toContain("$pkg4");
  expect(frame).not.toContain("$pkg5");
  expect(frame).not.toContain("package · pkg1");
  expect(frame).toContain("1 of 9");
});

test("Backspace after a token removes it whole, and typing an exact label and a space converts it", async () => {
  const { shell, submitted } = await shellWith();
  using _ = shell;
  await shell.type("$gmail");
  await shell.frame("› $gmail");
  // One keystroke at a time, as a terminal delivers typing; a chunk is a paste.
  await shell.type(" ");
  await shell.type("x");
  await shell.frame("$gmail x");
  await shell.press("\u007f");
  await shell.press("\u007f");
  await shell.press("\u007f");
  const after = await shell.frame();
  expect(after).not.toContain("$gmail");
  await shell.type("$outlook");
  await shell.frame("› $outlook");
  await shell.type(" ");
  await shell.type("please");
  await shell.frame("$outlook please");
  await shell.press("\r");
  await shell.frame();
  expect(submitted[0]?.tokens.map((token) => [token.label, token.start])).toEqual([
    ["$outlook", 0],
  ]);
});

test("a recalled prompt brings its tokens back", async () => {
  const { shell, submitted } = await shellWith();
  using _ = shell;
  await shell.type("$gm");
  await shell.frame("› $gmail");
  await shell.press("\t");
  await shell.frame("$gmail");
  await shell.press("\r");
  await shell.frame();
  await shell.press("\u001b[A");
  await shell.frame("$gmail");
  await shell.press("\r");
  await shell.frame();
  expect(submitted.map((item) => item.tokens.map((token) => token.label))).toEqual([
    ["$gmail"],
    ["$gmail"],
  ]);
});

test("Escape closes the list and keeps the draft; Return picks while it is open", async () => {
  const { shell, submitted } = await shellWith();
  using _ = shell;
  await shell.type("$ou");
  expect(await shell.frame("$outlook")).toContain("› $outlook");
  await shell.press("\u001b");
  const closed = await shell.frame();
  expect(closed).not.toContain("› $outlook");
  await shell.type("t");
  await shell.press("\t");
  expect(await shell.frame("› $outlook")).toContain("› $outlook");
  await shell.press("\r");
  await shell.frame();
  expect(submitted).toEqual([]);
  await shell.press("\r");
  await shell.frame();
  expect(submitted[0]?.tokens.map((token) => token.label)).toEqual(["$outlook"]);
});

test("an unavailable row is refused with its reason", async () => {
  const { shell } = await shellWith();
  using _ = shell;
  await shell.type("$git");
  await shell.frame("$github");
  await shell.press("\t");
  expect(await shell.frame("not trusted (/extensions github)")).toContain("$git");
});

test("shell-like text never queries a source", async () => {
  const queries: string[] = [];
  const { shell } = await shellWith(queries);
  using _ = shell;
  await shell.type("echo $HOME costs US$5 and a$b");
  await shell.frame();
  await new Promise((resolve) => setTimeout(resolve, 120));
  expect(queries).toEqual([]);
});
