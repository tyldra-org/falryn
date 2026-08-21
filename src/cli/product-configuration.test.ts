/**
 * Product configuration load (#728).
 */

import { describe, expect, test } from "bun:test";

import { CONFIGURATION_FILE_NAME } from "../config/index.ts";
import type { ConfigurationLoadOutcome } from "../domain/index.ts";
import {
  configurationGeneration,
  createInMemoryFileSystem,
  createStaticEnvironment,
  localPath,
  streamId,
} from "../domain/index.ts";
import type { GlobalOptions } from "./options.ts";
import {
  configurationGenerationFromLoadOutcome,
  loadProductConfiguration,
  productConfigurationLoadRequest,
} from "./product-configuration.ts";
import { CLI_EVENT_STREAM, createServiceProvider } from "./services.ts";

const GLOBALS: GlobalOptions = {
  color: "auto",
  format: "human",
  nonInteractive: false,
  profile: null,
  quiet: false,
  timeoutMs: null,
  verbose: false,
  workspace: null,
  addDirs: [],
  help: false,
  version: false,
};

describe("configurationGenerationFromLoadOutcome", () => {
  test("uses the published record generation", () => {
    const generation = configurationGeneration.from(2);
    const outcome: ConfigurationLoadOutcome = {
      kind: "published",
      record: {
        generation,
        values: {},
        provenance: [],
        overridden: [],
        sources: [],
        issues: [],
      },
      changes: [],
      applicationClass: "live",
    };
    const resolved = configurationGenerationFromLoadOutcome(outcome, {
      load: async () => outcome,
      current: () => null,
    });
    expect(resolved).toBe(generation);
  });

  test("falls back to the first generation when nothing is retained", () => {
    const resolved = configurationGenerationFromLoadOutcome(
      { kind: "rejected", issues: [], sources: [], retained: null },
      { load: async () => ({ kind: "cancelled" }), current: () => null },
    );
    expect(resolved).toBe(configurationGeneration.from(0));
  });
});

describe("loadProductConfiguration", () => {
  test("appends a durable generation event on first load", async () => {
    const fileSystem = createInMemoryFileSystem();
    const provider = createServiceProvider(GLOBALS, {
      home: localPath("/home/tester"),
      platform: "darwin",
      environment: createStaticEnvironment({}),
      currentDirectory: localPath("/workspace"),
      fileSystem,
    });
    const graph = provider();
    fileSystem.put(`${graph.configurationRoot}/${CONFIGURATION_FILE_NAME}`, {
      kind: "file",
      text: JSON.stringify({ schemaVersion: 1, diagnostics: { level: "warn" } }),
    });

    const loaded = await loadProductConfiguration(graph, productConfigurationLoadRequest(GLOBALS));
    expect(loaded.outcome.kind).toBe("published");
    expect(loaded.generation).toBe(configurationGeneration.from(0));
    expect(loaded.values["diagnostics.level"]).toBe("warn");

    const read = await graph.eventStore.readFrom(
      { streamId: streamId.from(CLI_EVENT_STREAM), afterSequence: null },
      10,
    );
    expect(read.ok).toBe(true);
    if (!read.ok) {
      return;
    }
    expect(read.value.some((event) => event.kind === "configuration.generation.changed")).toBe(
      true,
    );
  });

  test("advances generation when configuration changes between loads", async () => {
    const fileSystem = createInMemoryFileSystem();
    const provider = createServiceProvider(GLOBALS, {
      home: localPath("/home/tester"),
      platform: "darwin",
      environment: createStaticEnvironment({}),
      currentDirectory: localPath("/workspace"),
      fileSystem,
    });
    const graph = provider();
    const userFile = `${graph.configurationRoot}/${CONFIGURATION_FILE_NAME}`;
    fileSystem.put(userFile, {
      kind: "file",
      text: JSON.stringify({ schemaVersion: 1, diagnostics: { level: "warn" } }),
    });

    await loadProductConfiguration(graph, productConfigurationLoadRequest(GLOBALS));
    fileSystem.put(userFile, {
      kind: "file",
      text: JSON.stringify({ schemaVersion: 1, diagnostics: { level: "error" } }),
    });
    const second = await loadProductConfiguration(graph, productConfigurationLoadRequest(GLOBALS));

    expect(second.outcome.kind).toBe("published");
    expect(second.generation).toBe(configurationGeneration.from(1));
  });
});
