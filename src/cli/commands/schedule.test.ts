import { afterEach, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { removeTemporaryRoots, temporaryRoot } from "../../data/fixtures.ts";
import { parseInvocation } from "../command-tree.ts";
import { scheduleCliJourney } from "./schedule-fixtures.ts";

afterEach(removeTemporaryRoots);
test("schedule help and invalid syntax are inert", async () => {
  expect((await parseInvocation(["schedule", "--help"])).kind).toBe("help");
  expect((await parseInvocation(["schedule", "enable"])).kind).toBe("invalid");
});
test("public product persists inert schedules and exposes the same metadata after restart", async () => {
  await scheduleCliJourney(
    [process.execPath, fileURLToPath(new URL("../../main.ts", import.meta.url))],
    await temporaryRoot("schedule-cli-"),
  );
}, 30000);
