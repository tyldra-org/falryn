/**
 * Default TUI product attachments (#752 / #728).
 */

import { describe, expect, test } from "bun:test";

import { CONFIGURATION_FILE_NAME } from "../config/index.ts";
import {
  configurationGeneration,
  createInMemoryEventStore,
  createInMemoryFileSystem,
  createStaticEnvironment,
  createSystemClock,
  localPath,
  streamId,
} from "../domain/index.ts";
import { snapshotOf } from "../tui/composer/index.ts";
import type { GlobalOptions } from "./options.ts";
import {
  loadProductConfiguration,
  productConfigurationLoadRequest,
} from "./product-configuration.ts";
import { composeProductShellAttachments } from "./product-shell-attachments.ts";
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

describe("composeProductShellAttachments", () => {
  test("builds a submission port that accepts a non-empty draft", async () => {
    const attachments = await composeProductShellAttachments({
      eventStore: createInMemoryEventStore(),
      clock: createSystemClock(),
      environment: createStaticEnvironment({}),
      fileSystem: createInMemoryFileSystem({ nodes: {} }),
      workspaceSet: null,
      configurationGeneration: configurationGeneration.from(0),
    });
    expect(attachments).not.toBeNull();
    if (attachments === null) {
      return;
    }
    const outcome = await attachments.submission.submit(snapshotOf("wire me", 1));
    expect(outcome.kind).toBe("accepted");
    expect(attachments.transcriptFeed.events().length).toBeGreaterThan(0);
  });

  test("fails closed for an empty draft without the permanent #707 stub", async () => {
    const attachments = await composeProductShellAttachments({
      eventStore: createInMemoryEventStore(),
      clock: createSystemClock(),
      environment: createStaticEnvironment({}),
      fileSystem: createInMemoryFileSystem({ nodes: {} }),
      workspaceSet: null,
      configurationGeneration: configurationGeneration.from(0),
    });
    expect(attachments).not.toBeNull();
    if (attachments === null) {
      return;
    }
    const outcome = await attachments.submission.submit(snapshotOf("   ", 1));
    expect(outcome.kind).toBe("unavailable");
    if (outcome.kind !== "unavailable") {
      return;
    }
    expect(outcome.reason).toContain("empty");
    expect(outcome.owner).toBe("#707");
    expect(outcome.reason).not.toContain("no agent submission port is attached");
  });

  test("correlates turns with a loader-derived generation, not a hardcoded zero", async () => {
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
    const loaded = await loadProductConfiguration(graph, productConfigurationLoadRequest(GLOBALS));
    expect(loaded.generation).toBe(configurationGeneration.from(1));

    const attachments = await composeProductShellAttachments({
      eventStore: graph.eventStore,
      clock: graph.clock,
      environment: graph.environment,
      fileSystem: graph.fileSystem,
      workspaceSet: null,
      configurationGeneration: loaded.generation,
    });
    expect(attachments).not.toBeNull();
    if (attachments === null) {
      return;
    }

    const accepted = await attachments.submission.submit(snapshotOf("observe generation", 1));
    expect(accepted.kind).toBe("accepted");
    const turnStarted = attachments.transcriptFeed
      .events()
      .find((event) => event.kind === "turn.started");
    expect(turnStarted?.correlation.configurationGeneration).toBe(configurationGeneration.from(1));

    const read = await graph.eventStore.readFrom(
      { streamId: streamId.from(CLI_EVENT_STREAM), afterSequence: null },
      20,
    );
    expect(read.ok).toBe(true);
    if (!read.ok) {
      return;
    }
    expect(
      read.value.filter((event) => event.kind === "configuration.generation.changed").length,
    ).toBeGreaterThanOrEqual(2);
  });
});
