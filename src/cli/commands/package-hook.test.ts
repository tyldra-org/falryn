import { afterEach, expect, test } from "bun:test";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { removeTemporaryRoots, temporaryRoot } from "../../data/fixtures.ts";
import { qualifiedHookPython } from "../../integrations/extensions/host-hook-command.ts";
import { nativeProductJourney } from "../runtime/native-product-fixtures.ts";
import { pythonHookFixture } from "./package-hook-fixtures.ts";
import { prepareNativeCliFixture } from "./package-native-fixtures.ts";

afterEach(removeTemporaryRoots);
test.skipIf(!qualifiedHookPython()).each([false, true])(
  "installed Python hooks run through the live gateway, veto=%s",
  async (veto) => {
    const root = await temporaryRoot("falryn-hook-cli-");
    const fixture = await prepareNativeCliFixture(
      [process.execPath, "run", new URL("../../main.ts", import.meta.url).pathname],
      root,
      pythonHookFixture(veto),
    );
    const journey = await nativeProductJourney({
      home: root,
      environment: fixture.environment,
      name: fixture.name,
    });
    const gates = journey.events?.ok
      ? journey.events.value.flatMap((event) =>
          event.kind === "history.recorded" && event.payload.type === "gate" && event.payload.hook
            ? [event.payload]
            : [],
        )
      : [];
    expect(gates.some((gate) => gate.decision === "hook-chain-bound")).toBe(true);
    expect(gates.filter((g) => g.decision === (veto ? "veto" : "observe"))).toHaveLength(
      veto ? 1 : 3,
    );
    expect(journey.result.payload?.stage).toBe(veto ? "attempt-failed" : "attempt-completed");
    if (!veto) expect(journey.requests[1]).toContain('\\"answer\\":42');
  },
  30000,
);

test.skipIf(!qualifiedHookPython())(
  "a changed installed package is refused after catalog capture and before any external hook or native tool",
  async () => {
    const root = await temporaryRoot("falryn-hook-stale-");
    const fixture = await prepareNativeCliFixture(
      [process.execPath, "run", new URL("../../main.ts", import.meta.url).pathname],
      root,
      pythonHookFixture(),
    );
    const directory = join(fixture.environment.FALRYN_STATE_DIR, "packages");
    const name = (await readdir(directory)).find((name) => name.endsWith(".package"));
    if (!name) throw new Error("missing installed fixture");
    const file = join(directory, name);
    const original = await readFile(file);
    const changed = Buffer.from(original);
    changed[changed.length - 1] = 0;
    const journey = await nativeProductJourney(
      { home: root, environment: fixture.environment, name: fixture.name },
      async () => {
        await writeFile(file, changed);
      },
      async () => {
        await writeFile(file, original);
      },
    );
    expect(journey.result.payload?.stage).toBe("attempt-failed");
    const gates = journey.events?.ok
      ? journey.events.value.flatMap((event) =>
          event.kind === "history.recorded" && event.payload.type === "gate" ? [event.payload] : [],
        )
      : [];
    expect(gates.some((gate) => gate.hook && gate.decision === "observe")).toBe(false);
    expect(journey.requests).toHaveLength(1);
  },
  30000,
);

test.skipIf(!qualifiedHookPython()).each([
  ["malformed stdout", "print('not-json')"],
  ["stderr overflow", "import sys\nsys.stderr.write('x'*100000)"],
  ["deadline", "import time\ntime.sleep(20)"],
  ["child creation", "import subprocess\nsubprocess.run(['/usr/bin/true'],check=True)"],
])(
  "the live gateway refuses Python %s before native continuation",
  async (_name, script) => {
    const root = await temporaryRoot("falryn-hook-refusal-");
    const control = pythonHookFixture();
    const fixture = await prepareNativeCliFixture(
      [process.execPath, "run", new URL("../../main.ts", import.meta.url).pathname],
      root,
      { ...control, files: { "hook.py": script } },
    );
    const journey = await nativeProductJourney({
      home: root,
      environment: fixture.environment,
      name: fixture.name,
    });
    const gates = journey.events?.ok
      ? journey.events.value.flatMap((event) =>
          event.kind === "history.recorded" && event.payload.type === "gate" && event.payload.hook
            ? [event.payload]
            : [],
        )
      : [];
    expect(journey.result.payload?.stage).toBe("attempt-failed");
    expect(journey.requests).toHaveLength(1);
    expect(gates.filter((gate) => gate.decision.startsWith("failed:"))).toHaveLength(1);
    expect(gates.filter((gate) => gate.stage === "post-hook")).toHaveLength(0);
    expect(
      gates.find((gate) => gate.decision.startsWith("failed:"))?.hook?.execution?.cleanup,
    ).toBe("complete");
  },
  30000,
);
