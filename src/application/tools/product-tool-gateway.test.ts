import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { artifactId } from "../../domain/artifacts/index.ts";
import {
  configurationGeneration,
  createManualClock,
  err,
  instant,
  invocationId,
  ok,
  sessionId,
  streamId,
  traceId,
  turnId,
  workspaceId,
} from "../../domain/foundation/index.ts";
import { createStubCommandRunner } from "../../domain/process/index.ts";
import type { PackageProvenance } from "../../domain/security/package-provenance.ts";
import { createInMemoryEventStore } from "../../domain/sessions/index.ts";
import {
  createToolHookRegistry,
  createToolRegistry,
  createToolRegistryEntry,
  defaultConcurrencyContract,
  defaultProjectionContract,
  defaultToolLimits,
} from "../../domain/tools/index.ts";
import { createInMemoryFileSystem, localPath } from "../../domain/workspace/index.ts";
import { ed25519PackageVerifier } from "../../integrations/extensions/package-signature.ts";
import { capabilityEntryFromTool } from "../capabilities/product-capability-registry.ts";
import { createCapabilityTrust } from "../extensions/capability-trust.ts";
import { verifyPackageProvenance } from "../extensions/package-provenance.ts";
import { inspectPackageTrust } from "../extensions/package-trust.ts";
import { signedVerification } from "../extensions/provenance-fixtures.ts";
import { memoryTrustStore, trustFixture } from "../extensions/trust-fixtures.ts";
import { createProductResources } from "../orchestration/product-resources.ts";
import { createTurnEventJournal } from "../runtime/turn-event-journal.ts";
import { createProductToolGateway } from "./product-tool-gateway.ts";
import { composeProductWorkspaceTools } from "./product-tools-workspace.ts";

const generation = configurationGeneration.from(3);
const turn = turnId.from("turn-gateway-1");
const correlation = {
  workspaceId: workspaceId.from("workspace-gateway-1"),
  sessionId: sessionId.from("session-gateway-1"),
  traceId: traceId.from("trace-gateway-1"),
  configurationGeneration: generation,
};

function setup() {
  const fileSystem = createInMemoryFileSystem({
    nodes: {
      "/work": { kind: "directory" },
      "/work/a.ts": { kind: "file", text: "export const a = 1;\n" },
    },
  });
  const tools = composeProductWorkspaceTools({
    generation,
    fileSystem,
    commands: createStubCommandRunner(() => ({ kind: "exited", exitCode: 1, stdout: "" })),
    workspaceRoot: localPath("/work"),
  });
  const eventStore = createInMemoryEventStore();
  const clock = createManualClock(instant(100));
  const journal = createTurnEventJournal({
    eventStore,
    clock,
    streamId: streamId.from("session:gateway-1"),
    correlation,
  });
  return { fileSystem, tools, eventStore, clock, journal };
}

