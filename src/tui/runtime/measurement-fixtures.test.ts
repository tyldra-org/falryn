import { describe, expect, test } from "bun:test";
import { closeSync, fstatSync, openSync } from "node:fs";

import { openMeasurementPty } from "./measurement-fixtures.ts";

const ptyAvailable = (() => {
  const pty = openMeasurementPty();
  pty?.close();
  return pty !== null;
})();

describe.if(ptyAvailable)("measurement PTY teardown", () => {
  test("closes both descriptors owned by the fixture", () => {
    const pty = openMeasurementPty();
    if (pty === null) {
      throw new Error("the PTY availability probe changed during the test");
    }

    const descriptors = [pty.master, pty.slave];
    pty.close();

    for (const descriptor of descriptors) {
      expect(() => fstatSync(descriptor)).toThrow();
    }

    // Teardown is idempotent, including after both descriptors are closed.
    pty.close();
  });

  test("a file that reuses a closed descriptor number stays open after teardown", async () => {
    // Before the reader owned its own duplicate, the stream closed the reused number
    // behind the next file, and Bun then failed to read the following test file.
    for (let attempt = 0; attempt < 20; attempt++) {
      const pty = openMeasurementPty();
      if (pty === null) throw new Error("the PTY availability probe changed during the test");
      await Bun.sleep(2);
      pty.close();
      const reused = openSync(import.meta.path, "r");
      await Bun.sleep(10);
      try {
        expect(() => fstatSync(reused)).not.toThrow();
      } finally {
        closeSync(reused);
      }
    }
  });
});
