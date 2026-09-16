import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  ProfileTransitionOutcome,
  ProfileTransitionOwner,
  ProfileTransitionPreview,
} from "../../application/configuration/index.ts";
import {
  createStaticEnvironment,
  duration,
  modelId,
  providerId,
  sessionId,
  streamId,
} from "../../domain/foundation/index.ts";
import { localPath } from "../../domain/workspace/index.ts";
import { createHostCommandRunner } from "../../integrations/process/host-commands.ts";
import { createHostPtySessionPort } from "../../integrations/process/host-process-sessions.ts";
import { OPENAI_RESPONSES_TRANSPORT_DEFAULT, type ProviderProfile } from "../../providers/index.ts";
import { snapshotOf } from "../../tui/composer/index.ts";
import { runConfigShow } from "../commands/config.ts";
import type { GlobalOptions } from "../options.ts";
import type { EnvironmentProcessContext } from "./environment-process-context.ts";
import { processingResponse } from "./openai-processing-fixtures.ts";
import { openProductArtifactSession } from "./product-artifact-session.ts";
import {
  loadProductConfiguration,
  productConfigurationLoadRequest,
} from "./product-configuration.ts";
import {
  composeProductProviderConnections,
  type ProductProviderConnectionOptions,
} from "./product-provider-connections.ts";
import { composeProductShellAttachments } from "./product-shell-attachments.ts";
import { productWorkingProfileSessions } from "./product-working-profiles.ts";
import { createServiceProvider } from "./services.ts";

const homes: string[] = [];
afterEach(async () => {
  for (const home of homes.splice(0)) await rm(home, { recursive: true, force: true });
});