describe("createProductToolGateway", () => {
  test.each(["user", "advisory"] as const)(
    "external sources recheck %s revocation after asynchronous hooks",
    async (cause) => {
      const { clock, journal } = setup();
      const { observation } = await trustFixture();
      const store = memoryTrustStore();
      let facts: PackageProvenance | null = null;
      const trust = createCapabilityTrust(store, () => observation, {
        get: () => ok(facts),
        replace: () => err({ code: "unavailable" }),
      });
      const entry = createToolRegistryEntry(
        {
          namespace: "extension",
          name: "inspect_fixture",
          version: 1,
          source: "plugin",
          title: "Inspect",
          description: "Read a fixture",
          effect: "observation",
          capabilityKind: "plugin",
          platforms: [],
          limits: defaultToolLimits(),
          concurrency: defaultConcurrencyContract(),
          resultProjection: defaultProjectionContract(),
        },
        {
          inputSchema: z.object({}).strict(),
          outputSchema: z.object({ result: z.string() }).strict(),
        },
      );
      if (!entry.ok) throw new Error(entry.error.code);
      const registry = createToolRegistry(generation, [entry.value]);
      if (!registry.ok) throw new Error(registry.error.code);
      let revokeDuringHook = false;
      const hooks = createToolHookRegistry(generation, [
        {
          id: "revoke",
          point: "before-capability-invocation",
          priority: 1,
          run: () => {
            if (revokeDuringHook) {
              if (cause === "advisory") {
                facts = verifyPackageProvenance(
                  observation,
                  signedVerification(observation, { status: "revoked" }),
                  ed25519PackageVerifier,
                  1,
                );
                return { kind: "allow" };
              }
              const preview = inspectPackageTrust(store, observation, [], {
                action: "revoke",
                expiresAt: null,
              });
              if (preview.status !== "preview" || preview.confirmation === null)
                throw new Error("revoke preview");
              inspectPackageTrust(store, observation, [], {
                action: "revoke",
                expiresAt: null,
                confirmation: preview.confirmation,
              });
            }
            return { kind: "allow" };
          },
        },
      ]);
      if (!hooks.ok) throw new Error(hooks.error.code);
      let effects = 0;
      const gateway = createProductToolGateway({
        clock,
        journal,
        resources: createProductResources(clock),
        registry: registry.value,
        runner: {
          execute: async () => {
            effects++;
            return { status: "completed", output: { result: "ok" }, effect: "completed" };
          },
        },
        hooks: hooks.value,
        correlation,
        turnId: turn,
        disclosedToolNames: new Set(["inspect_fixture"]),
        effectLedger: new Map(),
        trust,
      });
      const run = (id: string) =>
        gateway.execute({
          invocationId: invocationId.from(id),
          toolCallId: id,
          toolName: "inspect_fixture",
          capabilityId: entry.value.manifest.capabilityId,
          version: 1,
          effect: "observation",
          input: {},
          signal: new AbortController().signal,
        });
      expect((await run("trust-absent")).status).toBe("denied");
      expect(capabilityEntryFromTool(entry.value, true, trust).state.executable).toBe(false);
      const approve = inspectPackageTrust(store, observation, [], {
        action: "approve",
        expiresAt: 10_000,
      });
      if (approve.status !== "preview" || approve.confirmation === null)
        throw new Error("approve preview");
      inspectPackageTrust(store, observation, [], {
        action: "approve",
        expiresAt: 10_000,
        confirmation: approve.confirmation,
      });
      const published = capabilityEntryFromTool(entry.value, true, trust);
      expect(published.trust?.state).toBe("user-approved");
      expect((await run("trust-approved")).status).toBe("completed");
      revokeDuringHook = true;
      expect((await run("trust-revoked-in-hook")).status).toBe("denied");
      expect((await run("trust-approved")).status).toBe("denied");
      expect(effects).toBe(1);
      expect(capabilityEntryFromTool(entry.value, true, trust).trust?.state).toBe("revoked");
    },
  );
  test("runs observations through hooks, scheduling, projection, and durable facts", async () => {
    const { tools, clock, journal } = setup();
    const hookPoints: string[] = [];
    const hooks = createToolHookRegistry(generation, [
      {
        id: "gateway.pre",
        point: "before-capability-invocation",
        priority: 1,
        run: (envelope) => {
          hookPoints.push(envelope.point);
          return { kind: "allow" };
        },
      },
      {
        id: "gateway.post",
        point: "after-capability-invocation",
        priority: 1,
        run: (envelope) => {
          hookPoints.push(envelope.point);
          return { kind: "allow" };
        },
      },
    ]);
    if (!hooks.ok) {
      throw new Error(hooks.error.code);
    }
    const entry = tools.registry.resolveByName("read_file");
    if (entry === null) {
      throw new Error("read_file is not registered");
    }
    const gateway = createProductToolGateway({
      clock,
      resources: createProductResources(clock),
      registry: tools.registry,
      runner: {
        async execute(request) {
          const outcome = await tools.runner.execute(request);
          return outcome.status === "completed"
            ? {
                ...outcome,
                result: {
                  artifacts: [
                    {
                      artifactId: artifactId.from("capture-result"),
                      required: true,
                      committed: true,
                      truncated: false,
                    },
                  ],
                  captureOverflow: false,
                  containedProcessExitCode: 0,
                },
              }
            : outcome;
        },
      },
      hooks: hooks.value,
      journal,
      correlation,
      turnId: turn,
      disclosedToolNames: new Set(["read_file"]),
      effectLedger: new Map(),
    });

    const outcome = await gateway.execute({
      invocationId: invocationId.from("inv-gateway-read"),
      toolCallId: "call-read",
      toolName: "read_file",
      capabilityId: entry.manifest.capabilityId,
      version: entry.manifest.version,
      effect: entry.manifest.effect,
      input: { path: "a.ts" },
      signal: new AbortController().signal,
    });

    expect(outcome.status).toBe("completed");
    expect(JSON.stringify(outcome)).toContain("export const a");
    if (outcome.status === "completed") {
      expect(outcome.output).toMatchObject({
        artifacts: [{ artifactId: "capture-result", committed: true }],
      });
    }
    expect(hookPoints).toEqual(["before-capability-invocation", "after-capability-invocation"]);
    const replay = await journal.replay();
    expect(replay.kind === "rebuilt" || replay.kind === "partial").toBe(true);
    if (replay.kind === "rebuilt" || replay.kind === "partial") {
      expect(
        replay.events
          .filter((event) => event.kind !== "history.recorded")
          .map((event) => event.kind),
      ).toEqual(["capability.invocation.started", "capability.invocation.completed"]);
      expect(
        replay.events.flatMap((event) =>
          event.kind === "history.recorded" && event.payload.type === "gate"
            ? [event.payload.stage]
            : [],
        ),
      ).toEqual(["validation", "policy", "pre-hook", "schedule", "post-hook"]);
      const started = replay.events.find((event) => event.kind === "capability.invocation.started");
      expect(started?.kind === "capability.invocation.started" ? started.payload : null).toEqual({
        capabilityVersion: entry.manifest.version,
        inputDigest: expect.stringMatching(/^[0-9a-f]{64}$/),
      });
    }
  });

  test("rejects undisclosed tools before the executor runs", async () => {
    const { tools, clock, journal } = setup();
    const hooks = createToolHookRegistry(generation, []);
    if (!hooks.ok) {
      throw new Error(hooks.error.code);
    }
    let runnerCalls = 0;
    const gateway = createProductToolGateway({
      clock,
      resources: createProductResources(clock),
      registry: tools.registry,
      runner: {
        execute: async (request) => {
          runnerCalls += 1;
          return tools.runner.execute(request);
        },
      },
      hooks: hooks.value,
      journal,
      correlation,
      turnId: turn,
      disclosedToolNames: new Set(),
      effectLedger: new Map(),
    });
    const entry = tools.registry.resolveByName("read_file");
    if (entry === null) {
      throw new Error("read_file is not registered");
    }

    const outcome = await gateway.execute({
      invocationId: invocationId.from("inv-gateway-hidden"),
      toolCallId: "call-hidden",
      toolName: "read_file",
      capabilityId: entry.manifest.capabilityId,
      version: entry.manifest.version,
      effect: entry.manifest.effect,
      input: { path: "a.ts" },
      signal: new AbortController().signal,
    });

    expect(outcome).toEqual({
      status: "unavailable",
      reason: "tool-not-disclosed",
      effect: "none",
    });
    expect(runnerCalls).toBe(0);
  });

  test("binds confirmation and prevents duplicate consequential effects", async () => {
    const { tools, clock, journal } = setup();
    const hooks = createToolHookRegistry(generation, []);
    if (!hooks.ok) {
      throw new Error(hooks.error.code);
    }
    let runnerCalls = 0;
    let confirmations = 0;
    const gateway = createProductToolGateway({
      clock,
      resources: createProductResources(clock),
      registry: tools.registry,
      runner: {
        execute: async (request) => {
          runnerCalls += 1;
          return tools.runner.execute(request);
        },
      },
      hooks: hooks.value,
      journal,
      correlation,
      turnId: turn,
      disclosedToolNames: new Set(["write_files"]),
      confirmation: {
        resolve: async (request) => {
          confirmations += 1;
          return { kind: "confirmed", confirmationId: request.confirmationId };
        },
      },
      effectLedger: new Map(),
    });
    const entry = tools.registry.resolveByName("write_files");
    if (entry === null) {
      throw new Error("write_files is not registered");
    }
    const input = {
      targets: [{ path: "created.ts", kind: "create", text: "export {};\n" }],
    };
    const execute = (id: string) =>
      gateway.execute({
        invocationId: invocationId.from(id),
        toolCallId: id,
        toolName: "write_files",
        capabilityId: entry.manifest.capabilityId,
        version: entry.manifest.version,
        effect: entry.manifest.effect,
        input,
        signal: new AbortController().signal,
      });

    expect((await execute("inv-write-1")).status).toBe("completed");
    expect((await execute("inv-write-1")).status).toBe("completed");
    expect(confirmations).toBe(1);
    expect(runnerCalls).toBe(1);
  });

  test("uses the validated argument-derived effect throughout the gateway", async () => {
    const { clock, journal } = setup();
    const entry = createToolRegistryEntry(
      {
        namespace: "workspace",
        name: "debug_evaluate",
        version: 1,
        source: "builtin",
        title: "Evaluate expression",
        description: "Evaluate with an effect selected from the validated context",
        effect: "interactive",
        capabilityKind: "dap",
        platforms: [],
        limits: defaultToolLimits(),
        concurrency: defaultConcurrencyContract(),
        resultProjection: defaultProjectionContract(),
      },
      {
        inputSchema: z
          .object({ context: z.enum(["watch", "repl"]), expression: z.string().min(1) })
          .strict(),
        outputSchema: z.object({ result: z.string() }).strict(),
        effectFor: (input) => (input.context === "repl" ? "interactive" : "observation"),
      },
    );
    if (!entry.ok) throw new Error(entry.error.code);
    const registry = createToolRegistry(generation, [entry.value]);
    if (!registry.ok) throw new Error(registry.error.code);
    const hooks = createToolHookRegistry(generation, []);
    if (!hooks.ok) throw new Error(hooks.error.code);
    const effects: string[] = [];
    let confirmations = 0;
    const gateway = createProductToolGateway({
      clock,
      resources: createProductResources(clock),
      registry: registry.value,
      runner: {
        execute: async (request) => {
          effects.push(request.effect);
          return { status: "completed", output: { result: "ok" }, effect: "completed" };
        },
      },
      hooks: hooks.value,
      journal,
      correlation,
      turnId: turn,
      disclosedToolNames: new Set(["debug_evaluate"]),
      confirmation: {
        resolve: async (request) => {
          confirmations += 1;
          return { kind: "confirmed", confirmationId: request.confirmationId };
        },
      },
      effectLedger: new Map(),
    });
    const execute = (context: "watch" | "repl", suffix: string) =>
      gateway.execute({
        invocationId: invocationId.from(`inv-${suffix}`),
        toolCallId: `call-${suffix}`,
        toolName: "debug_evaluate",
        capabilityId: entry.value.manifest.capabilityId,
        version: 1,
        effect: "interactive",
        input: { context, expression: "value" },
        signal: new AbortController().signal,
      });

    expect((await execute("watch", "watch")).status).toBe("completed");
    expect(confirmations).toBe(0);
    expect((await execute("repl", "repl")).status).toBe("completed");
    expect(confirmations).toBe(1);
    expect(effects).toEqual(["observation", "interactive"]);
  });

  test("validates strict workspace inputs before dispatch and preserves plan staleness", async () => {
    const { fileSystem, tools, clock, journal } = setup();
    const hooks = createToolHookRegistry(generation, []);
    if (!hooks.ok) throw new Error(hooks.error.code);
    let runnerCalls = 0;
    const gateway = createProductToolGateway({
      clock,
      resources: createProductResources(clock),
      registry: tools.registry,
      runner: {
        execute: async (request) => {
          runnerCalls += 1;
          return tools.runner.execute(request);
        },
      },
      hooks: hooks.value,
      journal,
      correlation,
      turnId: turn,
      disclosedToolNames: new Set(["write_files", "preview_patch", "apply_patch"]),
      confirmation: {
        resolve: async (request) => ({
          kind: "confirmed",
          confirmationId: request.confirmationId,
        }),
      },
      effectLedger: new Map(),
    });
    const call = (name: string, input: Readonly<Record<string, unknown>>, id: string) => {
      const entry = tools.registry.resolveByName(name);
      if (entry === null) throw new Error(`${name} is not registered`);
      return gateway.execute({
        invocationId: invocationId.from(id),
        toolCallId: id,
        toolName: name,
        capabilityId: entry.manifest.capabilityId,
        version: entry.manifest.version,
        effect: entry.manifest.effect,
        input,
        signal: new AbortController().signal,
      });
    };

    const written = await call(
      "write_files",
      {
        targets: [
          { kind: "create", path: "one.ts", text: "export const one = 1;\n" },
          { kind: "create", path: "two.ts", text: "export const two = 2;\n" },
        ],
      },
      "inv-write-multi",
    );
    expect(written.status).toBe("completed");
    expect((await fileSystem.readText(localPath("/work/one.ts"), 1024)).ok).toBe(true);
    expect((await fileSystem.readText(localPath("/work/two.ts"), 1024)).ok).toBe(true);

    const beforeMalformed = runnerCalls;
    const malformed = await call(
      "write_files",
      {
        targets: [
          { kind: "create", path: "three.ts", text: "export const three = 3;\n" },
          { kind: "create", path: "four.ts" },
        ],
      },
      "inv-write-malformed",
    );
    expect(malformed).toEqual({
      status: "malformed",
      reason: "malformed-input",
      effect: "none",
    });
    expect(runnerCalls).toBe(beforeMalformed);
    const orphan = await fileSystem.stat(localPath("/work/three.ts"));
    expect(orphan.ok && orphan.value === null).toBe(true);

    const preview = await call(
      "preview_patch",
      {
        targets: [
          {
            path: "a.ts",
            hunks: [
              {
                oldStart: 1,
                oldLines: ["export const a = 1;"],
                newLines: ["export const a = 2;"],
              },
            ],
          },
        ],
      },
      "inv-preview",
    );
    expect(preview.status).toBe("completed");
    const previewValue =
      preview.status === "completed" &&
      preview.output.value !== null &&
      typeof preview.output.value === "object"
        ? (preview.output.value as Readonly<Record<string, unknown>>)
        : null;
    const planId = typeof previewValue?.planId === "string" ? previewValue.planId : null;
    expect(planId).toMatch(/^patch-[0-9a-f]+-\d+$/u);

    const applied = await call(
      "apply_patch",
      {
        expectedPlanId: planId,
        targets: [
          {
            path: "a.ts",
            hunks: [
              {
                oldStart: 1,
                oldLines: ["export const a = 1;"],
                newLines: ["export const a = 2;"],
              },
            ],
          },
        ],
      },
      "inv-apply",
    );
    expect(applied.status).toBe("completed");
    const patched = await fileSystem.readText(localPath("/work/a.ts"), 1024);
    expect(patched.ok && patched.value).toContain("export const a = 2;");

    const stale = await call(
      "apply_patch",
      {
        expectedPlanId: "patch-00000000-1",
        targets: [
          {
            path: "a.ts",
            hunks: [
              {
                oldStart: 1,
                oldLines: ["export const a = 1;"],
                newLines: ["export const a = 2;"],
              },
            ],
          },
        ],
      },
      "inv-apply-stale",
    );
    expect(stale.status).toBe("failed");
    expect(stale.status === "failed" ? stale.reason : null).toBe("stale-plan");
  });
});

