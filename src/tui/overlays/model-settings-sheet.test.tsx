import { expect, test } from "bun:test";
import { createModelSettingsService } from "../../application/providers/model-settings.ts";
import {
  EMPTY_MODEL_PREFERENCES,
  type ModelPreferences,
} from "../../providers/configuration/policy-schema.ts";
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
function fixture() {
  let preferences: ModelPreferences = structuredClone(EMPTY_MODEL_PREFERENCES);
  let fileRevision: string | null = null;
  const service = createModelSettingsService({
    async read() {
      return {
        preferences,
        fileRevision,
        main: null,
        definitions: [],
        generation: 1,
        scope: "user",
      };
    },
    async validateRoute() {
      return { ok: true };
    },
    async backup() {
      return { ok: false, code: "not-needed" };
    },
    async write(value, expected) {
      if (expected !== fileRevision) return { kind: "stale", code: "stale" };
      preferences = value;
      fileRevision = `revision-${value.revision}`;
      return { kind: "written", revision: fileRevision };
    },
  });
  return { service, get: () => preferences };
}
test("roles panel exposes independent presets and actual empty definition catalog through the shared service", async () => {
  const f = fixture();
  const submission = { ...UNAVAILABLE_SUBMISSION, modelSettings: f.service };
  using shell = await mount(
    <ShellApp theme={THEME} model={MODEL} onExit={() => {}} submission={submission} />,
    { shape: { columns: 100, rows: 34 } },
  );
  await shell.frame();
  await shell.press("p", { ctrl: true });
  await shell.type("model.settings");
  await shell.press("\r");
  await shell.frame("subagents");
  shell.setup.mockInput.pressArrow("down");
  shell.setup.mockInput.pressArrow("down");
  shell.setup.mockInput.pressEnter();
  const presets = await shell.frame("Small");
  expect(presets).toContain("Default");
  expect(presets).toContain("Medium");
  expect(presets).toContain("Big");
  expect(presets).toContain("Advanced");
  for (let n = 0; n < 4; n += 1) shell.setup.mockInput.pressArrow("down");
  shell.setup.mockInput.pressEnter();
  expect(await shell.frame("No matching registered definitions")).toContain(
    "cannot create or launch",
  );
  expect(f.get()).toEqual(EMPTY_MODEL_PREFERENCES);
});
test("terminal configure writes one route using the same revision and codec as headless settings", async () => {
  const f = fixture();
  const submission = { ...UNAVAILABLE_SUBMISSION, modelSettings: f.service };
  using shell = await mount(
    <ShellApp theme={THEME} model={MODEL} onExit={() => {}} submission={submission} />,
    { shape: { columns: 100, rows: 34 } },
  );
  await shell.frame();
  await shell.press("p", { ctrl: true });
  await shell.type("model.settings");
  await shell.press("\r");
  await shell.frame("subagents");
  shell.setup.mockInput.pressArrow("down");
  shell.setup.mockInput.pressEnter();
  await shell.frame("research");
  shell.setup.mockInput.pressEnter();
  await shell.frame("Configure model");
  shell.setup.mockInput.pressEnter();
  await shell.frame("Provider profile");
  await shell.type("account");
  await shell.press("\r");
  await shell.frame("Provider identity");
  await shell.type("test");
  await shell.press("\r");
  await shell.frame("Model identity");
  await shell.type("chosen-model");
  await shell.press("\r");
  await shell.frame("provider-default");
  for (let n = 0; n < 4; n += 1) shell.setup.mockInput.pressArrow("down");
  shell.setup.mockInput.pressEnter();
  await shell.frame("Saved model policy revision 1");
  expect(String(f.get().roles.fast?.default?.modelId)).toBe("chosen-model");
  expect(f.get().roles.fast?.default?.reasoning).toBe("provider-default");
  expect(f.get().roles.default).toBeUndefined();
});
test("all public slash aliases open the same settings surface", async () => {
  for (const alias of ["/model roles", "/model configure", "/settings models"]) {
    using shell = await mount(<ShellApp theme={THEME} model={MODEL} onExit={() => {}} />);
    await shell.frame();
    await shell.press("\t");
    await shell.press("\t");
    await shell.type(alias);
    await shell.press("\r");
    expect(await shell.frame("Model settings are not attached")).toContain("Model roles");
  }
});
