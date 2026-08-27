/**
 * Default TUI product attachments (#752 / #728).
 */

import { describe, expect, test } from "bun:test";
import { createEphemeralProductIndexPort } from "../application/index.ts";
import { CONFIGURATION_FILE_NAME } from "../config/index.ts";
import {
  configurationGeneration,
  createInMemoryEventStore,
  createInMemoryFileSystem,
  createStaticEnvironment,
  createSystemClock,
  createWorkspaceSet,
  instant,
  localPath,
  modelId,
  providerId,
  streamId,
  workspaceRootId,
} from "../domain/index.ts";
import { createDeterministicProviderAdapter, type ModelRequest } from "../providers/index.ts";
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
  test("fails closed when no provider or executable workspace catalog is attached", async () => {
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
    expect(outcome.kind).toBe("unavailable");
    expect(attachments.transcriptFeed.events().length).toBeGreaterThan(0);
    expect(attachments.controls.resources[0]).toEqual({
      label: "provider",
      value: { kind: "unavailable", reason: "not connected; run falryn provider list" },
    });
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

  test("publishes the selected provider model catalog to OpenTUI controls", async () => {
    const clock = createSystemClock();
    const requests: ModelRequest[] = [];
    const profile = {
      profileId: "demo",
      providerId: providerId.from("demo"),
      adapterKind: "deterministic" as const,
      displayName: "Demo provider",
      endpoint: null,
      credential: null,
      organization: null,
      project: null,
      enabledModels: [modelId.from("deterministic-echo")],
      discovery: "static" as const,
      timeouts: { connectMs: 1_000, requestMs: 10_000 },
    };
    const workspace = createWorkspaceSet([
      {
        rootId: workspaceRootId.from("workspace-shell"),
        name: "workspace",
        path: localPath("/workspace"),
      },
    ]);
    expect(workspace.ok).toBe(true);
    if (!workspace.ok) {
      return;
    }
    const fileSystem = createInMemoryFileSystem({
      nodes: {
        "/workspace": { kind: "directory" },
        "/workspace/real-turn.ts": {
          kind: "file",
          text: "export function runRealTurn() { return 'indexed'; }\n",
        },
      },
    });
    const attachments = await composeProductShellAttachments({
      eventStore: createInMemoryEventStore(),
      clock,
      fileSystem,
      workspaceSet: workspace.value,
      configurationGeneration: configurationGeneration.from(0),
      index: createEphemeralProductIndexPort(),
      provider: {
        kind: "ready",
        adapter: createDeterministicProviderAdapter({
          script: { kind: "text", text: "ok" },
          onRequest: (request) => requests.push(request),
        }),
        session: {
          kind: "ready",
          connection: { profile, account: null, updatedAt: clock.now() },
          auth: {
            profileId: "demo",
            state: "ready",
            consumer: "provider:demo",
            observedAt: instant(0),
            health: null,
            code: null,
            retryable: false,
          },
          catalog: {
            generation: 3,
            provenance: "remote-discovery",
            fetchedAt: instant(0),
            expiresAt: null,
            models: [
              {
                modelId: modelId.from("deterministic-echo"),
                modalities: ["text", "image"],
                tools: true,
                streaming: true,
                reasoning: true,
                contextTokens: 128_000,
                outputTokens: 8_000,
              },
            ],
          },
        },
      },
    });
    expect(attachments?.controls.models).toEqual([
      {
        id: "deterministic-echo",
        title: "deterministic-echo",
        detail: "Demo provider · text+image · tools · reasoning",
      },
    ]);
    expect(attachments?.controls.resources[0]).toEqual({
      label: "provider",
      value: { kind: "known", text: "Demo provider" },
    });
    const pendingSubmission = attachments?.submission.submit(
      snapshotOf("Where is `runRealTurn` defined?", 1),
    );
    const refusedDuringTurn = await attachments?.sessionCreation.create();
    expect(refusedDuringTurn).toEqual({
      ok: false,
      reason: "the current session still has an active turn",
    });
    const submitted = await pendingSubmission;
    if (submitted?.kind === "unavailable") {
      throw new Error(submitted.reason);
    }
    expect(submitted?.kind).toBe("accepted");
    expect(
      attachments?.transcriptFeed
        .events()
        .some((event) => event.kind === "model.attempt.completed"),
    ).toBe(true);
    expect(
      attachments?.transcriptFeed.events().some((event) => event.kind === "turn.completed"),
    ).toBe(true);
    expect(JSON.stringify(requests[0])).toContain("real-turn.ts");
    expect(JSON.stringify(requests[0])).toContain("runRealTurn");
    const firstSession = attachments?.transcriptFeed.events()[0]?.correlation.sessionId;
    const [created, duplicate] = await Promise.all([
      attachments?.sessionCreation.create(),
      attachments?.sessionCreation.create(),
    ]);
    expect(created?.ok).toBe(true);
    expect(duplicate).toEqual(created);
    expect(attachments?.transcriptFeed.events().map((event) => event.kind)).toEqual([
      "session.started",
    ]);
    expect(attachments?.transcriptFeed.events()[0]?.correlation.sessionId).not.toBe(firstSession);
    const second = await attachments?.submission.submit(snapshotOf("run the next session", 2));
    expect(second?.kind).toBe("accepted");
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
    expect(accepted.kind).toBe("unavailable");
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
