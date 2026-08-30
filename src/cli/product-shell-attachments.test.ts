/**
 * Default TUI product attachments (#752 / #728).
 */

import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
import {
  createLiveTurnMatrixFixture,
  LIVE_TURN_MATRIX_CONFIRMATION,
  LIVE_TURN_MATRIX_CONTEXT,
  LIVE_TURN_MATRIX_EVENT_KINDS,
  LIVE_TURN_MATRIX_PROMPT,
  LIVE_TURN_MATRIX_STDOUT,
  LIVE_TURN_MATRIX_TOOL_CALL_ID,
  liveTurnMatrixArtifactId,
  liveTurnMatrixContinuation,
} from "./live-turn-matrix.test-support.ts";
import type { GlobalOptions } from "./options.ts";
import { openProductArtifactSession } from "./product-artifact-session.ts";
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

const homes: string[] = [];

afterEach(async () => {
  for (const home of homes.splice(0)) {
    await rm(home, { recursive: true, force: true });
  }
});

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
    const defaultModel = modelId.from("deterministic-echo");
    const selectedModel = modelId.from("deterministic-selected");
    const profile = {
      profileId: "demo",
      providerId: providerId.from("demo"),
      adapterKind: "deterministic" as const,
      displayName: "Demo provider",
      endpoint: null,
      credential: null,
      organization: null,
      project: null,
      enabledModels: [defaultModel, selectedModel],
      transportCompatibility: null,
      modelCapabilities: [],
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
          supportedModels: [defaultModel, selectedModel],
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
                schemaVersion: 1,
                modelId: defaultModel,
                displayName: null,
                inputModalities: ["text", "image"],
                outputModalities: ["text"],
                tools: "supported",
                structuredOutput: "supported",
                streaming: "supported",
                reasoning: "supported",
                reasoningControls: ["balanced"],
                completeness: "complete",
                availability: "available",
                provenance: ["profile-declaration"],
                contextTokens: 128_000,
                outputTokens: 8_000,
              },
              {
                schemaVersion: 1,
                modelId: selectedModel,
                displayName: "Selected model",
                inputModalities: ["text"],
                outputModalities: ["text"],
                tools: "supported",
                structuredOutput: "supported",
                streaming: "supported",
                reasoning: "supported",
                reasoningControls: ["balanced"],
                completeness: "complete",
                availability: "available",
                provenance: ["profile-declaration"],
                contextTokens: 128_000,
                outputTokens: 8_000,
              },
            ],
          },
        },
      },
    });
    expect(attachments?.controls.models.map((model) => model.id)).toEqual([
      "deterministic-echo",
      "deterministic-selected",
    ]);
    expect(attachments?.controls.profiles.map((profile) => profile.id)).toEqual([
      "ask",
      "plan",
      "debug",
      "agent",
    ]);
    expect(attachments?.controls.resources[0]).toEqual({
      label: "provider",
      value: { kind: "known", text: "Demo provider" },
    });
    expect(await attachments?.submission.modelSelection.select(selectedModel)).toEqual({
      ok: true,
      modelId: selectedModel,
      changed: true,
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
    expect(requests[0]?.modelId).toBe(selectedModel);
    const firstSession = attachments?.transcriptFeed.events()[0]?.correlation.sessionId;
    const [created, duplicate] = await Promise.all([
      attachments?.sessionCreation.create(),
      attachments?.sessionCreation.create(),
    ]);
    expect(created?.ok).toBe(true);
    expect(duplicate).toEqual(created);
    expect(attachments?.transcriptFeed.events().map((event) => event.kind)).toEqual([
      "session.started",
      "execution.profile.selected",
    ]);
    expect(attachments?.transcriptFeed.events()[0]?.correlation.sessionId).not.toBe(firstSession);
    const second = await attachments?.submission.submit(snapshotOf("run the next session", 2));
    expect(second?.kind).toBe("accepted");
    expect(requests.at(-1)?.modelId).toBe(selectedModel);
  });

  test("runs and replays the shared durable live-turn matrix through OpenTUI", async () => {
    const home = await mkdtemp(join(tmpdir(), "falryn-tui-matrix-"));
    homes.push(home);
    const state = join(home, "state");
    const config = join(home, "config");
    const primary = join(home, "primary");
    for (const directory of [home, state, config, primary]) {
      await mkdir(directory, { recursive: true });
      await chmod(directory, 0o700);
    }
    const environment = createStaticEnvironment({
      FALRYN_STATE_DIR: state,
      FALRYN_CONFIG_DIR: config,
    });
    const services = createServiceProvider(GLOBALS, {
      home: localPath(home),
      platform: "darwin",
      environment,
      currentDirectory: localPath(primary),
    })();
    const durable = await openProductArtifactSession(services);
    expect(durable).not.toBeNull();
    if (durable === null) {
      return;
    }
    const workspace = createWorkspaceSet([
      {
        rootId: workspaceRootId.from("workspace-823-tui"),
        name: "workspace",
        path: localPath(primary),
      },
    ]);
    expect(workspace.ok).toBe(true);
    if (!workspace.ok) {
      await durable.close();
      return;
    }
    const fileSystem = createInMemoryFileSystem({
      nodes: {
        [primary]: { kind: "directory" },
        [`${primary}/matrix.ts`]: {
          kind: "file",
          text: LIVE_TURN_MATRIX_CONTEXT,
        },
      },
    });
    const fixture = createLiveTurnMatrixFixture(durable.artifacts, "cap-823-tui");
    const model = fixture.provider.supportedModels[0];
    if (model === undefined) {
      await durable.close();
      throw new Error("deterministic provider has no model");
    }
    const profile = {
      profileId: "matrix",
      providerId: fixture.provider.identity.providerId,
      adapterKind: "deterministic" as const,
      displayName: "Live-turn matrix provider",
      endpoint: null,
      credential: null,
      organization: null,
      project: null,
      enabledModels: [model],
      transportCompatibility: null,
      modelCapabilities: [],
      discovery: "static" as const,
      timeouts: { connectMs: 1_000, requestMs: 10_000 },
    };
    const attachments = await composeProductShellAttachments({
      eventStore: durable.eventStore,
      clock: services.clock,
      fileSystem,
      workspaceSet: workspace.value,
      configurationGeneration: configurationGeneration.from(0),
      artifacts: durable.artifacts,
      loom: durable.loom,
      scratch: durable.scratch,
      memoryRecords: durable.memoryRecords,
      index: createEphemeralProductIndexPort(),
      processCapture: fixture.processCapture,
      toolConfirmation: LIVE_TURN_MATRIX_CONFIRMATION,
      provider: {
        kind: "ready",
        adapter: fixture.provider,
        session: {
          kind: "ready",
          connection: { profile, account: null, updatedAt: services.clock.now() },
          auth: {
            profileId: "matrix",
            state: "ready",
            consumer: "provider:matrix",
            observedAt: instant(0),
            health: null,
            code: null,
            retryable: false,
          },
          catalog: {
            generation: 823,
            provenance: "static-config",
            fetchedAt: instant(0),
            expiresAt: null,
            models: [
              {
                schemaVersion: 1,
                modelId: model,
                displayName: null,
                inputModalities: ["text"],
                outputModalities: ["text"],
                tools: "supported",
                structuredOutput: "supported",
                streaming: "supported",
                reasoning: "supported",
                reasoningControls: ["balanced"],
                completeness: "complete",
                availability: "available",
                provenance: ["profile-declaration"],
                contextTokens: 128_000,
                outputTokens: 8_000,
              },
            ],
          },
        },
      },
    });
    expect(attachments).not.toBeNull();
    if (attachments === null) {
      await durable.close();
      return;
    }

    const submitted = await attachments.submission.submit(snapshotOf(LIVE_TURN_MATRIX_PROMPT, 1));
    if (submitted.kind === "unavailable") {
      throw new Error(submitted.reason);
    }
    expect(submitted.kind).toBe("accepted");
    expect(fixture.captures).toBe(1);
    expect(fixture.requests).toHaveLength(2);
    expect(fixture.requests[0]?.tools.map((tool) => tool.name)).toContain("scratch_write");
    expect(JSON.stringify(fixture.requests[0])).toContain(LIVE_TURN_MATRIX_CONTEXT.trim());
    const continuation = liveTurnMatrixContinuation(fixture.requests);
    expect(continuation.assistant.toolCalls?.[0]).toMatchObject({
      toolCallId: LIVE_TURN_MATRIX_TOOL_CALL_ID,
      name: "run_process",
    });
    expect(continuation.tool.toolCallId).toBe(LIVE_TURN_MATRIX_TOOL_CALL_ID);
    expect(continuation.toolOutput.output?.value).toMatchObject({
      captureId: "cap-823-tui",
      projection: { kind: "hush", reducer: { id: "files.ls" } },
      stdout: { text: null },
    });
    expect(continuation.toolOutput.output?.value?.stdout?.recovery).not.toBeNull();
    expect(JSON.stringify(fixture.requests[1])).not.toContain(LIVE_TURN_MATRIX_STDOUT);
    expect(new TextEncoder().encode(continuation.serializedResult).byteLength).toBeLessThan(
      new TextEncoder().encode(LIVE_TURN_MATRIX_STDOUT).byteLength,
    );
    const exactArtifact = liveTurnMatrixArtifactId(
      continuation.toolOutput.output?.value?.stdout?.recovery,
    );
    expect(attachments.transcriptFeed.events().map((event) => event.kind)).toEqual(
      LIVE_TURN_MATRIX_EVENT_KINDS,
    );
    expect(
      attachments.transcriptFeed.events().find((event) => event.kind === "turn.completed")?.payload,
    ).toMatchObject({ outcome: { kind: "completed" } });

    const matrixSessionId = attachments.transcriptFeed.events()[0]?.correlation.sessionId;
    expect(matrixSessionId).toBeDefined();

    const scratchRequests: ModelRequest[] = [];
    const scratchProvider = createDeterministicProviderAdapter({
      onRequest: (request) => scratchRequests.push(request),
      script: (_request, index) =>
        index === 0
          ? {
              kind: "tool",
              toolCallId: "call-tui-scratch",
              name: "scratch_write",
              argumentFragments: [
                '{"name":"tui-notes.md","text":"TUI scratch draft\\n","mediaType":"text/markdown"}',
              ],
            }
          : { kind: "text", text: "Scratch retained.", finishReason: "stop" },
    });
    const scratchAttachments = await composeProductShellAttachments({
      eventStore: durable.eventStore,
      clock: services.clock,
      fileSystem,
      workspaceSet: workspace.value,
      configurationGeneration: configurationGeneration.from(0),
      artifacts: durable.artifacts,
      loom: durable.loom,
      scratch: durable.scratch,
      memoryRecords: durable.memoryRecords,
      index: createEphemeralProductIndexPort(),
      toolConfirmation: LIVE_TURN_MATRIX_CONFIRMATION,
      provider: {
        kind: "ready",
        adapter: scratchProvider,
        session: {
          kind: "ready",
          connection: { profile, account: null, updatedAt: services.clock.now() },
          auth: {
            profileId: "matrix",
            state: "ready",
            consumer: "provider:matrix",
            observedAt: instant(0),
            health: null,
            code: null,
            retryable: false,
          },
          catalog: {
            generation: 823,
            provenance: "static-config",
            fetchedAt: instant(0),
            expiresAt: null,
            models: [
              {
                schemaVersion: 1,
                modelId: model,
                displayName: null,
                inputModalities: ["text"],
                outputModalities: ["text"],
                tools: "supported",
                structuredOutput: "supported",
                streaming: "supported",
                reasoning: "supported",
                reasoningControls: ["balanced"],
                completeness: "complete",
                availability: "available",
                provenance: ["profile-declaration"],
                contextTokens: 128_000,
                outputTokens: 8_000,
              },
            ],
          },
        },
      },
    });
    expect(scratchAttachments).not.toBeNull();
    if (scratchAttachments === null) {
      await durable.close();
      return;
    }
    const scratchSubmitted = await scratchAttachments.submission.submit(
      snapshotOf("Draft temporary notes", 1),
    );
    expect(scratchSubmitted.kind).toBe("accepted");
    expect(scratchRequests).toHaveLength(2);
    expect(JSON.stringify(scratchRequests[1])).toContain("scratch://session/");
    const scratchSessionId = scratchAttachments.transcriptFeed.events()[0]?.correlation.sessionId;
    expect(scratchSessionId).toBeDefined();
    await durable.close();

    const reopened = await openProductArtifactSession(services);
    expect(reopened).not.toBeNull();
    if (reopened === null || matrixSessionId === undefined || scratchSessionId === undefined) {
      return;
    }
    const replayed = await reopened.eventStore.readFrom(
      { streamId: streamId.from(`live-turn:${String(matrixSessionId)}`), afterSequence: null },
      100,
    );
    expect(replayed.ok).toBe(true);
    if (replayed.ok) {
      expect(replayed.value.map((event) => event.kind)).toEqual(LIVE_TURN_MATRIX_EVENT_KINDS);
      const completed = replayed.value.find(
        (event) => event.kind === "capability.invocation.completed",
      );
      if (completed?.kind === "capability.invocation.completed") {
        const artifacts = reopened.artifacts.listByInvocation(completed.invocationId, 10);
        expect(artifacts.ok).toBe(true);
        if (artifacts.ok) {
          expect(artifacts.value).toHaveLength(1);
          expect(artifacts.value[0]).toMatchObject({
            availability: "available",
            byteLength: new TextEncoder().encode(LIVE_TURN_MATRIX_STDOUT).byteLength,
          });
        }
      }
    }
    const exactBytes = new TextEncoder().encode(LIVE_TURN_MATRIX_STDOUT);
    const exact = await reopened.artifacts.readRange(exactArtifact, 0, exactBytes.byteLength);
    expect(exact.ok).toBe(true);
    if (exact.ok) {
      expect(exact.value.bytes).toEqual(exactBytes);
      expect(exact.value.endOfArtifact).toBe(true);
    }
    expect(
      await reopened.scratch.read(
        scratchSessionId,
        `scratch://session/${encodeURIComponent(String(scratchSessionId))}/tui-notes.md`,
      ),
    ).toMatchObject({
      ok: true,
      value: { revision: 1, text: "TUI scratch draft\n" },
    });
    await reopened.close();
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
