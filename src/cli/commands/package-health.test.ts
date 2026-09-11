import { afterEach, test } from "bun:test";
import { removeTemporaryRoots, temporaryRoot } from "../../data/fixtures.ts";
import { createHostSandbox } from "../../integrations/security/host-sandbox.ts";
import { packageHealthCliJourney } from "./package-health-fixtures.ts";

afterEach(removeTemporaryRoots);
test.skipIf(createHostSandbox().probe().status !== "available")(
  "source package health starts an exact governed child and replays without execution",
  async () => {
    await packageHealthCliJourney(
      [process.execPath, "run", new URL("../../main.ts", import.meta.url).pathname],
      await temporaryRoot("falryn-health-cli-"),
    );
    await packageHealthCliJourney(
      [process.execPath, "run", new URL("../../main.ts", import.meta.url).pathname],
      await temporaryRoot("falryn-health-cli-hostile-"),
      "hostile",
    );
    await packageHealthCliJourney(
      [process.execPath, "run", new URL("../../main.ts", import.meta.url).pathname],
      await temporaryRoot("falryn-health-cli-cancel-"),
      "cancel",
    );
  },
  30_000,
);
