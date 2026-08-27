import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CONFIGURATION_FILE_NAME } from "../config/index.ts";
import { createStaticEnvironment, localPath, modelId, providerId } from "../domain/index.ts";
import type { ProviderProfile } from "../providers/index.ts";
import type { GlobalOptions } from "./options.ts";
import { composeProductProviderConnections } from "./product-provider-connections.ts";
import { createServiceProvider } from "./services.ts";

const GLOBALS: GlobalOptions = {
  color: "auto",
  format: "human",
  nonInteractive: true,
  profile: null,
  quiet: false,
  timeoutMs: null,
  verbose: false,
  workspace: null,
  addDirs: [],
  help: false,
  version: false,
};

function localProfile(): ProviderProfile {
  return {
    profileId: "local",
    providerId: providerId.from("local"),
    adapterKind: "openai",
    displayName: "Local",
    endpoint: "http://127.0.0.1:11434/v1",
    credential: null,
    organization: null,
    project: null,
    enabledModels: [modelId.from("coder")],
    discovery: "static",
    timeouts: { connectMs: 1_000, requestMs: 10_000 },
  };
}

describe("product provider connection persistence", () => {
  const homes: string[] = [];

  afterEach(async () => {
    for (const home of homes.splice(0)) {
      await rm(home, { recursive: true, force: true });
    }
  });

  test("reconstructs the selected profile from typed configuration after restart", async () => {
    const home = await mkdtemp(join(tmpdir(), "falryn-provider-"));
    homes.push(home);
    const services = createServiceProvider(GLOBALS, {
      home: localPath(home),
      platform: "darwin",
      currentDirectory: localPath(home),
      environment: createStaticEnvironment({ FALRYN_STATE_DIR: home }),
    });
    const graph = services();
    const first = composeProductProviderConnections(graph, GLOBALS).service;

    expect(await first.execute({ kind: "add", profile: localProfile() })).toMatchObject({
      kind: "completed",
      selectedProfileId: "openai",
    });
    expect(await first.execute({ kind: "use", profileId: "local" })).toMatchObject({
      kind: "completed",
      selectedProfileId: "local",
    });

    const restarted = composeProductProviderConnections(graph, GLOBALS).service;
    const listed = await restarted.execute({ kind: "list" });
    expect(listed).toMatchObject({
      kind: "completed",
      selectedProfileId: "local",
      connections: [
        { profileId: "openai", selected: false },
        { profileId: "local", selected: true },
      ],
    });

    const document = await readFile(join(graph.configurationRoot, CONFIGURATION_FILE_NAME), "utf8");
    expect(document).toContain('"connections"');
    expect(document).toContain('"selectedProfileId": "local"');
    expect(document).not.toContain("sk-live-secret-material");
  });
});
