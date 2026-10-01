import { afterEach, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { removeTemporaryRoots, temporaryRoot } from "../../data/fixtures.ts";
import { packageStandingCliJourney } from "./package-standing-fixtures.ts";

afterEach(removeTemporaryRoots);

test("revoking a dependency, an offline restart, a rollback and a quarantine keep records and never substitute a version", async () => {
  const journey = await packageStandingCliJourney(
    [process.execPath, fileURLToPath(new URL("../../main.ts", import.meta.url))],
    await temporaryRoot("falryn-standing-cli-"),
  );
  expect(journey.revoked.activation).toBe("unavailable");
  expect(journey.rolled.activation).toBe("unavailable");
  expect(journey.purged.code).toBe("uninstalled");
  // The journey starts the source CLI about thirty times (0.2 s each locally); hosted macOS runs
  // several times slower.
}, 90_000);