test.each([
  "turn",
  "child",
  "workflow",
  "source-edit",
  "cancelled",
  "account",
  "revoked",
  "optional",
  ...(process.platform === "win32" ? [] : ["pty"]),
] as const)(
  "real product session retains Fast A across B preparation (active work: %s)",
  async (mode) => {
    const child = mode === "child" || mode === "workflow";
    const home = await mkdtemp(join(tmpdir(), "falryn-profile-transition-"));
    homes.push(home);
    const workspace = join(home, "workspace");
    await mkdir(workspace);
    const globals: GlobalOptions = {
      color: "never",
      format: "json",
      nonInteractive: true,
      profile: null,
      quiet: false,
      timeoutMs: null,
      verbose: false,
      workspace,
      addDirs: [],
      help: false,
      version: false,
    };
    const environment: Record<string, string> = {
      FALRYN_CONFIG_DIR: join(home, "config"),
      FALRYN_STATE_DIR: join(home, "state"),
      FALRYN_PROFILE_TEST_KEY: "fixture-secret",
      FALRYN_PROFILE_TEST_KEY_B: "fixture-secret-b",
    };
    const graph = createServiceProvider(globals, {
      home: localPath(home),
      currentDirectory: localPath(workspace),
      environment: createStaticEnvironment(environment),
    })();
    const profile: ProviderProfile = {
      profileId: "account-a",
      providerId: providerId.from("openai"),
      adapterKind: "openai",
      displayName: "OpenAI",
      endpoint: "https://api.openai.com/v1",
      credential: {
        storeKind: "environment",
        locator: "FALRYN_PROFILE_TEST_KEY",
        consumer: "provider:openai",
        accountLabel: null,
      },
      organization: null,
      project: null,
      enabledModels: [modelId.from("gpt-5.6-sol")],
      modelCapabilities: [],
      discovery: "static",
      transportCompatibility: OPENAI_RESPONSES_TRANSPORT_DEFAULT,
      timeouts: { connectMs: 1000, requestMs: 10000 },
    };
    const connectionService = composeProductProviderConnections(graph, globals).service;
    for (const action of [
      { kind: "add", profile },
      { kind: "use", profileId: profile.profileId },
    ] as const)
      expect((await connectionService.execute(action)).kind).toBe("completed");
    if (mode === "account")
      expect(
        (
          await connectionService.execute({
            kind: "add",
            profile: {
              ...profile,
              profileId: "account-b",
              credential: {
                storeKind: "environment",
                locator: "FALRYN_PROFILE_TEST_KEY_B",
                consumer: "provider:openai",
                accountLabel: null,
              },
            },
          })
        ).kind,
      ).toBe("completed");
    const path = join(graph.configurationRoot, "falryn.jsonc");
    const document = JSON.parse(await readFile(path, "utf8"));
    document.defaults ??= {};
    document.defaults.models ??= {};
    document.defaults.execution = { environment: { set: { PROFILE_FIXTURE: "a" } } };
    document.defaults.models.policy = {
      processing: { mode: "fast", fallback: "allow-standard" },
      roles: {
        default: {
          providerProfileId: profile.profileId,
          providerId: "openai",
          modelId: "gpt-5.6-sol",
          reasoning: "balanced",
          budgets: { attempts: 4, outputTokens: 2000 },
        },
      },
    };
    await writeFile(path, JSON.stringify(document));
    await mkdir(join(graph.configurationRoot, "profiles"), { recursive: true });
    await writeFile(
      join(graph.configurationRoot, "profiles", "b.jsonc"),
      JSON.stringify({
        schemaVersion: 2,
        minimumReaderSchemaVersion: 2,
        overrides: {
          execution: { environment: { set: { PROFILE_FIXTURE: "b" } } },
          models: {
            policy: {
              processing: { mode: "standard" },
              ...(mode === "account"
                ? { roles: { default: { providerProfileId: "account-b" } } }
                : {}),
            },
          },
          ...(mode === "optional"
            ? { capabilities: { packages: { [`p${"a".repeat(32)}`]: { enabled: true } } } }
            : {}),
        },
      }),
    );
    const workspaceSet = await graph.ensureWorkspaceSet();
    expect(workspaceSet.ok).toBe(true);
    const configuration = await loadProductConfiguration(
      graph,
      productConfigurationLoadRequest(globals),
    );
    const data = await openProductArtifactSession(graph);
    if (!data) throw new Error("Durable fixture unavailable");
    const bodies: Record<string, unknown>[] = [];
    let environmentContext: EnvironmentProcessContext | undefined;
    const launchedValues: string[] = [];
    const captureChild = async () => {
      if (process.platform === "win32" || !environmentContext) return;
      const result = await environmentContext.commands(createHostCommandRunner()).run({
        executable: "/bin/sh",
        argv: ["-c", 'printf "%s" "$PROFILE_FIXTURE"'],
        environment: {},
        timeoutMs: duration(1000),
        maxOutputBytes: 1024,
      });
      if (result.kind !== "exited") throw new Error("Captured environment unavailable");
      launchedValues.push(result.stdout);
    };
    const authorization: (string | null)[] = [];
    let ready!: () => void;
    let release!: () => void;
    const started = new Promise<void>((resolve) => {
      ready = resolve;
    });
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const providerOptions: ProductProviderConnectionOptions = {
      modelCatalogs: data.modelCatalogs,
      providerContinuations: data.providerContinuations,

      providerFetch: async (_input, init) => {
        bodies.push(JSON.parse(String(init?.body)));
        authorization.push(new Headers(init?.headers).get("authorization"));
        if (child && bodies.length === 1) {
          const arguments_: Record<string, unknown> = {
            operation: "launch",
            required: false,
            definitionId: "builtin/falryn/agents:general",
            inputJson: JSON.stringify({ objective: "Reply with the requested result." }),
            context: [],
            capabilities: [],
            effects: ["observation"],
            limits: null,
            execution: {
              version: 1,
              attachment: "foreground",
              foregroundWaitMs: 1000,
              onSettle: "notify",
              shutdown: "drain",
            },
          };
          const toolName = mode === "workflow" ? "workflow" : "delegate";
          if (mode === "workflow") {
            for (const key of Object.keys(arguments_)) delete arguments_[key];
            Object.assign(arguments_, {
              operation: "execute",
              handle: { id: "profile-workflow", generation: "one" },
              definitionJson: JSON.stringify({
                version: 1,
                id: "user/test:profile-switch",
                label: "Profile switch",
                argumentsSchema: { type: "object", properties: {}, additionalProperties: false },
                nodes: [
                  {
                    key: "reply",
                    kind: "model",
                    instruction: "Return done as a JSON string.",
                    resultSchema: { type: "string" },
                  },
                ],
                outputs: { result: { from: "node", node: "reply" } },
              }),
              argumentsJson: "{}",
            });
          }
          const tool = (
            (bodies[0]?.tools ?? []) as {
              name: string;
              parameters: { properties: Record<string, unknown> };
            }[]
          ).find((tool) => tool.name === toolName);
          if (!tool) throw new Error("Missing delegate tool");
          if (mode === "child") {
            const limits = tool.parameters.properties.limits as {
              anyOf: { properties?: Record<string, unknown> }[];
            };
            arguments_.limits = Object.fromEntries(
              Object.keys(limits.anyOf[0]?.properties ?? {}).map((key) => [key, null]),
            );
          }
          const parameters = JSON.stringify(
            Object.fromEntries(
              Object.keys(tool.parameters.properties).map((key) => [key, arguments_[key] ?? null]),
            ),
          );
          const item = {
            id: "fc-profile",
            type: "function_call",
            call_id: "call-profile",
            name: toolName,
            arguments: parameters,
            status: "completed",
          };
          return new Response(
            [
              {
                type: "response.output_item.added",
                sequence_number: 1,
                output_index: 0,
                item: { ...item, arguments: "", status: "in_progress" },
              },
              {
                type: "response.function_call_arguments.done",
                sequence_number: 2,
                item_id: item.id,
                output_index: 0,
                arguments: parameters,
              },
              { type: "response.output_item.done", sequence_number: 3, output_index: 0, item },
              {
                type: "response.completed",
                sequence_number: 4,
                response: {
                  id: "response-parent",
                  object: "response",
                  status: "completed",
                  output: [item],
                  service_tier: "fast",
                  usage: {
                    input_tokens: 10,
                    output_tokens: 2,
                    total_tokens: 12,
                    input_tokens_details: { cached_tokens: 0 },
                    output_tokens_details: { reasoning_tokens: 0 },
                  },
                },
              },
            ]
              .map((event) => `data: ${JSON.stringify(event)}\n\n`)
              .join(""),
            { headers: { "content-type": "text/event-stream" } },
          );
        }
        if (bodies.length === (child ? 2 : 1)) {
          await captureChild();
          ready();
          await blocked;
          await captureChild();
        }
        const response = processingResponse("responses", "default");
        if (child && bodies.length === 2) {
          const text = await response.text();
          return new Response(
            text.replace(
              '"delta":"done"',
              `"delta":${JSON.stringify(JSON.stringify(mode === "workflow" ? "done" : { outcome: ["done"], evidence: [], changes: [], checks: [], unresolved: [] }))}`,
            ),
            { headers: response.headers },
          );
        }
        return response;
      },
    };
    const pty = createHostPtySessionPort();
    const openedPty =
      mode === "pty"
        ? await pty.open({
            executable: "/bin/sh",
            argv: [
              "-c",
              'printf "before:%s\\n" "$PROFILE_FIXTURE"; IFS= read line; printf "after:%s\\n" "$PROFILE_FIXTURE"',
            ],
            environment: { PROFILE_FIXTURE: "a" },
            dimensions: { columns: 80, rows: 24 },
            backlogBytes: 1024,
          })
        : null;
    if (openedPty && !openedPty.ok) throw new Error("PTY fixture unavailable");
    const processOwner: ProfileTransitionOwner = {
      id: "fixture-environment-process",
      describe: () => ({
        owner: "fixture-environment-process",
        required: true,
        availability: "available",
        applicationClass: "next-operation",
        preparation: "local",
        cost: "none",
      }),
      prepare: async () => ({
        release: async () => {},
        acknowledge: async () => ({
          state: "restart-required",
          generation: Number(configuration.generation),
          code: "running-pty-retains-environment",
        }),
      }),
    };
    const cancelledApply = new AbortController();
    let fail = true;
    let preparations = 0;
    const mcp: ProfileTransitionOwner = {
      id: "required-mcp-fixture",
      describe: () => ({
        owner: "required-mcp-fixture",
        required: true,
        availability: "available",
        applicationClass: "reconnect",
        preparation: "connection",
        cost: "none",
      }),
      async prepare() {
        preparations++;
        if (mode === "cancelled" && preparations === 2) cancelledApply.abort();
        if (fail) return { kind: "refused", code: "fixture-preparation-failed" };
        return {
          release: async () => {},
          acknowledge: async (generation) => ({
            state: "applied",
            generation,
            code: "fixture-ready",
          }),
        };
      },
    };
    const provider = await composeProductProviderConnections(graph, globals, {
      ...providerOptions,
      configuration: configuration.values,
    }).resolveSelected();
    const shell = await composeProductShellAttachments({
      workingProfileSession: async (runtime, compose, context, defer) => {
        environmentContext = context;
        return productWorkingProfileSessions(graph, globals, providerOptions, [
          mcp,
          ...(mode === "pty" ? [processOwner] : []),
        ])(runtime, compose, context, defer);
      },
      eventStore: data.eventStore,
      records: data.records,
      artifacts: data.artifacts,
      tasks: data.tasks,
      joins: data.joins,
      peers: data.peers,
      workflows: data.workflows,
      clock: graph.clock,
      fileSystem: graph.fileSystem,
      workspaceSet: graph.workspaceSet,
      configurationGeneration: configuration.generation,
      provider,
    });
    if (!shell?.submission.workingProfile) throw new Error("Profile control unavailable");
    const control = shell.submission.workingProfile;
    const signal = new AbortController().signal;
    try {
      const first = shell.submission.submit(snapshotOf("Reply briefly.", 1), {
        signal,
        payloads: { get: () => null },
      });
      await Promise.race([
        started,
        Promise.resolve(first).then(async (result) => {
          const events = await data.eventStore.readFrom(
            {
              streamId: streamId.from(`live-turn:${shell.controls.activeSessionId}`),
              afterSequence: null,
            },
            1000,
          );
          throw new Error(
            `First turn finished before preparation: ${result.kind}; ${events.ok ? events.value.at(-1)?.kind : "journal-unavailable"}`,
          );
        }),
      ]);
      if (child) {
        const parent = data.records.sessions.get(
          sessionId.from(shell.controls.activeSessionId ?? ""),
        );
        if (!parent.ok || !parent.value) throw new Error("Missing parent session");
        const children = data.records.sessions.listByParent(parent.value.workspaceId, 100);
        expect(children.ok && children.value.length).toBeGreaterThan(1);
      }
      const preview = (await control("use b", signal)) as ProfileTransitionPreview;
      expect(preview.kind).toBe("preview");
      expect(preparations).toBe(0);
      expect(bodies).toHaveLength(child ? 2 : 1);
      expect(JSON.stringify(preview)).not.toContain("fixture-secret");
      const rejected = (await control(
        `apply ${preview.candidateId}`,
        signal,
      )) as ProfileTransitionOutcome;
      expect(rejected.kind === "receipt" && rejected.receipt.publishedGeneration).toBeNull();
      fail = false;
      const accepted = (await control("use b", signal)) as ProfileTransitionPreview;
      if (mode === "source-edit") {
        const candidatePath = join(graph.configurationRoot, "profiles", "b.jsonc");
        const edited = JSON.parse(await readFile(candidatePath, "utf8"));
        edited.description = "Changed after review";
        await writeFile(candidatePath, JSON.stringify(edited));
        const stale = (await control(
          `apply ${accepted.candidateId}`,
          signal,
        )) as ProfileTransitionOutcome;
        expect(stale.kind === "receipt" && stale.receipt.publishedGeneration).toBeNull();
        const refreshed = (await control("use b", signal)) as ProfileTransitionPreview;
        Object.assign(accepted, refreshed);
      }
      if (mode === "cancelled") {
        const cancelled = (await control(
          `apply ${accepted.candidateId}`,
          cancelledApply.signal,
        )) as ProfileTransitionOutcome;
        expect(cancelled.kind === "receipt" && cancelled.receipt.publishedGeneration).toBeNull();
        const refreshed = (await control("use b", signal)) as ProfileTransitionPreview;
        Object.assign(accepted, refreshed);
      }
      const applied = (await control(
        `apply ${accepted.candidateId}`,
        signal,
      )) as ProfileTransitionOutcome;
      expect(applied.kind === "receipt" && applied.receipt.publishedGeneration).toBe(
        Number(configuration.generation) + 1,
      );
      expect(preparations).toBe(mode === "cancelled" ? 3 : 2);
      expect(bodies).toHaveLength(child ? 2 : 1);
      if (openedPty?.ok) {
        expect(pty.snapshot(openedPty.value.sessionId)?.state).toBe("running");
        pty.write(openedPty.value.sessionId, new TextEncoder().encode("finish\n"));
        const deadline = Date.now() + 2000;
        while (pty.snapshot(openedPty.value.sessionId)?.state !== "exited" && Date.now() < deadline)
          await Bun.sleep(10);
        const output = new TextDecoder().decode(
          pty.snapshot(openedPty.value.sessionId)?.replay.bytes,
        );
        expect(output).toContain("before:a");
        expect(output).toContain("after:a");
        expect(
          applied.kind === "receipt" &&
            applied.receipt.owners.find((owner) => owner.owner === processOwner.id)?.state,
        ).toBe("restart-required");
      }
      release();
      expect((await first).kind).toBe("accepted");
      if (process.platform !== "win32") expect(launchedValues).toEqual(["a", "a"]);
      expect(
        (
          await shell.submission.submit(snapshotOf("Reply again.", 2), {
            signal,
            payloads: { get: () => null },
          })
        ).kind,
      ).toBe("accepted");

      const events = await data.eventStore.readFrom(
        {
          streamId: streamId.from(`live-turn:${shell.controls.activeSessionId}`),
          afterSequence: null,
        },
        1000,
      );
      if (!events.ok) throw new Error("Missing session events");
      const requests = events.value.flatMap((event) =>
        event.kind === "model.processing.recorded" ? [event.payload.receipt] : [],
      );
      expect(requests.map((receipt) => receipt.binding.configurationGeneration)).toEqual(
        child
          ? [
              Number(configuration.generation),
              Number(configuration.generation),
              Number(configuration.generation) + 1,
            ]
          : [Number(configuration.generation), Number(configuration.generation) + 1],
      );
      expect(requests[child ? 1 : 0]?.actualMode).toBe("standard");
      const facts = events.value.filter(
        (event) => event.kind === "configuration.transition.recorded",
      );
      expect(facts.at(-1)?.payload.publishedGeneration).toBe(Number(configuration.generation) + 1);
      expect(JSON.stringify(facts)).not.toContain("fixture-secret");
      const inspected = (await control(null, signal)) as {
        current: { generation: number };
        receipt: unknown;
      };
      expect(inspected.current.generation).toBe(Number(configuration.generation) + 1);
      expect(inspected.receipt).toEqual(applied.kind === "receipt" ? applied.receipt : null);
      if (mode === "account")
        expect(authorization).toEqual(["Bearer fixture-secret", "Bearer fixture-secret-b"]);
      if (mode === "revoked") {
        delete environment.FALRYN_PROFILE_TEST_KEY;
        const count = bodies.length;
        await shell.submission.submit(snapshotOf("Must not reach the provider.", 3), {
          signal,
          payloads: { get: () => null },
        });
        expect(bodies.length).toBe(count);
      }
      if (mode === "optional")
        expect(
          accepted.inspection.issues.some((issue) => issue.kind === "package-unavailable"),
        ).toBe(true);
      if (mode === "turn") {
        const candidatePath = join(graph.configurationRoot, "profiles", "b.jsonc");
        const unchanged = (await control("use b", signal)) as ProfileTransitionPreview;
        expect(unchanged.effectiveInputChanged).toBe(false);
        const edited = JSON.parse(await readFile(candidatePath, "utf8"));
        edited.description = "First metadata reload";
        await writeFile(candidatePath, JSON.stringify(edited));
        const stale = (await control(
          `apply ${unchanged.candidateId}`,
          signal,
        )) as ProfileTransitionOutcome;
        expect(stale.kind === "refused" || stale.receipt.publishedGeneration === null).toBe(true);
        const callsBeforeReload = bodies.length;
        for (const description of ["First metadata reload", "Second metadata reload"]) {
          edited.description = description;
          await writeFile(candidatePath, JSON.stringify(edited));
          const reload = (await control("use b", signal)) as ProfileTransitionPreview;
          expect(reload.kind).toBe("preview");
          expect(reload.effectiveInputChanged).toBe(false);
          const result = (await control(
            `apply ${reload.candidateId}`,
            signal,
          )) as ProfileTransitionOutcome;
          expect(result.kind === "receipt" && result.receipt.publishedGeneration).toBe(
            reload.expectedGeneration + 1,
          );
          expect(bodies.length).toBe(callsBeforeReload);
        }
        const beforePreference = await readFile(path, "utf8");
        expect(await control("workspace b", signal)).toMatchObject({
          kind: "workspace-preference-saved",
          applies: "future-sessions",
        });
        expect(await readFile(path, "utf8")).toBe(beforePreference);
        const fresh = { ...graph, ...graph.configurationSession() };
        const selected = await loadProductConfiguration(
          fresh,
          productConfigurationLoadRequest(globals),
        );
        expect(
          selected.outcome.kind === "published" &&
            selected.outcome.record.workingProfile?.selectedBy,
        ).toBe("workspace");
        expect(
          selected.outcome.kind === "published" && selected.outcome.record.workingProfile?.id,
        ).toBe("b");
        const inspectedWorkspace = await runConfigShow(() => fresh, {}, globals, signal);
        expect(inspectedWorkspace.payload?.inspection.workingProfile?.id).toBe("b");
        const previousSession = shell.controls.activeSessionId;
        await control("workspace reset", signal);
        expect(await shell.activation.activate({ kind: "new" })).toMatchObject({
          ok: true,
        });
        expect(
          await shell.activation.activate({ kind: "resume", sessionId: previousSession ?? "" }),
        ).toMatchObject({ ok: true });
        const resumed = (await shell.submission.workingProfile?.(null, signal)) as {
          current: { generation: number };
          receipt: { profile: string };
        };
        expect(resumed.receipt.profile).toBe("b");
        expect(resumed.current.generation).toBeGreaterThan(Number(configuration.generation) + 1);
        const beforeResume = bodies.length;
        await shell.submission.submit(snapshotOf("Reply after resuming.", 4), {
          signal,
          payloads: { get: () => null },
        });
        expect(bodies.length).toBe(beforeResume + 1);
        expect(bodies.at(-1)?.service_tier).toBe("default");
      }
    } finally {
      release();
      if (openedPty?.ok) await pty.terminate(openedPty.value.sessionId);
      await shell.close();
      await data.close();
      await rm(home, { recursive: true, force: true });
    }
  },
  15000,
);

