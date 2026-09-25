import { afterEach, test } from "bun:test";
import { removeTemporaryRoots, temporaryRoot } from "../../data/fixtures.ts";
import { createHostSandbox } from "../../integrations/security/host-sandbox.ts";
import { packageHealthCliJourney } from "./package-health-fixtures.ts";

afterEach(removeTemporaryRoots);
const sourceCommand = [process.execPath, "run", new URL("../../main.ts", import.meta.url).pathname];
// Each journey spawns several source-mode CLI processes, so each owns its time budget.
for (const mode of ["healthy", "hostile", "cancel"] as const)
  test.skipIf(createHostSandbox().probe().status !== "available")(
    `source package health starts an exact governed child and replays without execution (${mode})`,
    async () => {
      await packageHealthCliJourney(
        sourceCommand,
        await temporaryRoot(`falryn-health-cli-${mode}-`),
        mode,
      );
    },
    30_000,
  );
