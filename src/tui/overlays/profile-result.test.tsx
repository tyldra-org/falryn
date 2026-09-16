import { expect, test } from "bun:test";
import { UNAVAILABLE_SUBMISSION } from "../composer/index.ts";
import { mount } from "../runtime/harness.tsx";
import { ShellApp } from "../shell/shell-app.tsx";
import { known, type ShellModel, unavailable } from "../shell/view-model.ts";
import type { ThemeRequest } from "../theme/index.ts";

const THEME: ThemeRequest = {
  variant: "dark",
  colorLevel: "truecolor",
  symbols: "unicode",
  reducedMotion: true,
  generation: 1,
};
const MODEL: Omit<ShellModel, "overlay" | "commands" | "transcript" | "composer" | "activity"> = {
  header: {
    workspace: known("/work/falryn"),
    branch: unavailable("no Git"),
    session: unavailable("no session"),
    model: unavailable("no provider"),
  },
  status: { status: "informational", message: "Nothing is running.", hints: [] },
  help: [],
};

test("working profile inspection displays the shared receipt in a native scrollable overlay", async () => {
  const args: (string | null)[] = [];
  const receipt = {
    candidateId: "reviewed-candidate",
    publishedGeneration: 4,
    owners: Array.from({ length: 24 }, (_, index) => ({
      owner: `owner-${index}`,
      state: "pending",
      generation: 3,
    })),
    code: "partial-end-of-receipt",
  };
  const submission = {
    ...UNAVAILABLE_SUBMISSION,
    workingProfile: async (argument: string | null) => {
      args.push(argument);
      return receipt;
    },
  };
  using shell = await mount(
    <ShellApp theme={THEME} model={MODEL} onExit={() => {}} submission={submission} />,
    { shape: { columns: 100, rows: 34 } },
  );
  await shell.frame();
  await shell.press("p", { ctrl: true });
  await shell.type("profile.inspect");
  await shell.press("\r");
  expect(await shell.frame("reviewed-candidate")).toContain('"publishedGeneration": 4');
  expect(args).toEqual([null]);
  for (let index = 0; index < 160; index++) shell.setup.mockInput.pressArrow("down");
  expect(await shell.frame("partial-end-of-receipt")).toContain("owner-23");
  await shell.pressEscape();
  expect(await shell.frame()).not.toContain("owner-23");
});

test("environment inspection uses the shared receipt without invoking reload", async () => {
  const actions: string[] = [];
  const submission = {
    ...UNAVAILABLE_SUBMISSION,
    environment: {
      async execute(action: "inspect" | "reload") {
        actions.push(action);
        return {
          kind: "environment" as const,
          inspection: {
            state: "active" as const,
            generation: "env-generation",
            configurationGeneration: 2,
            prepared: null,
            code: "environment-applied",
            effects: "none" as const,
            outdated: false,
            ineligibleMappings: [],
            sources: [],
          },
          restartRequired: ["retained-service"],
          transition: null,
        };
      },
    },
  };
  using shell = await mount(
    <ShellApp theme={THEME} model={MODEL} onExit={() => {}} submission={submission} />,
    { shape: { columns: 100, rows: 34 } },
  );
  await shell.frame();
  await shell.press("p", { ctrl: true });
  await shell.type("environment.inspect");
  await shell.press("\r");
  expect(await shell.frame("env-generation")).toContain("Scoped environment");
  expect(actions).toEqual(["inspect"]);
});