test("actual session environment reload works without a provider account", async () => {
  const home = await mkdtemp(join(tmpdir(), "falryn-environment-session-"));
  homes.push(home);
  const workspace = join(home, "workspace");
  const config = join(home, "config");
  await mkdir(workspace);
  await mkdir(config);
  const globals: GlobalOptions = {
    color: "never",
    format: "json",
    nonInteractive: true,
    profile: null,
    quiet: false,
    timeoutMs: null,
    verbose: false,
    workspace,
    addDirs: [],
    help: false,
    version: false,
  };
  const graph = createServiceProvider(globals, {
    home: localPath(home),
    currentDirectory: localPath(workspace),
    environment: createStaticEnvironment({
      FALRYN_CONFIG_DIR: config,
      FALRYN_STATE_DIR: join(home, "state"),
    }),
  })();
  const write = (value: string) =>
    writeFile(
      join(config, "falryn.jsonc"),
      JSON.stringify({
        schemaVersion: 2,
        minimumReaderSchemaVersion: 2,
        defaults: { execution: { environment: { set: { FIXTURE: value } } } },
      }),
    );
  await write("first");
  await graph.ensureWorkspaceSet();
  const configuration = await loadProductConfiguration(
    graph,
    productConfigurationLoadRequest(globals),
  );
  const data = await openProductArtifactSession(graph);
  if (!data) throw new Error("Fixture storage unavailable");
  const options = {
    workingProfileSession: productWorkingProfileSessions(graph, globals, {}),
    eventStore: data.eventStore,
    records: data.records,
    artifacts: data.artifacts,
    tasks: data.tasks,
    joins: data.joins,
    peers: data.peers,
    workflows: data.workflows,
    clock: graph.clock,
    fileSystem: graph.fileSystem,
    workspaceSet: graph.workspaceSet,
    configurationGeneration: configuration.generation,
    provider: await composeProductProviderConnections(graph, globals).resolveSelected(),
  };
  const shell = await composeProductShellAttachments(options);
  if (!shell?.submission.environment) throw new Error("Environment control unavailable");
  try {
    const first = await shell.submission.environment.execute("inspect");
    expect(first.inspection.state).toBe("active");
    await write("second");
    const reloaded = await shell.submission.environment.execute("reload");
    expect(reloaded.inspection.state).toBe("active");
    expect(reloaded.inspection.generation, JSON.stringify(reloaded)).not.toBe(
      first.inspection.generation,
    );
    expect(reloaded.transition?.kind).toBe("receipt");
    expect(JSON.stringify(reloaded)).not.toContain('"FIXTURE"');
  } finally {
    await shell.close();
    data.close();
  }
});
