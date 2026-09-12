import { languageStartupFixture } from "./language-startup.test-support.ts";
/**
 * Headless `falryn run` (#708): prompt resolution, product hosting, fail-closed
 * without a provider, and the four output contracts through dispatch.
 */

import { afterEach, describe, expect, test } from "bun:test";
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sealedAgentResultSchema } from "../../application/orchestration/delegation-contract.ts";
import {
  MAX_DEFERRED_PRODUCT_TOOLS,
  MAX_DISCLOSED_PRODUCT_TOOLS,
} from "../../application/tools/product-tool-disclosure.ts";
import { CONFIGURATION_FILE_NAME } from "../../config/index.ts";
import { type ArtifactStorePort, artifactId } from "../../domain/artifacts/index.ts";
import {
  configurationGeneration,
  createStaticEnvironment,
  err,
  ok,
  sessionId,
  streamId,
} from "../../domain/foundation/index.ts";
import { localPath } from "../../domain/workspace/index.ts";
import { createDeterministicProviderAdapter, type ModelRequest } from "../../providers/index.ts";
import { parseInvocation } from "../command-tree.ts";
import { dispatch } from "../dispatch.ts";
import {
  createLiveTurnMatrixFixture,
  LIVE_TURN_MATRIX_CONFIRMATION,
  LIVE_TURN_MATRIX_CONTEXT,
  LIVE_TURN_MATRIX_EVENT_KINDS,
  LIVE_TURN_MATRIX_FINAL_TEXT,
  LIVE_TURN_MATRIX_PROMPT,
  LIVE_TURN_MATRIX_STDOUT,
  LIVE_TURN_MATRIX_TOOL_CALL_ID,
  liveTurnMatrixArtifactId,
  liveTurnMatrixContinuation,
} from "../live-turn-matrix.test-support.ts";
import type { GlobalOptions } from "../options.ts";
import { createRecordingCliStreams } from "../output/streams.ts";
import { resolveCodingPrompt, runCoding } from "./coding-run.ts";
import { openProductArtifactSession } from "./product-artifact-session.ts";
import { CLI_EVENT_STREAM, createServiceProvider } from "./services.ts";

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
    const requests: ModelRequest[] = [];
    const result = await runCoding(
      services,
      { promptParts: ["Implement and verify this with cited sources"], brief: "auto" },
      {
        input: streams.input,
        globals: globalsFor(seeded),
        providerAdapter: createDeterministicProviderAdapter({
          onRequest: (request) => requests.push(request),
        }),
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
    expect(result.payload?.briefReceipt).toMatchObject({
      requestedMode: "auto",
      selectedVerbosity: "detailed",
      selectionReasons: ["high-complexity", "uncertainty", "recovery"],
      outputTokenBudget: 8_192,
    });
    expect(result.payload?.briefReceipt?.preservedFacts).toEqual(
      expect.arrayContaining(["citation", "validation"]),
    );
    expect(requests[0]?.budgets.maxOutputTokens).toBe(8_192);
    expect(
      requests[0]?.messages
        .flatMap((message) => message.parts)
        .some(
          (part) =>
            part.kind === "text" &&
            part.text.includes("source=capability-catalog:0") &&
            part.text.includes("Registry inventory:"),
        ),
    ).toBe(true);
    expect(
      requests[0]?.messages
        .flatMap((message) => message.parts)
        .some(
          (part) =>
            part.kind === "text" &&
            part.text.includes("Keep citations") &&
            part.text.includes("Keep validation results"),
        ),
    ).toBe(true);
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

  test("executes disclosed workspace, git, and memory tools through the live turn", async () => {
    const seeded = await seededHome();
    const locatedGit = Bun.which("git");
    if (locatedGit !== null) {
      const initialized = Bun.spawn([locatedGit, "init"], {
        cwd: seeded.primary,
        stdout: "pipe",
        stderr: "pipe",
        env: { GIT_TERMINAL_PROMPT: "0" },
      });
      await initialized.exited;
    }
    const services = providerFor(seeded)(globalsFor(seeded));
    const requests: ModelRequest[] = [];
    const toolCalls = [
      {
        name: "write_files",
        arguments: {
          targets: [{ kind: "create", path: "notes.txt", text: "hello workspace\n" }],
        },
      },
      { name: "git_status", arguments: {} },
      { name: "memory_recall", arguments: { workspaceId: "workspace-e2e" } },
    ] as const;
    const result = await runCoding(
      services,
      {
        promptParts: [
          "Create notes.txt containing a hello greeting with write_files, " +
            "then inspect the repository with git_status, " +
            "and recall memory_recall for prior context.",
        ],
      },
      {
        input: createRecordingCliStreams({ stdin: null }).input,
        globals: globalsFor(seeded),
        providerAdapter: createDeterministicProviderAdapter({
          onRequest: (request) => requests.push(request),
          script: (_request, requestIndex) => {
            const call = toolCalls[requestIndex];
            return call === undefined
              ? { kind: "text", text: "done", finishReason: "stop" }
              : {
                  kind: "tool",
                  toolCallId: `call-e2e-${requestIndex}`,
                  name: call.name,
                  argumentFragments: [JSON.stringify(call.arguments)],
                };
          },
        }),
        toolConfirmation: {
          resolve: async (request) => ({
            kind: "confirmed",
            confirmationId: request.confirmationId,
          }),
        },
        identities: {
          sessionId: "session-run-tool-e2e",
          turnId: "turn-run-tool-e2e",
          traceId: "trace-run-tool-e2e",
        },
      },
    );

    expect(result.outcome.kind).toBe("completed");
    expect(result.payload?.toolResults).toBe(3);

    const disclosed = requests[0]?.tools ?? [];
    expect(disclosed.map((tool) => tool.name)).toEqual(
      expect.arrayContaining(["write_files", "git_status", "memory_recall"]),
    );
    const writeSchema = disclosed.find((tool) => tool.name === "write_files");
    expect(writeSchema?.parameters).toMatchObject({
      type: "object",
      additionalProperties: false,
    });

    for (const [index, call] of toolCalls.entries()) {
      const continuation = requests[index + 1];
      const toolMessage = continuation?.messages.findLast(
        (message) => message.role === "tool" && message.toolCallId === `call-e2e-${index}`,
      );
      const text = toolMessage?.parts.find((part) => part.kind === "text")?.text;
      expect(text, `tool result for ${call.name}`).toBeDefined();
      const serialized = JSON.parse(text ?? "{}") as {
        readonly output?: { readonly status?: string };
      };
      expect(serialized.output?.status).toBe(
        call.name === "git_status" && locatedGit === null ? "failed" : "completed",
      );
    }
    await expect(readFile(join(seeded.primary, "notes.txt"), "utf8")).resolves.toBe(
      "hello workspace\n",
    );
  });

  test("marks bounded fallbacks as deferred and admits their calls through the gateway", async () => {
    const seeded = await seededHome();
    await Bun.write(join(seeded.primary, "notes.txt"), "hello deferred\n");
    const services = providerFor(seeded)(globalsFor(seeded));
    const requests: ModelRequest[] = [];
    const deferredArguments: Record<string, Record<string, unknown>> = {
      read: { resources: [{ kind: "workspace", path: "notes.txt" }] },
      search_text: { query: "needle" },
      git_status: {},
      list_dir: { path: "." },
      stat_path: { path: "." },
    };
    const result = await runCoding(
      services,
      {
        promptParts: ["Inspect the workspace and report what you find."],
      },
      {
        input: createRecordingCliStreams({ stdin: null }).input,
        globals: globalsFor(seeded),
        providerAdapter: createDeterministicProviderAdapter({
          onRequest: (request) => requests.push(request),
          script: (request, requestIndex) => {
            if (requestIndex !== 0) {
              return { kind: "text", text: "done", finishReason: "stop" };
            }
            const target =
              request.tools.find(
                (tool) => tool.deferred === true && tool.name in deferredArguments,
              ) ?? request.tools.find((tool) => tool.deferred === true);
            if (target === undefined) {
              return { kind: "text", text: "no deferred tools", finishReason: "stop" };
            }
            return {
              kind: "tool",
              toolCallId: "call-deferred-e2e",
              name: target.name,
              argumentFragments: [JSON.stringify(deferredArguments[target.name] ?? {})],
            };
          },
        }),
        toolConfirmation: {
          resolve: async (request) => ({
            kind: "confirmed",
            confirmationId: request.confirmationId,
          }),
        },
        identities: {
          sessionId: "session-run-deferred-e2e",
          turnId: "turn-run-deferred-e2e",
          traceId: "trace-run-deferred-e2e",
        },
      },
    );

    expect(result.outcome.kind).toBe("completed");
    expect(result.payload?.toolResults).toBe(1);

    const disclosed = requests[0]?.tools ?? [];
    const flagged = disclosed.filter((tool) => tool.deferred === true);
    expect(flagged.length).toBeGreaterThan(0);
    expect(disclosed.length).toBeGreaterThan(flagged.length);
    expect(
      disclosed.slice(0, disclosed.length - flagged.length).every((tool) => tool.deferred !== true),
    ).toBe(true);

    const toolMessage = requests[1]?.messages.findLast(
      (message) => message.role === "tool" && message.toolCallId === "call-deferred-e2e",
    );
    const text = toolMessage?.parts.find((part) => part.kind === "text")?.text;
    expect(text).toBeDefined();
    const serialized = JSON.parse(text ?? "{}") as {
      readonly output?: { readonly status?: string; readonly reason?: string };
    };
    expect(serialized.output?.status).toBeDefined();
    expect(serialized.output?.reason).not.toBe("tool-not-disclosed");
  });

  test("keeps matched no-tool scorecard turns on the live path without tool disclosure", async () => {
    const seeded = await seededHome();
    const services = providerFor(seeded)(globalsFor(seeded));
    const requests: ModelRequest[] = [];
    const result = await runCoding(
      services,
      { promptParts: ["Answer only from the supplied fact."], mode: "ask", brief: "compact" },
      {
        input: createRecordingCliStreams({ stdin: null }).input,
        globals: globalsFor(seeded),
        providerAdapter: createDeterministicProviderAdapter({
          onRequest: (request) => requests.push(request),
        }),
        toolExposureOverride: "none",
        identities: {
          sessionId: "session-run-no-tools",
          turnId: "turn-run-no-tools",
          traceId: "trace-run-no-tools",
        },
      },
    );

    expect(result.outcome.kind).toBe("completed");
    expect(result.payload?.disclosedTools).toBe(0);
    expect(result.payload?.toolResults).toBe(0);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.tools).toEqual([]);
    expect(
      requests[0]?.messages
        .flatMap((message) => message.parts)
        .some(
          (part) =>
            part.kind === "text" && part.text.includes("Executable tools for this attempt: none"),
        ),
    ).toBe(true);
  });

  test("runs and replays the shared durable live-turn matrix through falryn run", async () => {
    const seeded = await seededHome();
    await writeFile(join(seeded.primary, "matrix.ts"), LIVE_TURN_MATRIX_CONTEXT, "utf8");
    const services = providerFor(seeded)(globalsFor(seeded));
    const fixture = createLiveTurnMatrixFixture(null, "cap-823-headless");
    const result = await runCoding(
      services,
      { promptParts: [LIVE_TURN_MATRIX_PROMPT] },
      {
        input: createRecordingCliStreams({ stdin: null }).input,
        globals: globalsFor(seeded),
        providerAdapter: fixture.provider,
        processCapture: fixture.processCapture,
        toolConfirmation: LIVE_TURN_MATRIX_CONFIRMATION,
        identities: {
          sessionId: "session-823-headless",
          turnId: "turn-823-headless",
          traceId: "trace-823-headless",
        },
      },
    );

    expect(result.outcome.kind).toBe("completed");
    expect(result.payload).toMatchObject({
      stage: "attempt-completed",
      response: LIVE_TURN_MATRIX_FINAL_TEXT,
      modelAttempts: 1,
      toolResults: 1,
      executionProfile: "agent",
    });
    expect(fixture.captures).toBe(1);
    expect(fixture.requests).toHaveLength(2);
    expect(JSON.stringify(fixture.requests[0])).toContain(LIVE_TURN_MATRIX_CONTEXT.trim());

    const continuation = liveTurnMatrixContinuation(fixture.requests);
    expect(continuation.assistant.toolCalls).toEqual([
      {
        toolCallId: LIVE_TURN_MATRIX_TOOL_CALL_ID,
        name: "run_process",
        arguments: { executable: "/bin/ls", argv: ["-la"], outputMode: "hush" },
      },
    ]);
    expect(continuation.tool.toolCallId).toBe(LIVE_TURN_MATRIX_TOOL_CALL_ID);
    expect(continuation.toolOutput.output?.value).toMatchObject({
      captureId: "cap-823-headless",
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

    const reopened = await openProductArtifactSession(services());
    expect(reopened).not.toBeNull();
    if (reopened === null) {
      return;
    }
    const replayed = await reopened.eventStore.readFrom(
      { streamId: streamId.from("live-turn:session-823-headless"), afterSequence: null },
      100,
    );
    expect(replayed.ok).toBe(true);
    if (replayed.ok) {
      expect(replayed.value.map((event) => event.kind)).toEqual(LIVE_TURN_MATRIX_EVENT_KINDS);
      expect(
        replayed.value.some(
          (event) =>
            event.kind === "capability.invocation.completed" &&
            event.capabilityId === "falryn:composition:v1" &&
            event.payload.composition?.topology.length === 1,
        ),
      ).toBe(true);
      const completed = replayed.value.find(
        (event) => event.kind === "capability.invocation.completed",
      );
      expect(completed?.kind).toBe("capability.invocation.completed");
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
    await reopened.close();
  });

  test("fails the shared live-turn path before continuation when exact Hush recovery cannot persist", async () => {
    const seeded = await seededHome();
    await writeFile(join(seeded.primary, "matrix.ts"), LIVE_TURN_MATRIX_CONTEXT, "utf8");
    const services = providerFor(seeded)(globalsFor(seeded));
    const artifacts = failingArtifactStore();
    const fixture = createLiveTurnMatrixFixture(artifacts, "cap-823-retention-failure");
    const result = await runCoding(
      services,
      { promptParts: [LIVE_TURN_MATRIX_PROMPT] },
      {
        input: createRecordingCliStreams({ stdin: null }).input,
        globals: globalsFor(seeded),
        providerAdapter: fixture.provider,
        processCapture: fixture.processCapture,
        toolConfirmation: LIVE_TURN_MATRIX_CONFIRMATION,
        artifacts,
        identities: {
          sessionId: "session-823-retention-failure",
          turnId: "turn-823-retention-failure",
          traceId: "trace-823-retention-failure",
        },
      },
    );

    expect(result.outcome).toEqual({ kind: "failed", effect: "partial" });
    expect(result.payload).toMatchObject({
      stage: "attempt-failed",
      response: "",
      modelAttempts: 1,
      toolResults: 1,
    });
    expect(fixture.captures).toBe(1);
    expect(fixture.requests).toHaveLength(1);

    const reopened = await openProductArtifactSession(services());
    expect(reopened).not.toBeNull();
    if (reopened === null) {
      return;
    }
    const replayed = await reopened.eventStore.readFrom(
      {
        streamId: streamId.from("live-turn:session-823-retention-failure"),
        afterSequence: null,
      },
      100,
    );
    expect(replayed.ok).toBe(true);
    if (replayed.ok) {
      expect(replayed.value.map((event) => event.kind)).toEqual(LIVE_TURN_MATRIX_EVENT_KINDS);
      const terminal = replayed.value.find((event) => event.kind === "turn.completed");
      expect(terminal?.kind === "turn.completed" ? terminal.payload.outcome : null).toEqual({
        kind: "failed",
        effect: "partial",
      });
    }
    await reopened.close();
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
              schemaVersion: 1,
              modelId,
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
              schemaVersion: 1,
              modelId,
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
    expect(names).toContain("git_status");
    expect(names).toContain("dap_start");
    expect(names).toContain("dap_set_breakpoints");
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

  test("executes a generated native workflow through the real gateway without relay model turns", async () => {
    const seeded = await seededHome();
    await writeFile(
      join(seeded.primary, "workflow-evidence.ts"),
      "export const evidence = true;\n",
    );
    const services = providerFor(seeded)(globalsFor(seeded));
    const requests: ModelRequest[] = [];
    const handle = { id: "native-workflow", generation: "generation-1" };
    const definition = {
      version: 1,
      id: "user/generated:native",
      label: "Inspect workspace",
      argumentsSchema: { type: "object", properties: {}, additionalProperties: false },
      nodes: [
        {
          key: "list",
          kind: "action",
          capability: "builtin:workspace/list_dir@1",
          effect: "observation",
          input: { path: { from: "literal", value: "." } },
          resultPath: ["entries", 0, "logical"],
          resultSchema: { type: "string" },
        },
        {
          key: "stat",
          kind: "action",
          capability: "builtin:workspace/stat_path@1",
          effect: "observation",
          dependencies: ["list"],
          input: { path: { from: "node", node: "list" } },
          resultPath: ["byteLength"],
          resultSchema: { type: "number" },
        },
      ],
      outputs: { fileSize: { from: "node", node: "stat" } },
    };
    const adapter = createDeterministicProviderAdapter({
      onRequest: (request) => requests.push(request),
      script: (_request, index) =>
        index === 0
          ? {
              kind: "tool",
              name: "workflow",
              toolCallId: "execute-workflow",
              argumentFragments: [
                JSON.stringify({
                  operation: "execute",
                  handle,
                  definitionJson: JSON.stringify(definition),
                  argumentsJson: "{}",
                }),
              ],
            }
          : { kind: "text", text: "Inspected through the workflow." },
    });
    const result = await runCoding(
      services,
      { promptParts: ["Execute a workflow to inspect the workspace directory"] },
      {
        input: createRecordingCliStreams({ stdin: null }).input,
        globals: globalsFor(seeded),
        providerAdapter: adapter,
        identities: {
          sessionId: "workflow-native-session",
          turnId: "workflow-native-turn",
          traceId: "workflow-native-trace",
        },
      },
    );
    const messages = JSON.stringify(
      requests.flatMap((request) => request.messages.filter((message) => message.role === "tool")),
    );
    const diagnostic = await openProductArtifactSession(services());
    const observed = diagnostic
      ? await diagnostic.eventStore.readFrom(
          { streamId: streamId.from("live-turn:workflow-native-session"), afterSequence: null },
          100,
        )
      : null;
    const checkpoint = diagnostic?.workflows.get(handle);
    await diagnostic?.close();
    expect(result.outcome.kind, JSON.stringify({ checkpoint, observed })).toBe("completed");
    expect(checkpoint, JSON.stringify(checkpoint)).toMatchObject({
      ok: true,
      value: { state: "completed" },
    });
    expect(requests, messages).toHaveLength(2);
    expect(messages).toContain("workflow-run");
    const reopened = await openProductArtifactSession(services());
    if (!reopened) throw new Error("workflow fixture persistence unavailable");
    try {
      const record = reopened.workflows.get(handle);
      expect(record, messages).toMatchObject({ ok: true, value: { state: "completed" } });
      if (!record.ok) return;
      expect(record.value.nodes).toHaveLength(2);
      expect(record.value.nodes[0]).toMatchObject({
        template: "list",
        attempts: 1,
        state: "completed",
      });
      expect(record.value.task).not.toBeNull();
    } finally {
      await reopened.close();
    }
  });

  test("workflow search and parallel reads feed one revision-bound patch; an intervening writer blocks checks", async () => {
    for (const changed of [false, true]) {
      const seeded = await seededHome();
      await writeFile(join(seeded.primary, "a.ts"), "old-a\n");
      await writeFile(join(seeded.primary, "b.ts"), "old-b\n");
      const services = providerFor(seeded)(globalsFor(seeded));
      const requests: ModelRequest[] = [];
      const confirmations: string[] = [];
      const literal = (value: unknown) => ({ from: "literal", value });
      const targets = ["a", "b"].map((name) => ({
        path: `${name}.ts`,
        hunks: [{ oldStart: 1, oldLines: [`old-${name}`], newLines: [`new-${name}`] }],
      }));
      const action = {
        kind: "action",
        effect: "observation",
        resultSchema: { type: "string" },
      };
      const handle = { id: "patch-workflow", generation: "one" };
      const definition = {
        version: 1,
        id: "user/generated:patch",
        label: "Inspect, patch and check",
        argumentsSchema: { type: "object", properties: {}, additionalProperties: false },
        nodes: [
          {
            ...action,
            key: "search",
            capability: "builtin:workspace/search_text@1",
            input: { query: literal("old-a"), start: literal(".") },
            resultPath: ["matches", 0, "logical"],
          },
          {
            ...action,
            key: "read-a",
            capability: "builtin:workspace/read_file@1",
            dependencies: ["search"],
            input: { path: { from: "node", node: "search" } },
            resultPath: ["digest"],
          },
          {
            ...action,
            key: "read-b",
            capability: "builtin:workspace/read_file@1",
            input: { path: literal("b.ts") },
            resultPath: ["digest"],
          },
          {
            ...action,
            key: "preview",
            capability: "builtin:workspace/preview_patch@1",
            dependencies: ["read-a", "read-b"],
            input: { targets: literal(targets) },
            resultPath: ["planId"],
          },
          {
            ...action,
            key: "apply",
            capability: "builtin:workspace/apply_patch@1",
            effect: "mutation",
            dependencies: ["preview"],
            input: { targets: literal(targets), expectedPlanId: { from: "node", node: "preview" } },
            resultPath: ["items", 0, "status"],
            resultSchema: { type: "string", enum: ["applied"] },
          },
          {
            ...action,
            key: "check",
            capability: "builtin:workspace/run_process@1",
            effect: "mutation",
            dependencies: ["apply"],
            input: {
              executable: literal(process.execPath),
              argv: literal([
                "-e",
                'const a = await Bun.file("a.ts").text(); const b = await Bun.file("b.ts").text(); process.exit(a === "new-a\\n" && b === "new-b\\n" ? 0 : 1);',
              ]),
              outputMode: literal("raw"),
            },
            resultPath: ["process", "exitCode"],
            resultSchema: { type: "integer", enum: [0] },
          },
        ],
        outputs: { exitCode: { from: "node", node: "check" } },
      };
      const adapter = createDeterministicProviderAdapter({
        onRequest: (request) => requests.push(request),
        script: (_request, index) =>
          index === 0
            ? {
                kind: "tool",
                name: "workflow",
                toolCallId: "workflow-patch",
                argumentFragments: [
                  JSON.stringify({
                    operation: "execute",
                    handle,
                    definitionJson: JSON.stringify(definition),
                    argumentsJson: "{}",
                  }),
                ],
              }
            : { kind: "text", text: "The native workflow settled." },
      });
      const result = await runCoding(
        services,
        {
          promptParts: [
            "Execute a workflow to search, read, preview and apply a patch, then run checks",
          ],
        },
        {
          input: createRecordingCliStreams({ stdin: null }).input,
          globals: globalsFor(seeded),
          providerAdapter: adapter,
          toolConfirmation: {
            async resolve(request) {
              confirmations.push(request.toolName);
              if (changed && request.toolName === "apply_patch")
                await writeFile(join(seeded.primary, "a.ts"), "another-writer\n");
              return { kind: "confirmed", confirmationId: request.confirmationId };
            },
          },
        },
      );
      expect(result.outcome.kind).toBe("completed");
      const session = await openProductArtifactSession(services());
      if (!session) throw new Error("Missing workflow store");
      try {
        const checkpoint = session.workflows.get(handle);
        expect(checkpoint, JSON.stringify(checkpoint)).toMatchObject({
          ok: true,
          value: { state: changed ? "failed" : "completed" },
        });
        if (!checkpoint.ok) return;
        expect(checkpoint.value.nodes.find((node) => node.key === "check")).toMatchObject({
          state: changed ? "skipped" : "completed",
        });
        expect(
          checkpoint.value.nodes
            .filter((node) => node.attempts > 0)
            .every((node) => node.attempts === 1),
        ).toBe(true);
      } finally {
        await session.close();
      }
      expect(requests).toHaveLength(2);
      expect(confirmations).toEqual(changed ? ["apply_patch"] : ["apply_patch", "run_process"]);
      expect(await readFile(join(seeded.primary, "a.ts"), "utf8")).toBe(
        changed ? "another-writer\n" : "new-a\n",
      );
      expect(await readFile(join(seeded.primary, "b.ts"), "utf8")).toBe(
        changed ? "old-b\n" : "new-b\n",
      );
    }
  });

  test("workflow mutations use the native confirmation once and preserve it across dependent inspection", async () => {
    for (const confirmed of [true, false]) {
      const seeded = await seededHome();
      const services = providerFor(seeded)(globalsFor(seeded));
      const requests: ModelRequest[] = [];
      const confirmations: string[] = [];
      const handle = { id: "write-workflow", generation: "one" };
      const definition = {
        version: 1,
        id: "user/generated:write",
        label: "Write and inspect",
        argumentsSchema: { type: "object", properties: {}, additionalProperties: false },
        nodes: [
          {
            key: "write",
            kind: "action",
            capability: "builtin:workspace/write_files@1",
            effect: "mutation",
            input: {
              targets: {
                from: "literal",
                value: [
                  {
                    kind: "create",
                    path: "workflow-created.ts",
                    text: "export const created = true;\n",
                  },
                ],
              },
            },
            resultPath: ["items", 0, "byteLength"],
            resultSchema: { type: "number" },
          },
          {
            key: "stat",
            kind: "action",
            capability: "builtin:workspace/stat_path@1",
            effect: "observation",
            dependencies: ["write"],
            input: { path: { from: "literal", value: "workflow-created.ts" } },
            resultPath: ["byteLength"],
            resultSchema: { type: "number" },
          },
        ],
        outputs: {
          written: { from: "node", node: "write" },
          inspected: { from: "node", node: "stat" },
        },
      };
      const adapter = createDeterministicProviderAdapter({
        onRequest: (request) => requests.push(request),
        script: (_request, index) =>
          index === 0
            ? {
                kind: "tool",
                name: "workflow",
                toolCallId: "workflow-write",
                argumentFragments: [
                  JSON.stringify({
                    operation: "execute",
                    handle,
                    definitionJson: JSON.stringify(definition),
                    argumentsJson: "{}",
                  }),
                ],
              }
            : { kind: "text", text: "Created and inspected." },
      });
      const result = await runCoding(
        services,
        {
          promptParts: ["Execute a workflow to write files and inspect their size with stat path"],
        },
        {
          input: createRecordingCliStreams({ stdin: null }).input,
          globals: globalsFor(seeded),
          providerAdapter: adapter,
          toolConfirmation: {
            async resolve(request) {
              confirmations.push(request.toolName);
              return confirmed
                ? { kind: "confirmed", confirmationId: request.confirmationId }
                : { kind: "refused" };
            },
          },
        },
      );
      expect(result.outcome.kind).toBe("completed");
      expect(
        confirmations,
        JSON.stringify(
          requests.flatMap((request) =>
            request.messages.filter((message) => message.role === "tool"),
          ),
        ),
      ).toEqual(["write_files"]);
      if (confirmed)
        expect(await readFile(join(seeded.primary, "workflow-created.ts"), "utf8")).toBe(
          "export const created = true;\n",
        );
      else expect(await readdir(seeded.primary)).not.toContain("workflow-created.ts");
      expect(requests).toHaveLength(2);
      const session = await openProductArtifactSession(services());
      if (!session) throw new Error("Missing session");
      try {
        expect(session.workflows.get(handle)).toMatchObject({
          ok: true,
          value: {
            state: confirmed ? "completed" : "failed",
            nodes: [
              {
                state: confirmed ? "completed" : "failed",
                effect: confirmed ? "completed" : "none",
                attempts: 1,
              },
              { state: confirmed ? "completed" : "skipped", attempts: confirmed ? 1 : 0 },
            ],
          },
        });
      } finally {
        await session.close();
      }
    }
  });

  test("headless workflow questions return durable waiting receipts without requesting generic approval", async () => {
    const seeded = await seededHome();
    const services = providerFor(seeded)(globalsFor(seeded));
    const requests: ModelRequest[] = [];
    const handle = { id: "waiting-workflow", generation: "one" };
    const definition = {
      version: 1,
      id: "user/generated:waiting",
      label: "Choose",
      argumentsSchema: { type: "object", properties: {}, additionalProperties: false },
      outputs: {},
      nodes: [
        {
          key: "question",
          kind: "question",
          resultPath: ["state"],
          resultSchema: { type: "string" },
          request: {
            items: [
              {
                id: "choice",
                kind: "single-select",
                prompt: "Choose a value",
                options: [
                  { id: "a", label: "One" },
                  { id: "b", label: "Two" },
                ],
              },
            ],
            sensitivity: "normal",
            retention: "answer",
            waitMs: 15000,
            missingPresenter: "wait",
          },
        },
      ],
    };
    const adapter = createDeterministicProviderAdapter({
      onRequest: (request) => requests.push(request),
      script: (_request, index) =>
        index === 0
          ? {
              kind: "tool",
              name: "workflow",
              toolCallId: "workflow-question",
              argumentFragments: [
                JSON.stringify({
                  operation: "execute",
                  handle,
                  definitionJson: JSON.stringify(definition),
                  argumentsJson: "{}",
                }),
              ],
            }
          : { kind: "text", text: "The workflow is waiting for your answer." },
    });
    const result = await runCoding(
      services,
      { promptParts: ["Execute a workflow with a structured question"] },
      {
        input: createRecordingCliStreams({ stdin: null }).input,
        globals: globalsFor(seeded),
        providerAdapter: adapter,
      },
    );
    expect(result.outcome.kind).toBe("completed");
    expect(requests).toHaveLength(2);
    const session = await openProductArtifactSession(services());
    if (!session) throw new Error("Missing session");
    try {
      const current = session.workflows.get(handle);
      expect(current).toMatchObject({
        ok: true,
        value: { state: "waiting", nodes: [{ state: "waiting", attempts: 1 }] },
      });
      if (current.ok) {
        expect(current.value.nodes[0]?.question).not.toBeNull();
        if (!current.value.task) throw new Error("Missing workflow task");
        expect(session.joins.task(current.value.task)).toMatchObject({
          ok: true,
          value: { state: "terminal" },
        });
      }
    } finally {
      await session.close();
    }
  });

  test("runs model and registered agent nodes through their ordinary runtimes", async () => {
    const seeded = await seededHome();
    const requests: ModelRequest[] = [];
    const services = providerFor(seeded)(globalsFor(seeded));
    const handle = { id: "mixed-workflow", generation: "one" };
    const definition = {
      version: 1,
      id: "user/generated:mixed",
      label: "Interpret and review",
      argumentsSchema: { type: "object", properties: {}, additionalProperties: false },
      nodes: [
        {
          key: "interpret",
          kind: "model",
          instruction: "Return the JSON string verified.",
          resultSchema: { type: "string" },
        },
        {
          key: "review",
          kind: "agent",
          agentId: "builtin/falryn/agents:explorer",
          dependencies: ["interpret"],
          input: { objective: { from: "node", node: "interpret" } },
          capabilities: [],
          effects: ["observation"],
          resultPath: ["findings"],
          resultSchema: { type: "array", items: { type: "string" } },
        },
      ],
      outputs: { findings: { from: "node", node: "review" } },
    };
    const adapter = createDeterministicProviderAdapter({
      onRequest: (request) => requests.push(request),
      script: (_request, index) => {
        if (index === 0)
          return {
            kind: "tool",
            name: "workflow",
            toolCallId: "mixed-workflow",
            argumentFragments: [
              JSON.stringify({
                operation: "execute",
                handle,
                definitionJson: JSON.stringify(definition),
                argumentsJson: "{}",
              }),
            ],
          };
        if (index === 1) return { kind: "text", text: '"verified"' };
        if (index === 2)
          return {
            kind: "text",
            text: JSON.stringify({
              locations: [],
              flow: [],
              findings: ["Reviewed input"],
              unknowns: [],
            }),
          };
        return { kind: "text", text: "Workflow settled." };
      },
    });
    const result = await runCoding(
      services,
      { promptParts: ["Execute a workflow with a model step and an Explorer review"] },
      {
        input: createRecordingCliStreams({ stdin: null }).input,
        globals: globalsFor(seeded),
        providerAdapter: adapter,
      },
    );
    const reopened = await openProductArtifactSession(services());
    if (!reopened) throw new Error("workflow fixture persistence unavailable");
    try {
      const record = reopened.workflows.get(handle);
      expect(record, JSON.stringify({ record, requests, result })).toMatchObject({
        ok: true,
        value: { state: "completed" },
      });
      expect(requests).toHaveLength(4);
      expect(requests[1]?.tools).toHaveLength(0);
      expect(record.ok && record.value.nodes.map((node) => node.attempts)).toEqual([1, 1]);
    } finally {
      await reopened.close();
    }
  });

  test("delegates from the main model through a real child tool and seals its evidence", async () => {
    const seeded = await seededHome();
    await writeFile(join(seeded.primary, "child-evidence.ts"), "export const child = true;\n");
    const requests: ModelRequest[] = [];
    const adapter = createDeterministicProviderAdapter({
      onRequest: (request) => requests.push(request),
      script: (request, index) => {
        if (index === 0)
          return {
            kind: "tool",
            toolCallId: "launch-explorer",
            name: "delegate",
            argumentFragments: [
              JSON.stringify({
                operation: "launch",
                definitionId: "builtin/falryn/agents:explorer",
                inputJson: JSON.stringify({ objective: "Inspect the workspace directory" }),
                context: [],
                capabilities: ["builtin:workspace/list_dir@1"],
                effects: ["observation"],
                limits: {},
                execution: {
                  version: 1,
                  attachment: "foreground",
                  foregroundWaitMs: 30000,
                  onSettle: "notify",
                  shutdown: "drain",
                },
              }),
            ],
          };
        if (index === 1)
          return {
            kind: "tool",
            toolCallId: "child-list",
            name: "list_dir",
            argumentFragments: ['{"path":"."}'],
          };
        if (index === 2)
          return {
            kind: "text",
            text: JSON.stringify({
              locations: ["child-evidence.ts"],
              flow: [],
              findings: ["Inspected directory"],
              unknowns: [],
            }),
          };
        if (index === 3) {
          const part = request.messages
            .findLast((message) => message.role === "tool")
            ?.parts.find((part) => part.kind === "text");
          if (part?.kind !== "text") throw new Error("missing child result");
          const child = sealedAgentResultSchema.parse(JSON.parse(part.text).output.value);
          return {
            kind: "tool",
            toolCallId: "join-child",
            name: "delegate",
            argumentFragments: [
              JSON.stringify({
                operation: "join",
                join: {
                  id: "inspection",
                  generation: 1,
                  children: [child.handle],
                  policy: {
                    mode: "all",
                    quorum: null,
                    partialOnFailure: false,
                    cancelRemaining: false,
                  },
                },
              }),
            ],
          };
        }
        if (index === 4)
          return {
            kind: "tool",
            toolCallId: "accept-child",
            name: "delegate",
            argumentFragments: [
              JSON.stringify({
                operation: "join-integrate",
                joinId: "inspection",
                joinGeneration: 1,
                integration: "accepted",
              }),
            ],
          };
        return { kind: "text", text: "Parent accepted child evidence." };
      },
    });
    const result = await runCoding(
      providerFor(seeded)(globalsFor(seeded)),
      { promptParts: ["Delegate an independent workspace inspection to Explorer"] },
      {
        input: createRecordingCliStreams({ stdin: null }).input,
        globals: globalsFor(seeded),
        providerAdapter: adapter,
      },
    );
    expect(result.outcome.kind, JSON.stringify({ result, requests })).toBe("completed");
    expect(
      requests,
      JSON.stringify(
        requests.flatMap((request) =>
          request.messages.filter((message) => message.role === "tool"),
        ),
      ),
    ).toHaveLength(6);
    expect(requests[0]?.tools.some((tool) => tool.name === "delegate")).toBe(true);
    expect(requests[1]?.tools.map((tool) => tool.name)).toEqual(["list_dir"]);
    expect(JSON.stringify(requests[2]?.messages)).toContain("child-evidence.ts");
    const parentResult = JSON.stringify(requests[3]?.messages);
    expect(parentResult).toContain("agent-result");
    expect(parentResult).toContain("not-asserted");
    expect(parentResult).toContain("observationRefs");
    expect(parentResult).toContain("child-evidence.ts");
    expect(JSON.stringify(requests[5]?.messages)).toContain("join:sha256:");
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
    expect(requests[0]?.tools.filter((tool) => tool.deferred !== true).length).toBeLessThanOrEqual(
      MAX_DISCLOSED_PRODUCT_TOOLS,
    );
    expect(requests[0]?.tools.filter((tool) => tool.deferred === true).length).toBeLessThanOrEqual(
      MAX_DEFERRED_PRODUCT_TOOLS,
    );
    expect(requests[0]?.tools.some((tool) => tool.name === "peer")).toBe(true);
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

  test("writes and reopens a scratch draft through the real product tool loop", async () => {
    const seeded = await seededHome();
    const services = providerFor(seeded)(globalsFor(seeded));
    const requests: ModelRequest[] = [];
    const adapter = createDeterministicProviderAdapter({
      onRequest: (request) => requests.push(request),
      script: (_request, index) =>
        index === 0
          ? {
              kind: "tool",
              toolCallId: "call-scratch-write",
              name: "scratch_write",
              argumentFragments: [
                '{"name":"pr-body.md","text":"# PR draft\\n","mediaType":"text/markdown"}',
              ],
            }
          : { kind: "text", text: "Draft retained.", finishReason: "stop" },
    });

    const result = await runCoding(
      services,
      { promptParts: ["draft", "a", "PR", "body"] },
      {
        input: createRecordingCliStreams({ stdin: null }).input,
        globals: globalsFor(seeded),
        providerAdapter: adapter,
        toolConfirmation: LIVE_TURN_MATRIX_CONFIRMATION,
        identities: {
          sessionId: "session-run-scratch",
          turnId: "turn-run-scratch",
          traceId: "trace-run-scratch",
        },
      },
    );

    expect(requests[0]?.tools.map((tool) => tool.name)).toContain("scratch_write");
    expect(result.payload).toMatchObject({
      stage: "attempt-completed",
      response: "Draft retained.",
      toolResults: 1,
    });
    expect(JSON.stringify(requests[1])).toContain(
      "scratch://session/session-run-scratch/pr-body.md",
    );
    expect(JSON.stringify(requests[1])).not.toContain("workspaceIndex");
    expect(await readdir(seeded.primary)).not.toContain("pr-body.md");

    const reopened = await openProductArtifactSession(services());
    expect(reopened).not.toBeNull();
    if (reopened === null) return;
    expect(
      await reopened.scratch.read(
        sessionId.from("session-run-scratch"),
        "scratch://session/session-run-scratch/pr-body.md",
      ),
    ).toMatchObject({ ok: true, value: { revision: 1, text: "# PR draft\n" } });
    await reopened.close();
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
          if (init === undefined) {
            throw new Error("expected OpenAI SDK request initialization");
          }
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

  test("keeps raw backend names behind human on and off controls", async () => {
    const invocation = await parseInvocation([
      "run",
      "--brief",
      "off",
      "--hush",
      "off",
      "--loom",
      "on",
      "inspect",
      "it",
    ]);
    expect(invocation.kind).toBe("run");
    if (invocation.kind === "run") {
      expect(invocation.runArgs).toEqual({
        promptParts: ["inspect", "it"],
        brief: "raw",
        hush: "raw",
        loom: "loom",
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

test("headless composition enforces and durably projects selected sandbox policy", async () => {
  const { sandboxProductJourney } = await import("./sandbox-product-fixtures.ts");
  const { createHostSandbox } = await import("../../integrations/security/host-sandbox.ts");
  for (const mode of [
    "off",
    "degraded",
    ...(createHostSandbox().probe().status === "available" ? ["strict" as const] : []),
  ] as const) {
    const home = await mkdtemp(join(tmpdir(), "falryn-sandbox-headless-"));
    homes.push(home);
    const observed = await sandboxProductJourney({ home, executable: process.execPath, mode });
    expect(observed.receipts).toHaveLength(1);
    expect(observed.receipts[0]).toMatchObject({
      requestedMode: mode,
      effectiveMode: mode === "degraded" ? null : mode,
      policyGeneration: 0,
    });
    expect(observed.result.payload?.sandbox).toContain(
      mode === "degraded" ? "Sandbox unavailable" : `Sandbox ${mode}`,
    );
    if (mode !== "degraded")
      expect(observed.requests.at(-1)).toContain(
        mode === "strict" ? "outside-denied" : "outside-allowed",
      );
  }
}, 30_000);

for (const kind of ["lsp", "dap"] as const) {
  (process.platform === "win32" ? test.skip : test)(
    `headless model starts and uses a configured ${kind} service`,
    async () => {
      const seeded = await seededHome();
      const fixture = languageStartupFixture(await realpath(seeded.primary), kind);
      await writeFile(join(seeded.primary, "fixture.ts"), "const answer = 42;");
      const services = providerFor(seeded)(globalsFor(seeded));
      await writeFile(
        join(String(services().configurationRoot), CONFIGURATION_FILE_NAME),
        JSON.stringify({ schemaVersion: 1, tools: { languageServices: fixture.configuration } }),
      );
      const result = await runCoding(
        services,
        { promptParts: [fixture.prompt] },
        {
          input: createRecordingCliStreams({ stdin: null }).input,
          globals: globalsFor(seeded),
          providerAdapter: fixture.provider,
          toolConfirmation: LIVE_TURN_MATRIX_CONFIRMATION,
        },
      );
      expect(
        result.outcome.kind,
        JSON.stringify({
          result,
          results: fixture.results,
          messages: fixture.requests.at(-1)?.messages,
        }),
      ).toBe("completed");
      expect(
        fixture.results.length,
        JSON.stringify({
          result,
          results: fixture.results,
          messages: fixture.requests.at(-1)?.messages,
        }),
      ).toBe(kind === "lsp" ? 8 : 6);
      expect(fixture.results.at(-1)).toMatchObject({ state: "stopped" });
      if (kind === "lsp")
        expect(fixture.results[3]).toMatchObject({ contents: { value: "fixture symbol: number" } });
      else expect(fixture.results[4]).toMatchObject([{ name: "fixture" }]);
    },
    30_000,
  );
}
