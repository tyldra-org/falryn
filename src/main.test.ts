import { describe, expect, test } from "bun:test";

import { SHUTDOWN_PHASES } from "./domain/index.ts";
import { main } from "./main.ts";

describe("application bootstrap", () => {
  test("composes the lifecycle and shuts down cleanly", async () => {
    const report = await main();

    expect(report.outcome).toEqual({ kind: "completed" });
    expect(report.unfinished).toEqual([]);
    expect(report.failures).toEqual([]);
    expect(report.phases.map((phase) => phase.phase)).toEqual([...SHUTDOWN_PHASES]);
  });

  test("releases its host signal subscription", async () => {
    const before = process.listenerCount("SIGINT");
    await main();
    expect(process.listenerCount("SIGINT")).toBe(before);
  });
});
