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
test("peer actions use the user control port and Escape cancels only its wait", async () => {
  const requests: unknown[] = [];
  let turns = 0;
  let cancelled = false;
  using shell = await mount(
    <ShellApp
      theme={{
        variant: "dark",
        colorLevel: "truecolor",
        symbols: "unicode",
        reducedMotion: true,
        generation: 1,
      }}
      model={model}
      onExit={() => {}}
      submission={{
        submit(snapshot) {
          turns += 1;
          return { kind: "accepted", snapshot };
        },
        async peer(input, signal) {
          requests.push(input);
          return new Promise((resolve) =>
            signal.addEventListener(
              "abort",
              () => {
                cancelled = true;
                resolve({ ok: true, value: { wait: "cancelled-locally" } });
              },
              { once: true },
            ),
          );
        },
      }}
    />,
    { shape: { columns: 120, rows: 30 } },
  );
  await shell.frame();
  await shell.press("\t");
  await shell.press("\t");
  await shell.type(
    '/peer {"operation":"subscribe","subscriptionId":"watch","predicate":"idle","waitMs":1000}',
  );
  await shell.press("\r");
  expect({ requests, frame: await shell.frame() }).toMatchObject({
    requests: [
      { operation: "subscribe", subscriptionId: "watch", predicate: "idle", waitMs: 1000 },
    ],
  });
  expect(turns).toBe(0);
  await shell.press("\u001b");
  expect(cancelled).toBe(true);
  expect(await shell.frame()).toContain("Local peer wait cancelled");
  expect(turns).toBe(0);
});
