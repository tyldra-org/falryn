import { expect, test } from "bun:test";
import type { PromptExpansion } from "../../application/extensions/native-prompt-owner.ts";
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

function expanded(name: string, text: string): PromptExpansion {
  return {
    kind: "expanded",
    name,
    text,
    fact: {
      version: 1,
      actionId: "plugin:prompt/abc@1",
      packageId: "kit",
      packageDigest: "sha256:" + "1".repeat(64),
      contribution: "sha256:" + "2".repeat(64),
      prompt: "kit:" + name,
      contentDigest: "sha256:" + "3".repeat(64),
      argumentCount: 2,
      substitutions: 2,
      renderedBytes: text.length,
      variables: [],
    },
  };
}

async function shellWith(
  expand: (text: string, entered?: Readonly<Record<string, string>>) => PromptExpansion,
) {
  const submitted: string[] = [];
  const requested: string[] = [];
  const shell = await mount(
    <ShellApp
      theme={theme}
      model={model}
      onExit={() => {}}
      submission={{
        submit(snapshot) {
          submitted.push(snapshot.text);
          return { kind: "accepted", snapshot };
        },
        async expandTemplate(text, _signal, entered) {
          requested.push(text);
          // Settle after a render, as package I/O does, so draft checks see painted state.
          await new Promise((resolve) => setTimeout(resolve, 20));
          return expand(text, entered);
        },
      }}
    />,
    { shape: { columns: 140, rows: 30 } },
  );
  await shell.frame();
  await shell.press("\t");
  await shell.press("\t");
  return { shell, submitted, requested };
}

test("a package prompt template replaces the draft for review and sends nothing", async () => {
  const { shell, submitted, requested } = await shellWith(() =>
    expanded("review", "Review src/a.ts focusing on error paths."),
  );
  using _ = shell;
  await shell.type('/review src/a.ts "error paths"');
  await shell.press("\r");
  const frame = await shell.frame();
  expect(requested).toEqual(['/review src/a.ts "error paths"']);
  expect(submitted).toEqual([]);
  expect(frame).toContain("Review src/a.ts focusing on error paths.");
  expect(frame).toContain("Expanded /review from kit:review (sha256:3333");
  await shell.press("\r");
  await shell.frame();
  // The harness textarea echoes Enter as a newline, as for any submitted draft.
  expect(submitted.map((text) => text.trim())).toEqual([
    "Review src/a.ts focusing on error paths.",
  ]);
});

test("a failed expansion leaves the draft unchanged and sends nothing", async () => {
  const { shell, submitted } = await shellWith(() => ({
    kind: "failed",
    name: "review",
    code: "unterminated-quote",
    message: "/review: an argument quote is not closed",
  }));
  using _ = shell;
  await shell.type('/review "open');
  await shell.press("\r");
  const frame = await shell.frame();
  expect(frame).toContain("Not expanded: /review: an argument quote is not closed.");
  expect(frame).toContain('/review "open');
  expect(submitted).toEqual([]);
});

test("built-in slash commands take precedence over package templates", async () => {
  const { shell, requested } = await shellWith(() => expanded("mode", "never"));
  using _ = shell;
  await shell.type("/mode");
  await shell.press("\r");
  await shell.frame();
  expect(requested).toEqual([]);
});

test("a missing required variable is asked for, then the answers expand into the draft", async () => {
  const entries: (Readonly<Record<string, string>> | undefined)[] = [];
  const { shell, submitted } = await shellWith((_text, entered) => {
    entries.push(entered);
    return entered === undefined
      ? {
          kind: "needs-input",
          name: "review",
          variables: [
            { name: "file", expected: "text", description: "File to read", sensitive: false },
            { name: "token", expected: "text", description: "", sensitive: true },
          ],
        }
      : expanded("review", "Review " + entered.file + " with the token.");
  });
  using _ = shell;
  await shell.type("/review depth=2");
  await shell.press("\r");
  let frame = await shell.frame();
  expect(frame).toContain("/review needs file (text): File to read.");
  expect(frame).not.toContain("/review depth=2");
  await shell.type("src/a.ts");
  await shell.press("\r");
  frame = await shell.frame();
  expect(frame).toContain("/review needs token (text; sensitive, kept only in this draft)");
  await shell.type("hunter2");
  await shell.press("\r");
  frame = await shell.frame();
  expect(entries).toEqual([undefined, { file: "src/a.ts", token: "hunter2" }]);
  expect(frame).toContain("Review src/a.ts with the token.");
  expect(frame).toContain("Expanded /review from kit:review");
  expect(submitted).toEqual([]);
});

test("cancelling a variable prompt restores the invocation and sends nothing", async () => {
  let calls = 0;
  const { shell, submitted } = await shellWith(() => {
    calls += 1;
    return {
      kind: "needs-input",
      name: "review",
      variables: [{ name: "file", expected: "text", description: "", sensitive: false }],
    };
  });
  using _ = shell;
  await shell.type("/review depth=2");
  await shell.press("\r");
  await shell.frame();
  await shell.type("half-typed");
  await shell.pressEscape();
  const frame = await shell.frame();
  expect(frame).toContain("Prompt template cancelled. Nothing was sent; your draft is restored.");
  expect(frame).toContain("/review depth=2");
  expect(frame).not.toContain("half-typed");
  expect(calls).toBe(1);
  expect(submitted).toEqual([]);
});