test("live gateways share manifest capacity across registry generations and workspace bindings", async () => {
  const { tools, clock, eventStore } = setup();
  const journals: ReturnType<typeof createTurnEventJournal>[] = [];
  const resources = createProductResources(clock);
  const source = tools.registry.resolveByName("read_file");
  if (source === null) throw new Error("read_file required");
  const entry = {
    ...source,
    manifest: { ...source.manifest, concurrency: { maxGlobal: 1, maxPerWorkspace: 1 } },
  };
  let release: (() => void) | undefined;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let running = 0;
  let maximum = 0;
  let launches = 0;
  const runner = {
    async execute(request: Parameters<typeof tools.runner.execute>[0]) {
      running++;
      launches++;
      maximum = Math.max(maximum, running);
      if (launches === 1) await held;
      const result = await tools.runner.execute(request);
      running--;
      return result;
    },
  };
  const gateway = (version: number) => {
    const registry = createToolRegistry(configurationGeneration.from(version), [entry]);
    if (!registry.ok) throw new Error("registry required");
    const hooks = createToolHookRegistry(configurationGeneration.from(version), []);
    if (!hooks.ok) throw new Error("hooks required");
    const boundCorrelation = {
      ...correlation,
      configurationGeneration: configurationGeneration.from(version),
      workspaceId: workspaceId.from(`workspace-${version}`),
    };
    const journal = createTurnEventJournal({
      clock,
      eventStore,
      streamId: streamId.from(`session:gateway-${version}`),
      correlation: boundCorrelation,
    });
    journals.push(journal);
    return createProductToolGateway({
      clock,
      resources,
      registry: registry.value,
      runner,
      hooks: hooks.value,
      journal,
      correlation: {
        ...correlation,
        configurationGeneration: configurationGeneration.from(version),
        workspaceId: workspaceId.from(`workspace-${version}`),
      },
      turnId: turnId.from(`turn-${version}`),
      disclosedToolNames: new Set(["read_file"]),
      effectLedger: new Map(),
    });
  };
  const request = (id: string) => ({
    invocationId: invocationId.from(id),
    toolCallId: id,
    toolName: "read_file",
    capabilityId: entry.manifest.capabilityId,
    version: entry.manifest.version,
    effect: entry.manifest.effect,
    input: { path: "a.ts" },
    signal: new AbortController().signal,
  });
  const first = gateway(3).execute(request("first"));
  const second = gateway(4).execute(request("second"));
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(launches).toBe(1);
  release?.();
  const outcomes = await Promise.all([first, second]);
  expect(maximum).toBe(1);
  expect(outcomes).toMatchObject([
    { status: "completed", admission: { released: true } },
    { status: "completed", admission: { released: true } },
  ]);
  for (const journal of journals) {
    const replay = await journal.replay();
    if (replay.kind !== "rebuilt" && replay.kind !== "partial")
      throw new Error("journal replay required");
    const completions = replay.events.filter(
      (event) => event.kind === "capability.invocation.completed",
    );
    expect(completions.length).toBe(1);
    expect(completions.every((event) => event.payload.admission?.acquired)).toBe(true);
  }
});

