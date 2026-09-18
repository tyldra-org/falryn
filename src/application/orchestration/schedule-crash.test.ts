import { afterEach, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { removeTemporaryRoots, temporaryRoot } from "../../data/fixtures.ts";
import { crashHost } from "./schedule-crash-fixtures.ts";

afterEach(removeTemporaryRoots);
for (const phase of ["slot", "admission", "effect", "terminal", "notification"])
  test.skipIf(process.platform === "win32")(
    `killed executor at ${phase} preserves one occurrence and never repeats an uncertain effect`,
    async () => {
      const root = await temporaryRoot("schedule-crash-");
      const child = Bun.spawn(
        [
          process.execPath,
          fileURLToPath(new URL("./schedule-crash-fixtures.ts", import.meta.url)),
          root,
          phase,
        ],
        { stdout: "pipe", stderr: "pipe" },
      );
      try {
        const reader = child.stdout.getReader();
        const ready = await reader.read();
        expect(new TextDecoder().decode(ready.value)).toContain("ready");
        reader.releaseLock();
      } finally {
        child.kill("SIGKILL");
        await child.exited;
      }
      const recovered = await crashHost(root, phase, true);
      expect(recovered?.attempts).toMatchObject({
        ok: true,
        value: [
          {
            terminal: {
              status: ["admission", "effect"].includes(phase) ? "uncertain" : "succeeded",
            },
          },
        ],
      });
      expect(recovered?.attempts.ok && recovered.attempts.value.length).toBe(1);
      expect(recovered?.notices).toEqual({ ok: true, value: [] });
      const effects = await readFile(join(root, "effects"), "utf8").catch(() => "");
      expect(effects).toBe(phase === "admission" ? "" : "effect\n");
      const again = await crashHost(root, phase, true);
      expect(again).toEqual(recovered);
    },
    15000,
  );
