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
    },
  };
}

async function shellWith(expand: (text: string) => PromptExpansion) {
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
        async expandTemplate(text) {
          requested.push(text);
          return expand(text);
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
