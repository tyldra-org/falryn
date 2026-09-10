import { afterEach, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { removeTemporaryRoots, temporaryRoot } from "../../data/fixtures.ts";
import { parseInvocation } from "../command-tree.ts";
import { peerCliJourney } from "./peer-fixtures.ts";

afterEach(removeTemporaryRoots);
test("public CLI preserves offline receipts and independent waiter state across command restarts", async () => {
  await peerCliJourney(
    [process.execPath, fileURLToPath(new URL("../../main.ts", import.meta.url))],
    await temporaryRoot("peer-cli-"),
  );
}, 30_000);
test("peer help and invalid actions do not need a product session", async () => {
  expect((await parseInvocation(["peer", "--help"])).kind).toBe("help");
  expect((await parseInvocation(["peer", "execute", "alice"])).kind).toBe("invalid");
  expect((await parseInvocation(["peer", "send"])).kind).toBe("invalid");
});
