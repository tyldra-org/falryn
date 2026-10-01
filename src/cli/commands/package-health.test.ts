import { afterEach, test } from "bun:test";
import { removeTemporaryRoots, temporaryRoot } from "../../data/fixtures.ts";
import { createHostSandbox } from "../../integrations/security/host-sandbox.ts";
import { packageHealthCliJourney } from "./package-health-fixtures.ts";

afterEach(removeTemporaryRoots);
// Each journey runs several CLI commands and governed children, so each owns its time budget.
for (const mode of ["healthy", "hostile", "cancel"] as const)
  test.skipIf(createHostSandbox().probe().status !== "available")(
    `source package health starts an exact governed child and replays without execution (${mode})`,
    async () => {
      await packageHealthCliJourney(
        "in-process",
        await temporaryRoot(`falryn-health-cli-${mode}-`),
        mode,
      );
    },
    // Hosted macOS runs governed children several times slower than a local machine.
    90_000,
  );