test("fresh A-B-A writes execute while concurrent replays share one invocation", async () => {
  const { tools, fileSystem, clock, journal } = setup();
  const hooks = createToolHookRegistry(generation, []);
  if (!hooks.ok) throw new Error(hooks.error.code);
  let calls = 0;
  const gateway = createProductToolGateway({
    clock,
    resources: createProductResources(clock),
    registry: tools.registry,
    runner: {
      execute: async (request) => {
        calls++;
        return tools.runner.execute(request);
      },
    },
    hooks: hooks.value,
    journal,
    correlation,
    turnId: turn,
    disclosedToolNames: new Set(["write_files"]),
    confirmation: {
      resolve: async (request) => ({ kind: "confirmed", confirmationId: request.confirmationId }),
    },
    effectLedger: new Map(),
  });
  const entry = tools.registry.resolveByName("write_files");
  if (!entry) throw new Error("missing write");
  const write = (id: string, text: string) =>
    gateway.execute({
      invocationId: invocationId.from(id),
      toolCallId: id,
      toolName: "write_files",
      capabilityId: entry.manifest.capabilityId,
      version: entry.manifest.version,
      effect: entry.manifest.effect,
      input: { targets: [{ path: "a.ts", kind: "replace", text }] },
      signal: new AbortController().signal,
    });
  expect((await write("a-first", "A\n")).status).toBe("completed");
  expect((await write("b", "B\n")).status).toBe("completed");
  const repeated = await Promise.all([write("a-last", "A\n"), write("a-last", "A\n")]);
  expect(repeated.map((outcome) => outcome.status)).toEqual(["completed", "completed"]);
  expect(calls).toBe(3);
  expect(await fileSystem.readText(localPath("/work/a.ts"), 1024)).toEqual({
    ok: true,
    value: "A\n",
  });
  expect((await write("a-last", "C\n")).status).toBe("malformed");
  expect(calls).toBe(3);
});

