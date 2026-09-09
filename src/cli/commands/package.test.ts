import { afterEach, expect, test } from "bun:test";
import { dirname, join } from "node:path";
import { removeTemporaryRoots, temporaryRoot } from "../../data/fixtures.ts";
import { parseInvocation } from "../command-tree.ts";
import { packageCliJourney } from "./package-fixtures.ts";

afterEach(removeTemporaryRoots);
test("source CLI confirms exact lifecycle generations across separate processes", async () => {
  const root = await temporaryRoot("falryn-package-cli-");
  await packageCliJourney(
    [process.execPath, "run", join(dirname(dirname(dirname(import.meta.path))), "main.ts")],
    root,
  );
}, 30_000);
test("package help needs no request or services; unsupported actions and missing input fail", async () => {
  expect((await parseInvocation(["package", "--help"])).kind).toBe("help");
  expect((await parseInvocation(["package", "install"])).kind).toBe("invalid");
  expect((await parseInvocation(["package", "run"])).kind).toBe("invalid");
});
