import { expect, test } from "bun:test";
import { generationProduct } from "../../application/runtime/product-generation.fixture.ts";
import { duration } from "../../domain/foundation/index.ts";
import { createProductSubmissionPort } from "../composer/product-submission.ts";
import { mount } from "../runtime/harness.tsx";
import { ShellApp } from "./shell-app.tsx";
import { known, unavailable } from "./view-model.ts";

test("the status line shows the live labelled rate while streaming and the last rate after", async () => {
  const product = generationProduct();
  let release = (): void => {};
  const paused = new Promise<void>((resolve) => {
    release = resolve;
  });
  product.state.scripts.push(async function* (_spine, clock) {
    for (let index = 0; index < 6; index += 1) {
      await clock.advance(duration(250));
      yield { kind: "text-delta", text: "x".repeat(40) };
    }
    // Still generating: history capture has not published these deltas yet.
    await paused;
    await clock.advance(duration(250));
    yield { kind: "usage", usage: { provenance: "provider-reported", outputTokens: 60 } };
    yield { kind: "finished", finishReason: "stop" };
  });
  const submission = createProductSubmissionPort({
    executor: product.executor,
    sessionId: product.runtime.correlation.sessionId,
    configurationGeneration: product.runtime.correlation.configurationGeneration,
  });
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
    // Wide enough that the generation text, which a narrow line drops first, fits.
    { shape: { columns: 240, rows: 30 } },
  );
  await shell.frame();
  await shell.press("\t");
  await shell.press("\t");
  await shell.type("Explain");
  await shell.press("\r");

  // Six estimated deltas of ten tokens, the first 250 ms in: 60 tokens over
  // the 1250 ms since first output.
  expect(await shell.frame("Generating")).toContain("Generating    48 tok/s est. live");
  release();
  // Final: 60 reported tokens from first output to terminal, 1500 ms.
  expect(await shell.frame("Last  ")).toContain("Last    40 tok/s");
});
