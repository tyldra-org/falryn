/** Which hosts present structured questions locally (#1163). */
import { afterEach, expect, test } from "bun:test";
import { join } from "node:path";
import { removeTemporaryRoots, temporaryRoot } from "../../data/fixtures.ts";
import { createStaticEnvironment } from "../../domain/foundation/index.ts";
import { openProductArtifactSession } from "./product-artifact-session.ts";
import { createServiceProvider } from "./services.ts";

afterEach(removeTemporaryRoots);

async function services() {
  const home = await temporaryRoot("falryn-question-host-");
  return createServiceProvider(
    {
      color: "never",
      format: "json",
      nonInteractive: true,
      profile: null,
      quiet: false,
      timeoutMs: null,
      verbose: false,
      workspace: null,
      addDirs: [],
      help: false,
      version: false,
    },
    {
      home,
      platform: "darwin",
      currentDirectory: home,
      environment: createStaticEnvironment({
        FALRYN_STATE_DIR: join(home, "state"),
        FALRYN_CONFIG_DIR: join(home, "config"),
      }),
    },
  )();
}

test("headless hosts present no questions; the interactive terminal presents them locally", async () => {
  const headless = await openProductArtifactSession(await services());
  if (!headless) throw new Error("product store unavailable");
  try {
    expect(headless.workflowQuestions).not.toBeNull();
    expect(headless.questionPresenter).toBeNull();
  } finally {
    await headless.close();
  }
  const interactive = await openProductArtifactSession(await services(), undefined, undefined, {
    localPresenter: true,
  });
  if (!interactive) throw new Error("product store unavailable");
  try {
    expect(interactive.questionPresenter?.view()).toEqual({ current: null, queued: 0, left: 0 });
  } finally {
    await interactive.close();
  }
});
