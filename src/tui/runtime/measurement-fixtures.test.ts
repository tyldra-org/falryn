import { describe, expect, test } from "bun:test";
import { fstatSync } from "node:fs";

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
});
