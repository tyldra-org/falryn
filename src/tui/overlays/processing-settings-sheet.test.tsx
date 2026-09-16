import { expect, test } from "bun:test";
import {
  createModelSettingsService,
  withProcessingSession,
} from "../../application/providers/model-settings.ts";
import {
  processingProduct,
  reportedProcessing,
} from "../../application/runtime/product-processing.fixture.ts";
import { createProductSubmissionPort } from "../composer/product-submission.ts";
import { mount } from "../runtime/harness.tsx";
import { ShellApp } from "../shell/shell-app.tsx";
import { known, unavailable } from "../shell/view-model.ts";

test("keyboard processing controls inspect without calls, reject pasted forms and preserve truthful actual status after resize", async () => {
  const p = processingProduct();
  const service = withProcessingSession(
    createModelSettingsService({
      read: async () => ({
        preferences: p.preferences,
        main: p.preferences.roles.default,
        generation: 5,
        fileRevision: null,
        scope: "user",
        definitions: [],
      }),
      validateRoute: async () => ({ ok: true }),
      backup: async () => ({ ok: false, code: "not-used" }),
      write: async () => {
        throw new Error("No implicit save");
      },
    }),
    p.executor.processing,
  );
  const submission = {
    ...createProductSubmissionPort({
      executor: p.executor,
      sessionId: p.runtime.correlation.sessionId,
      configurationGeneration: p.runtime.correlation.configurationGeneration,
    }),
    modelSettings: service,
  };
  using shell = await mount(
    <ShellApp
      theme={{
        variant: "dark",
        colorLevel: "truecolor",
        symbols: "unicode",
        reducedMotion: true,
        generation: 1,
      }}
      model={{
        header: {
          workspace: known("fixture"),
          branch: unavailable("none"),
          session: unavailable("none"),
          model: unavailable("none"),
        },
        status: { status: "informational", message: "Ready", hints: [] },
        help: [],
      }}
      onExit={() => {}}
      submission={submission}
    />,
    { shape: { columns: 140, rows: 36 } },
  );
  await shell.frame();
  await shell.press("\t");
  await shell.press("\t");
  await shell.type("/fast");
  await shell.press("\r");
  expect(await shell.frame("Provider default")).toContain("Processing speed");
  expect(p.requests).toHaveLength(0);
  expect(p.executor.processing.inspect().override).toBeNull();
  await shell.pressEscape();
  expect(await shell.type("/fast on")).toContain("/fast on");
  await shell.pressEnter();
  expect(await shell.frame()).toContain("next fast");
  expect(p.executor.processing.inspect().override?.mode).toBe("fast");
  p.state.observations = [reportedProcessing("standard")];
  await shell.type("Reply briefly");
  await shell.press("\r");
  expect(await shell.frame("Last speed standard")).toContain("next fast");
  expect(p.requests).toHaveLength(1);
  expect(p.requests[0]?.processing?.preference.mode).toBe("fast");
  await shell.type("/fast off");
  await shell.press("\r");
  await shell.frame("next standard");
  expect(p.executor.processing.inspect().override?.mode).toBe("standard");
  await shell.type("/fast reset");
  await shell.press("\r");
  await shell.frame("next provider-default");
  expect(p.executor.processing.inspect().override).toBeNull();
  await shell.paste("/fast unexpected");
  await shell.press("\r");
  await shell.frame("takes no argument");
  expect(p.requests).toHaveLength(1);
  shell.setup.resize(45, 15);
  expect(await shell.frame()).toContain("/fast takes no argument");
  expect(p.executor.processing.inspect().lastServed?.actualMode).toBe("standard");
});
