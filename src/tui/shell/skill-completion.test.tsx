import { expect, test } from "bun:test";
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

async function shellWith() {
  const submitted: string[] = [];
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
        skillCandidates: () => ({
          invocable: new Set(["deploy", "release-notes", "review"]),
          templates: new Set(["review"]),
        }),
      }}
    />,
    { shape: { columns: 140, rows: 30 } },
  );
  await shell.frame();
  await shell.press("\t");
  await shell.press("\t");
  return { shell, submitted };
}

test("Tab completes an invocable skill command in the composer", async () => {
  const { shell, submitted } = await shellWith();
  using _ = shell;
  await shell.type("/dep");
  await shell.press("\t");
  expect(await shell.frame()).toContain("/deploy ");
  await shell.type("now");
  await shell.press("\r");
  await shell.frame();
  expect(submitted.map((text) => text.trim())).toEqual(["/deploy now"]);
});

test("several matches are listed, and a template's name completes qualified", async () => {
  const { shell } = await shellWith();
  using _ = shell;
  await shell.type("/re");
  await shell.press("\t");
  expect(await shell.frame()).toContain("Skills: /release-notes, /skill:review");
  await shell.type("v");
  await shell.press("\t");
  expect(await shell.frame()).toContain("/skill:review ");
});

test("Tab still moves focus when the draft is not a skill command", async () => {
  const { shell } = await shellWith();
  using _ = shell;
  await shell.type("hello");
  expect(await shell.frame()).toContain("hello");
  await shell.press("\t");
  await shell.type("xyz");
  expect(await shell.frame()).not.toContain("helloxyz");
});
