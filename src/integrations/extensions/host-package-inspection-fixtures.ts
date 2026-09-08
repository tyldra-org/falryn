/** Isolate filesystem interception in a child so other tests keep the real module. */
import { mock, spyOn } from "bun:test";
import * as filesystem from "node:fs/promises";
import { join } from "node:path";

const directory = process.argv[2];
const scenario = process.argv[3];
if (directory === undefined) throw new Error("Missing fixture directory.");
let changed = false;
const openFile = filesystem.open;
mock.module("node:fs/promises", () => ({
  ...filesystem,
  open: async (...args: Parameters<typeof filesystem.open>) => {
    const handle = await openFile(...args);
    return {
      stat: handle.stat.bind(handle),
      close: handle.close.bind(handle),
      read: async (...readArgs: Parameters<typeof handle.read>) => {
        const result = await handle.read(...readArgs);
        if (!changed) {
          changed = true;
          if (scenario === "replace") {
            await filesystem.rename(join(directory, "plugin.json"), join(directory, "old.json"));
            await filesystem.writeFile(join(directory, "plugin.json"), "{}");
          } else if (scenario === "deadline") {
            const now = performance.now() + 31_000;
            spyOn(performance, "now").mockReturnValue(now);
          }
        }
        return result;
      },
    };
  },
}));
const { createHostPackageSource } = await import("./host-package-inspection.ts");
try {
  await createHostPackageSource(directory).read();
  console.log("unexpected-success");
} catch (error) {
  console.log(error instanceof Error ? error.message : "unknown");
}