test("uncertain invocations are retained without repeating an effect", async () => {
  const { tools, clock, journal } = setup();
  const hooks = createToolHookRegistry(generation, []);
  if (!hooks.ok) throw new Error(hooks.error.code);
  let calls = 0;
  const gateway = createProductToolGateway({
    clock,
    resources: createProductResources(clock),
    registry: tools.registry,
    runner: {
      async execute() {
        calls++;
        throw new Error("effect may have happened");
      },
    },
    hooks: hooks.value,
    journal,
    correlation,
    turnId: turn,
    disclosedToolNames: new Set(["write_files"]),
    effectLedger: new Map(),
    confirmation: {
      resolve: async (request) => ({ kind: "confirmed", confirmationId: request.confirmationId }),
    },
  });
  const entry = tools.registry.resolveByName("write_files");
  if (!entry) throw new Error("missing write");
  const request = {
    invocationId: invocationId.from("uncertain-write"),
    toolCallId: "uncertain-write",
    toolName: "write_files",
    capabilityId: entry.manifest.capabilityId,
    version: entry.manifest.version,
    effect: entry.manifest.effect,
    input: { targets: [{ path: "a.ts", kind: "replace", text: "A" }] },
    signal: new AbortController().signal,
  };
  const first = await gateway.execute(request);
  expect(first.effect).toBe("uncertain");
  expect(await gateway.execute(request)).toEqual(first);
  expect(calls).toBe(1);
});
