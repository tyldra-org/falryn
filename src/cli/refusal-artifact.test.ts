/**
 * Over-bound machine refusals against a real temporary artifact store.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { removeTemporaryRoots } from "../data/fixtures.ts";
import { createStaticEnvironment, localPath } from "../domain/index.ts";
import { dispatch } from "./dispatch.ts";
import type { GlobalOptions } from "./options.ts";
import { createOverBoundArtifactWriter } from "./refusal-artifact.ts";
import { MAX_CLI_RECORD_BYTES, readCliRecord } from "./schema.ts";
import { createServiceProvider } from "./services.ts";
import { createRecordingCliStreams } from "./streams.ts";

afterEach(removeTemporaryRoots);

const homes: string[] = [];

afterEach(async () => {
  for (const home of homes.splice(0)) {
    await rm(home, { recursive: true, force: true });
  }
});

const DEFAULTS: GlobalOptions = {
  format: "json",
  color: "auto",
  quiet: false,
  verbose: false,
  nonInteractive: true,
  workspace: null,
  profile: null,
  timeoutMs: null,
  help: false,
  version: false,
};

async function temporaryHome(): Promise<{
  readonly home: string;
  readonly services: (globals: GlobalOptions) => ReturnType<typeof createServiceProvider>;
}> {
  const home = await mkdtemp(join(tmpdir(), "falryn-refusal-"));
  homes.push(home);
  for (const name of ["state", "artifacts", "tmp", "config"]) {
    const path = join(home, name);
    await mkdir(path, { recursive: true });
    await chmod(path, 0o700);
  }
  await chmod(home, 0o700);
  const environment = createStaticEnvironment({
    FALRYN_STATE_DIR: join(home, "state"),
    FALRYN_ARTIFACT_DIR: join(home, "artifacts"),
    FALRYN_TEMP_DIR: join(home, "tmp"),
    FALRYN_CONFIG_DIR: join(home, "config"),
  });
  return {
    home,
    services: (globals) =>
      createServiceProvider(globals, {
        home: localPath(home),
        platform: "darwin",
        environment,
      }),
  };
}

describe("over-bound refusal spill", () => {
  test("writes the full result and resolves it through artifact get", async () => {
    const seeded = await temporaryHome();
    const writer = createOverBoundArtifactWriter(seeded.services(DEFAULTS));
    const payload = JSON.stringify({
      kind: "result",
      note: "spilled-cli-result",
      blob: "x".repeat(MAX_CLI_RECORD_BYTES),
    });
    const bytes = new TextEncoder().encode(payload);
    const spilled = await writer({ bytes });
    expect(spilled.ok).toBe(true);
    if (!spilled.ok) {
      return;
    }

    const showStreams = createRecordingCliStreams();
    const showCode = await dispatch({
      argv: ["artifact", "show", spilled.artifact.artifactId, "--format", "json"],
      streams: showStreams,
      services: seeded.services,
    });
    expect(showCode).toBe(0);
    const show = JSON.parse(showStreams.resultWrites().join(""));
    expect(readCliRecord(show).kind).toBe("accepted");
    expect(show.payload.lineage.artifactId).toBe(spilled.artifact.artifactId);

    const output = join(seeded.home, "out.json");
    const getStreams = createRecordingCliStreams();
    const getCode = await dispatch({
      argv: ["artifact", "get", spilled.artifact.artifactId, "--output", output],
      streams: getStreams,
      services: seeded.services,
    });
    expect(getCode).toBe(0);
    expect(await Bun.file(output).text()).toBe(payload);
  });
});
