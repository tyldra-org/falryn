/**
 * Headless `falryn run` (#708): prompt resolution, product hosting, fail-closed
 * without a provider, and the four output contracts through dispatch.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CONFIGURATION_FILE_NAME } from "../config/index.ts";
import {
  type ArtifactStorePort,
  artifactId,
  configurationGeneration,
  createStaticEnvironment,
  err,
  localPath,
  ok,
  streamId,
} from "../domain/index.ts";
import { createDeterministicProviderAdapter, type ModelRequest } from "../providers/index.ts";
import { resolveCodingPrompt, runCoding } from "./coding-run.ts";
import { parseInvocation } from "./command-tree.ts";
import { dispatch } from "./dispatch.ts";
import type { GlobalOptions } from "./options.ts";
import { openProductArtifactSession } from "./product-artifact-session.ts";
import { CLI_EVENT_STREAM, createServiceProvider } from "./services.ts";
import { createRecordingCliStreams } from "./streams.ts";

const homes: string[] = [];

afterEach(async () => {
  for (const home of homes.splice(0)) {
    await rm(home, { recursive: true, force: true });
  }
});

async function seededHome(): Promise<{
  readonly home: string;
  readonly primary: string;
  readonly environment: ReturnType<typeof createStaticEnvironment>;
}> {
  const home = await mkdtemp(join(tmpdir(), "falryn-run-cli-"));
  homes.push(home);
  const state = join(home, "state");
  const config = join(home, "config");
  const primary = join(home, "primary");
  for (const directory of [home, state, config, primary]) {
    await mkdir(directory, { recursive: true });
    await chmod(directory, 0o700);
  }
  return {
    home,
    primary,
    environment: createStaticEnvironment({
      FALRYN_STATE_DIR: state,
      FALRYN_CONFIG_DIR: config,
    }),
  };
}

function globalsFor(seeded: Awaited<ReturnType<typeof seededHome>>): GlobalOptions {
  return {
    format: "human",
    color: "never",
    quiet: false,
    verbose: false,
    nonInteractive: true,
    workspace: seeded.primary,
    addDirs: [],
    profile: null,
    timeoutMs: null,
    help: false,
    version: false,
  };
}

function providerFor(seeded: Awaited<ReturnType<typeof seededHome>>) {
  return (globals: GlobalOptions) =>
    createServiceProvider(globals, {
      home: localPath(seeded.home),
      platform: "darwin",
      environment: seeded.environment,
      currentDirectory: localPath(seeded.primary),
    });
}

function failingArtifactStore(): ArtifactStorePort {
  const missing = artifactId.from("missing-plan-artifact");
  return {
    ingest: async (request) =>
      err({ kind: "artifact", code: "not-found", artifactId: request.artifactId }),
    get: () => ok(null),
    verifyIntegrity: async () => err({ kind: "artifact", code: "not-found", artifactId: missing }),
    findByDigest: () => ok([]),
    listByInvocation: () => ok([]),
    readRange: async () => err({ kind: "artifact", code: "not-found", artifactId: missing }),
    preview: async () => err({ kind: "artifact", code: "not-found", artifactId: missing }),
    sweep: async () => ({
      examined: 0,
      deleted: 0,
      retained: [],
      failed: 0,
      completeness: "complete",
      effect: "none",
    }),
  };
}

describe("resolveCodingPrompt", () => {
  test("prefers argv text over stdin", async () => {
    const streams = createRecordingCliStreams({ stdin: "from stdin" });
    const resolved = await resolveCodingPrompt(["ship", "it"], streams.input);
    expect(resolved).toEqual({ ok: true, prompt: "ship it", source: "argv" });
  });

  test("reads stdin when argv is empty", async () => {
    const streams = createRecordingCliStreams({ stdin: "  from pipe  " });
    const resolved = await resolveCodingPrompt([], streams.input);
    expect(resolved).toEqual({ ok: true, prompt: "from pipe", source: "stdin" });
  });

  test("fails closed when nothing supplies a prompt", async () => {
    const streams = createRecordingCliStreams({ stdin: null });
    const resolved = await resolveCodingPrompt([], streams.input);
    expect(resolved.ok).toBe(false);
    if (resolved.ok) {
      return;
    }
    expect(resolved.reason).toContain("never prompts");
  });
});

describe("runCoding", () => {
  test("refuses a live turn when the durable product event store cannot open", async () => {
    const home = await mkdtemp(join(tmpdir(), "falryn-run-no-store-"));
    homes.push(home);
    const stateFile = join(home, "state-is-a-file");
    const config = join(home, "config");
    const primary = join(home, "primary");
    await mkdir(config, { recursive: true });
    await mkdir(primary, { recursive: true });
    await writeFile(stateFile, "not a directory", "utf8");
    const seeded = {
      home,
      primary,
      environment: createStaticEnvironment({
        FALRYN_STATE_DIR: stateFile,
        FALRYN_CONFIG_DIR: config,
      }),
    };

    const result = await runCoding(
      providerFor(seeded)(globalsFor(seeded)),
      { promptParts: ["must", "be", "durable"] },
      {
        input: createRecordingCliStreams({ stdin: null }).input,
        globals: globalsFor(seeded),
        providerAdapter: createDeterministicProviderAdapter(),
        identities: {
          sessionId: "session-no-store",
          turnId: "turn-no-store",
          traceId: "trace-no-store",
        },
      },
    );

    expect(result.outcome).toEqual({ kind: "failed", effect: "none" });
    expect(result.payload).toMatchObject({ stage: "compose-failed", eventCount: 0 });
    expect(result.errors[0]?.code).toBe("runtime.durable-event-store-required");
  });

  test("hosts a turn then fails closed without a provider", async () => {
    const seeded = await seededHome();
    const services = providerFor(seeded)(globalsFor(seeded));
    const streams = createRecordingCliStreams({ stdin: null });
    const result = await runCoding(
      services,
      { promptParts: ["add", "tests"] },
      {
        input: streams.input,
        globals: globalsFor(seeded),
        identities: {
          sessionId: "session-run-test",
          turnId: "turn-run-test",
          traceId: "trace-run-test",
        },
      },
    );
    expect(result.command).toBe("run");
    expect(result.outcome.kind).toBe("failed");
    expect(result.payload?.stage).toBe("provider-required");
    expect(result.payload?.prompt).toBe("add tests");
    expect(result.payload?.sessionId).toBe("session-run-test");
    expect(result.payload?.turnId).toBe("turn-run-test");
    expect(result.payload?.eventCount).toBeGreaterThanOrEqual(3);
    expect(result.errors[0]?.code).toBe("provider.adapter-required");
  });

  test("runs a real model attempt when a provider adapter is supplied", async () => {
    const seeded = await seededHome();
    const services = providerFor(seeded)(globalsFor(seeded));
    const streams = createRecordingCliStreams({ stdin: null });
    const result = await runCoding(
      services,
      { promptParts: ["hello"] },
      {
        input: streams.input,
        globals: globalsFor(seeded),
        providerAdapter: createDeterministicProviderAdapter(),
        identities: {
          sessionId: "session-run-hosted",
          turnId: "turn-run-hosted",
          traceId: "trace-run-hosted",
        },
      },
    );
    expect(result.outcome.kind).toBe("completed");
    expect(result.payload?.stage).toBe("attempt-completed");
    expect(result.payload?.response).toBe("ok");
    expect(result.payload?.modelAttempts).toBe(1);
    expect(result.payload?.toolResults).toBe(0);
    expect(result.payload?.disclosedTools).toBeGreaterThan(0);
    expect(result.payload).toMatchObject({
      executionProfile: "agent",
      executionProfileVersion: 1,
      completionCriterion: "implemented-and-verified",
      effectiveModelRole: "default",
      effectiveReasoning: "provider-default",
      policyGeneration: 0,
      planArtifactId: null,
    });
    expect(result.errors).toEqual([]);

    const durable = await openProductArtifactSession(services());
    expect(durable).not.toBeNull();
    if (durable !== null) {
      const replayed = await durable.eventStore.readFrom(
        {
          streamId: streamId.from("live-turn:session-run-hosted"),
          afterSequence: null,
        },
        20,
      );
      expect(replayed.ok).toBe(true);
      if (replayed.ok) {
        expect(replayed.value.map((event) => event.kind)).toContain("model.attempt.completed");
        expect(replayed.value.map((event) => event.kind)).toContain("turn.completed");
        expect(replayed.value.map((event) => event.kind)).toContain("execution.profile.selected");
        const attempt = replayed.value.find((event) => event.kind === "model.attempt.started");
        expect(
          attempt?.kind === "model.attempt.started" ? attempt.payload.binding : null,
        ).toMatchObject({
          executionProfile: {
            id: "agent",
            version: 1,
            completion: "implemented-and-verified",
          },
        });
      }
      await durable.close();
    }
  });

  test("retains Plan output as a durable reviewable artifact", async () => {
    const seeded = await seededHome();
    const services = providerFor(seeded)(globalsFor(seeded));
    const requests: ModelRequest[] = [];
    const adapter = createDeterministicProviderAdapter({
      script: { kind: "text", text: "# Plan\n\n1. Inspect.\n2. Implement.\n" },
      onRequest: (request) => requests.push(request),
    });
    const modelId = adapter.supportedModels[0];
    if (modelId === undefined) {
      throw new Error("deterministic provider has no model");
    }
    const result = await runCoding(
      services,
      { promptParts: ["plan", "the", "change"], mode: "plan" },
      {
        input: createRecordingCliStreams({ stdin: null }).input,
        globals: globalsFor(seeded),
        providerAdapter: adapter,
        providerCatalog: {
          generation: 1,
          provenance: "static-config",
          fetchedAt: null,
          expiresAt: null,
          models: [
            {
              modelId,
              modalities: ["text"],
              tools: true,
              streaming: true,
              reasoning: true,
              contextTokens: 32_000,
              outputTokens: 4_000,
            },
          ],
        },
        identities: {
          sessionId: "session-run-plan",
          turnId: "turn-run-plan",
          traceId: "trace-run-plan",
        },
      },
    );

    expect(result.outcome.kind).toBe("completed");
    expect(result.payload).toMatchObject({
      executionProfile: "plan",
      completionCriterion: "durable-plan",
      effectiveModelRole: "plan",
      effectiveReasoning: "balanced",
      briefVerbosity: "detailed",
    });
    expect(result.payload?.planArtifactId).toBeString();
    expect(JSON.stringify(requests[0])).toContain("[execution-profile id=plan version=1]");
    expect(requests[0]?.tools.every((tool) => tool.name !== "run_shell")).toBe(true);

    const durable = await openProductArtifactSession(services());
    expect(durable).not.toBeNull();
    if (durable !== null && result.payload?.planArtifactId != null) {
      expect(durable.artifacts.get(artifactId.from(result.payload.planArtifactId))).toMatchObject({
        ok: true,
        value: {
          mediaType: "text/markdown",
          origin: "model-output",
          availability: "available",
        },
      });
      await durable.close();
    }
  });

  test("does not complete a Plan turn when its reviewable artifact cannot persist", async () => {
    const seeded = await seededHome();
    const services = providerFor(seeded)(globalsFor(seeded));
    const result = await runCoding(
      services,
      { promptParts: ["plan", "without", "storage"], mode: "plan" },
      {
        input: createRecordingCliStreams({ stdin: null }).input,
        globals: globalsFor(seeded),
        providerAdapter: createDeterministicProviderAdapter({
          script: { kind: "text", text: "# Plan\n\n1. Inspect.\n" },
        }),
        artifacts: failingArtifactStore(),
        identities: {
          sessionId: "session-run-plan-artifact-failure",
          turnId: "turn-run-plan-artifact-failure",
          traceId: "trace-run-plan-artifact-failure",
        },
      },
    );

    expect(result.outcome).toMatchObject({ kind: "failed", effect: "none" });
    expect(result.payload).toMatchObject({
      stage: "attempt-failed",
      executionProfile: "plan",
      completionCriterion: "durable-plan",
      planArtifactId: null,
    });

    const durable = await openProductArtifactSession(services());
    expect(durable).not.toBeNull();
    if (durable !== null) {
      const replayed = await durable.eventStore.readFrom(
        {
          streamId: streamId.from("live-turn:session-run-plan-artifact-failure"),
          afterSequence: null,
        },
        20,
      );
      expect(replayed.ok).toBe(true);
      if (replayed.ok) {
        const terminal = replayed.value.find((event) => event.kind === "turn.completed");
        expect(terminal?.kind === "turn.completed" ? terminal.payload.outcome : null).toEqual({
          kind: "failed",
          effect: "none",
        });
      }
      await durable.close();
    }
  });

  test("Ask denies a consequential tool proposal at the live gateway", async () => {
    const seeded = await seededHome();
    const services = providerFor(seeded)(globalsFor(seeded));
    let providerRequests = 0;
    const result = await runCoding(
      services,
      { promptParts: ["explain", "only"], mode: "ask" },
      {
        input: createRecordingCliStreams({ stdin: null }).input,
        globals: globalsFor(seeded),
        providerAdapter: createDeterministicProviderAdapter({
          onRequest: () => {
            providerRequests += 1;
          },
          script: {
            kind: "tool",
            toolCallId: "call-ask-bypass",
            name: "run_shell",
            argumentFragments: ['{"command":"printf bypass"}'],
          },
        }),
        identities: {
          sessionId: "session-run-ask-deny",
          turnId: "turn-run-ask-deny",
          traceId: "trace-run-ask-deny",
        },
      },
    );

    expect(result.outcome).toMatchObject({ kind: "failed", effect: "none" });
    expect(result.payload).toMatchObject({
      stage: "attempt-failed",
      executionProfile: "ask",
      completionCriterion: "answer",
      toolResults: 1,
    });
    expect(providerRequests).toBe(1);
  });

  test("Debug discloses bounded process, LSP, and DAP probes without edit tools", async () => {
    const seeded = await seededHome();
    const services = providerFor(seeded)(globalsFor(seeded));
    const requests: ModelRequest[] = [];
    const adapter = createDeterministicProviderAdapter({
      script: { kind: "text", text: "Diagnosis: inspect the failing frame." },
      onRequest: (request) => requests.push(request),
    });
    const modelId = adapter.supportedModels[0];
    if (modelId === undefined) {
      throw new Error("deterministic provider has no model");
    }
    const result = await runCoding(
      services,
      { promptParts: ["diagnose", "the", "failure"], mode: "debug" },
      {
        input: createRecordingCliStreams({ stdin: null }).input,
        globals: globalsFor(seeded),
        providerAdapter: adapter,
        providerCatalog: {
          generation: 1,
          provenance: "static-config",
          fetchedAt: null,
          expiresAt: null,
          models: [
            {
              modelId,
              modalities: ["text"],
              tools: true,
              streaming: true,
              reasoning: true,
              contextTokens: 32_000,
              outputTokens: 4_000,
            },
          ],
        },
        identities: {
          sessionId: "session-run-debug",
          turnId: "turn-run-debug",
          traceId: "trace-run-debug",
        },
      },
    );

    expect(result.payload).toMatchObject({
      stage: "attempt-completed",
      executionProfile: "debug",
      completionCriterion: "diagnosis",
      effectiveModelRole: "default",
      effectiveReasoning: "balanced",
    });
    const names = requests[0]?.tools.map((tool) => tool.name) ?? [];
    expect(names).toContain("run_process");
    expect(names).toContain("lsp_diagnostics");
    expect(names).toContain("dap_stack_trace");
    expect(names).toContain("dap_disconnect");
    expect(names).not.toContain("apply_patch");
    expect(names).not.toContain("lsp_rename");
  });

  test("sends current durable index evidence in the first provider request", async () => {
    const seeded = await seededHome();
    await writeFile(
      join(seeded.primary, "compose-turn.ts"),
      "export function composeTurn() { return 'live'; }\n",
      "utf8",
    );
    const services = providerFor(seeded)(globalsFor(seeded));
    const requests: ModelRequest[] = [];
    const result = await runCoding(
      services,
      { promptParts: ["Where", "is", "`composeTurn`", "defined?"] },
      {
        input: createRecordingCliStreams({ stdin: null }).input,
        globals: globalsFor(seeded),
        providerAdapter: createDeterministicProviderAdapter({
          onRequest: (request) => requests.push(request),
        }),
        identities: {
          sessionId: "session-run-index",
          turnId: "turn-run-index",
          traceId: "trace-run-index",
        },
      },
    );

    expect(result.outcome.kind).toBe("completed");
    expect(result.payload?.contextStatus).toBe("ready");
    expect(result.payload?.contextGeneration).toBeString();
    expect(result.payload?.contextPackItems).toBeGreaterThan(0);
    const firstPayload = JSON.stringify(requests[0]);
    expect(firstPayload).toContain("compose-turn.ts");
    expect(firstPayload).toContain("composeTurn");
    expect(firstPayload).toContain("citation:");
  });

  test("recalls durable memory before the next prompt and admits only completed turns", async () => {
    const seeded = await seededHome();
    const services = providerFor(seeded)(globalsFor(seeded));
    const first = await runCoding(
      services,
      { promptParts: ["Prefer", "main", "as", "the", "default", "branch."] },
      {
        input: createRecordingCliStreams({ stdin: null }).input,
        globals: globalsFor(seeded),
        providerAdapter: createDeterministicProviderAdapter(),
        identities: {
          sessionId: "session-run-memory-first",
          turnId: "turn-run-memory-first",
          traceId: "trace-run-memory-first",
        },
      },
    );
    expect(first.payload?.memoryAdmission).toBe("admitted");

    const requests: ModelRequest[] = [];
    const second = await runCoding(
      services,
      { promptParts: ["Use", "the", "default", "branch", "again."] },
      {
        input: createRecordingCliStreams({ stdin: null }).input,
        globals: globalsFor(seeded),
        providerAdapter: createDeterministicProviderAdapter({
          onRequest: (request) => requests.push(request),
        }),
        identities: {
          sessionId: "session-run-memory-second",
          turnId: "turn-run-memory-second",
          traceId: "trace-run-memory-second",
        },
      },
    );

    expect(second.payload?.recalledMemories).toBeGreaterThan(0);
    expect(JSON.stringify(requests[0])).toContain("Prefer main as the default branch.");
  });

  test("reopens the durable store for a second session without lifecycle identity collisions", async () => {
    const seeded = await seededHome();
    const services = providerFor(seeded)(globalsFor(seeded));
    const adapter = createDeterministicProviderAdapter();

    for (const suffix of ["first", "second"] as const) {
      const result = await runCoding(
        services,
        { promptParts: [suffix] },
        {
          input: createRecordingCliStreams({ stdin: null }).input,
          globals: globalsFor(seeded),
          providerAdapter: adapter,
          identities: {
            sessionId: `session-restart-${suffix}`,
            turnId: `turn-restart-${suffix}`,
            traceId: `trace-restart-${suffix}`,
          },
        },
      );
      expect(result.outcome.kind).toBe("completed");
      expect(result.payload?.stage).toBe("attempt-completed");
    }
  });

  test("restores committed Loom manifests and exact artifacts after restart", async () => {
    const seeded = await seededHome();
    const services = providerFor(seeded)(globalsFor(seeded));
    const first = await openProductArtifactSession(services());
    expect(first).not.toBeNull();
    if (first === null) {
      return;
    }
    const ingested = await first.loom.ingest({
      id: "loom-restart-manifest",
      workspaceId: "workspace-restart-loom",
      sessionId: "session-restart-loom",
      members: [
        {
          artifactId: "artifact-restart-loom",
          bytes: new TextEncoder().encode("durable loom payload"),
          mediaType: "text/plain",
          sensitivity: "user-content",
          summary: "src/restart.txt",
        },
      ],
    });
    expect(ingested.ok).toBe(true);
    await first.close();

    const second = await openProductArtifactSession(services());
    expect(second).not.toBeNull();
    if (second === null) {
      return;
    }
    const recovered = await second.loom.retrieve({
      id: "evidence-restart-loom",
      manifestId: "loom-restart-manifest",
      expectedWorkspaceId: "workspace-restart-loom",
      expectedSessionId: "session-restart-loom",
      projection: { kind: "exact", member: "artifact-restart-loom" },
    });
    expect(recovered.ok && recovered.value.text).toBe("durable loom payload");
    await second.close();
  });

  test("continues prompt to tool result to final text through the product gateway", async () => {
    const seeded = await seededHome();
    await writeFile(join(seeded.primary, "hello.ts"), "export const answer = 42;\n", "utf8");
    const services = providerFor(seeded)(globalsFor(seeded));
    const requests: ModelRequest[] = [];
    const adapter = createDeterministicProviderAdapter({
      onRequest: (request) => requests.push(request),
      script: (_request, index) =>
        index === 0
          ? {
              kind: "tool",
              toolCallId: "call-list",
              name: "list_dir",
              argumentFragments: ['{"path":"."}'],
            }
          : { kind: "text", text: "I found hello.ts.", finishReason: "stop" },
    });

    const result = await runCoding(
      services,
      { promptParts: ["inspect", "the", "workspace"] },
      {
        input: createRecordingCliStreams({ stdin: null }).input,
        globals: globalsFor(seeded),
        providerAdapter: adapter,
        identities: {
          sessionId: "session-run-tool",
          turnId: "turn-run-tool",
          traceId: "trace-run-tool",
        },
      },
    );

    expect(result.outcome.kind).toBe("completed");
    expect(result.payload).toMatchObject({
      stage: "attempt-completed",
      response: "I found hello.ts.",
      modelAttempts: 1,
      toolResults: 1,
    });
    expect(requests).toHaveLength(2);
    expect(requests[0]?.tools.length).toBeGreaterThan(0);
    expect(requests[0]?.tools.length).toBeLessThanOrEqual(16);
    expect(
      requests[1]?.messages.some(
        (message) => message.role === "assistant" && message.toolCalls?.[0]?.name === "list_dir",
      ),
    ).toBe(true);
    expect(
      requests[1]?.messages.some(
        (message) => message.role === "tool" && message.toolCallId === "call-list",
      ),
    ).toBe(true);
  });

  test("does not retry a provider failure after a tool proposal was executed", async () => {
    const seeded = await seededHome();
    const services = providerFor(seeded)(globalsFor(seeded));
    let providerRequests = 0;
    const adapter = createDeterministicProviderAdapter({
      onRequest: () => {
        providerRequests += 1;
      },
      script: (_request, index) =>
        index === 0
          ? {
              kind: "tool",
              toolCallId: "call-list-once",
              name: "list_dir",
              argumentFragments: ['{"path":"."}'],
            }
          : {
              kind: "error",
              failureKind: "server-failure",
              message: "provider disconnected after the tool result",
              retryable: true,
            },
    });

    const result = await runCoding(
      services,
      { promptParts: ["inspect", "once"] },
      {
        input: createRecordingCliStreams({ stdin: null }).input,
        globals: globalsFor(seeded),
        providerAdapter: adapter,
        identities: {
          sessionId: "session-run-no-repeat",
          turnId: "turn-run-no-repeat",
          traceId: "trace-run-no-repeat",
        },
      },
    );

    expect(result.outcome.kind).toBe("failed");
    expect(result.payload).toMatchObject({
      stage: "attempt-failed",
      modelAttempts: 1,
      toolResults: 1,
      memoryAdmission: "skipped",
    });
    expect(providerRequests).toBe(2);
  });

  test("recovers a targeted Loom range through the same read_file tool", async () => {
    const seeded = await seededHome();
    const large = `${"a".repeat(5_000)}needle${"z".repeat(5_000)}`;
    await writeFile(join(seeded.primary, "large.txt"), large, "utf8");
    const services = providerFor(seeded)(globalsFor(seeded));
    const requests: ModelRequest[] = [];
    const adapter = createDeterministicProviderAdapter({
      onRequest: (request) => requests.push(request),
      script: (request, index) => {
        if (index === 0) {
          return {
            kind: "tool",
            toolCallId: "call-read",
            name: "read_file",
            argumentFragments: [
              JSON.stringify({
                path: "large.txt",
                limits: {
                  maxFileBytes: 16,
                  maxExpansionBytes: 20_000,
                  maxExpansionChunkBytes: 1_024,
                },
              }),
            ],
          };
        }
        if (index === 1) {
          const toolMessage = request.messages.findLast(
            (message) => message.role === "tool" && message.toolCallId === "call-read",
          );
          const text = toolMessage?.parts.find((part) => part.kind === "text")?.text ?? "{}";
          const result = JSON.parse(text) as {
            output?: { value?: { loomRecovery?: Readonly<Record<string, unknown>> } };
          };
          const recovery = result.output?.value?.loomRecovery;
          if (recovery === undefined) {
            throw new Error("Loom recovery handle was not projected to the model");
          }
          return {
            kind: "tool",
            toolCallId: "call-recover",
            name: "read_file",
            argumentFragments: [
              JSON.stringify({
                recovery,
                projection: {
                  kind: "search-hits",
                  query: "needle",
                  maxHits: 1,
                  contextBytes: 4,
                  maxBytes: 64,
                },
              }),
            ],
          };
        }
        return { kind: "text", text: "Recovered needle.", finishReason: "stop" };
      },
    });

    const result = await runCoding(
      services,
      { promptParts: ["find", "needle"] },
      {
        input: createRecordingCliStreams({ stdin: null }).input,
        globals: globalsFor(seeded),
        providerAdapter: adapter,
        identities: {
          sessionId: "session-run-loom",
          turnId: "turn-run-loom",
          traceId: "trace-run-loom",
        },
      },
    );

    expect(result.payload).toMatchObject({
      stage: "attempt-completed",
      response: "Recovered needle.",
      toolResults: 2,
    });
    expect(requests).toHaveLength(3);
    const providerTranscript = JSON.stringify(requests);
    expect(providerTranscript).toContain("aaaaneedlezzzz");
    expect(providerTranscript).not.toContain(large);
  });

  test("runs an observation through the selected credential-backed provider (#798)", async () => {
    const home = await mkdtemp(join(tmpdir(), "falryn-run-cred-"));
    homes.push(home);
    const state = join(home, "state");
    const config = join(home, "config");
    const primary = join(home, "primary");
    for (const directory of [home, state, config, primary]) {
      await mkdir(directory, { recursive: true });
      await chmod(directory, 0o700);
    }
    const seeded = {
      home,
      primary,
      environment: createStaticEnvironment({
        FALRYN_STATE_DIR: state,
        FALRYN_CONFIG_DIR: config,
        FALRYN_OPENAI_API_KEY: "sk-test-not-a-real-key",
      }),
    };
    const services = (globals: GlobalOptions) =>
      createServiceProvider(globals, {
        home: localPath(seeded.home),
        platform: "darwin",
        environment: seeded.environment,
        currentDirectory: localPath(seeded.primary),
      });
    const streams = createRecordingCliStreams({ stdin: null });
    const providerBodies: unknown[] = [];
    let providerRequest = 0;
    const result = await runCoding(
      services(globalsFor(seeded)),
      { promptParts: ["with", "key"] },
      {
        input: streams.input,
        globals: globalsFor(seeded),
        openaiFetch: async (_input, init) => {
          providerBodies.push(JSON.parse(String(init.body)));
          const current = providerRequest;
          providerRequest += 1;
          const chunks =
            current === 0
              ? [
                  'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call-list-live","function":{"name":"list_dir","arguments":"{\\"path\\":\\".\\"}"}}]}}]}',
                  'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}',
                  "",
                ]
              : [
                  'data: {"choices":[{"delta":{"content":"connected with tools"}}]}',
                  'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}',
                  "",
                ];
          return new Response(chunks.join("\n\n"), {
            status: 200,
            headers: { "content-type": "text/event-stream" },
          });
        },
        identities: {
          sessionId: "session-run-cred",
          turnId: "turn-run-cred",
          traceId: "trace-run-cred",
        },
      },
    );
    expect(result.outcome.kind).toBe("completed");
    expect(result.payload?.stage).toBe("attempt-completed");
    expect(result.payload?.response).toBe("connected with tools");
    expect(result.payload?.toolResults).toBe(1);
    expect(providerBodies).toHaveLength(2);
    const continuedBody = providerBodies[1] as {
      readonly messages?: readonly { readonly role?: string; readonly tool_call_id?: string }[];
    };
    expect(
      continuedBody.messages?.some(
        (message) => message.role === "tool" && message.tool_call_id === "call-list-live",
      ),
    ).toBe(true);
    expect(result.errors).toEqual([]);
  });

  test("loads configuration through the loader before hosting (#728)", async () => {
    const seeded = await seededHome();
    const services = providerFor(seeded)(globalsFor(seeded));
    const graph = services();
    const configFile = join(String(graph.configurationRoot), CONFIGURATION_FILE_NAME);
    await writeFile(
      configFile,
      JSON.stringify({ schemaVersion: 1, diagnostics: { level: "warn" } }),
      "utf8",
    );
    const streams = createRecordingCliStreams({ stdin: null });
    await runCoding(
      services,
      { promptParts: ["observe loader"] },
      {
        input: streams.input,
        globals: globalsFor(seeded),
        identities: {
          sessionId: "session-run-config",
          turnId: "turn-run-config",
          traceId: "trace-run-config",
        },
      },
    );
    expect(graph.loader.current()?.generation).toBe(configurationGeneration.from(0));
    expect(graph.loader.current()?.values["diagnostics.level"]).toBe("warn");
    const read = await graph.eventStore.readFrom(
      { streamId: streamId.from(CLI_EVENT_STREAM), afterSequence: null },
      20,
    );
    expect(read.ok).toBe(true);
    if (!read.ok) {
      return;
    }
    expect(read.value.some((event) => event.kind === "configuration.generation.changed")).toBe(
      true,
    );
  });
});

describe("falryn run through dispatch", () => {
  test("parses prompt fragments", async () => {
    const invocation = await parseInvocation(["run", "fix", "me"]);
    expect(invocation.kind).toBe("run");
    if (invocation.kind !== "run") {
      return;
    }
    expect(invocation.command).toBe("run");
    expect(invocation.runArgs).toEqual({ promptParts: ["fix", "me"] });
  });

  test("parses an explicit execution mode", async () => {
    const invocation = await parseInvocation(["run", "--mode", "debug", "inspect", "it"]);
    expect(invocation.kind).toBe("run");
    if (invocation.kind === "run") {
      expect(invocation.runArgs).toEqual({
        promptParts: ["inspect", "it"],
        mode: "debug",
      });
    }
  });

  test("projects provider-required through json", async () => {
    const seeded = await seededHome();
    const streams = createRecordingCliStreams({ stdin: null });
    const code = await dispatch({
      argv: ["--format", "json", "--non-interactive", "--workspace", seeded.primary, "run", "hi"],
      streams,
      services: providerFor(seeded),
    });
    expect(code).not.toBe(0);
    const body = JSON.parse(streams.resultWrites().join("")) as {
      command: string;
      payload: { stage: string; prompt: string };
      outcome: { kind: string };
    };
    expect(body.command).toBe("run");
    expect(body.payload.stage).toBe("provider-required");
    expect(body.payload.prompt).toBe("hi");
    expect(body.outcome.kind).toBe("failed");
  });

  test("jsonl emits lifecycle events then a terminal result", async () => {
    const seeded = await seededHome();
    const streams = createRecordingCliStreams({ stdin: null });
    await dispatch({
      argv: ["--format", "jsonl", "--workspace", seeded.primary, "run", "jsonl"],
      streams,
      services: providerFor(seeded),
    });
    const lines = streams
      .resultWrites()
      .join("")
      .split("\n")
      .filter((line) => line.length > 0)
      .map(
        (line) =>
          JSON.parse(line) as {
            kind: string;
            terminal?: boolean;
            event?: { kind?: string };
          },
      );
    expect(lines.length).toBeGreaterThan(1);
    expect(lines.some((line) => line.kind === "event")).toBe(true);
    expect(lines.some((line) => line.event?.kind === "session.started")).toBe(true);
    expect(lines.some((line) => line.event?.kind === "turn.completed")).toBe(true);
    expect(lines.at(-1)?.kind).toBe("result");
    expect(lines.at(-1)?.terminal).toBe(true);
  });
});
