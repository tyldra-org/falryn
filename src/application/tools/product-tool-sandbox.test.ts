import { expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  configurationGeneration,
  createManualClock,
  instant,
  invocationId,
  sessionId,
  streamId,
  traceId,
  turnId,
  workspaceId,
} from "../../domain/foundation/index.ts";
import {
  OFFLINE_SANDBOX_NETWORK,
  type SandboxMode,
  SINGLE_PROCESS_SANDBOX,
} from "../../domain/security/sandbox.ts";
import { createInMemoryEventStore } from "../../domain/sessions/index.ts";
import { createToolHookRegistry } from "../../domain/tools/index.ts";
import { createHostProcessCapturePort } from "../../integrations/process/host-process-capture.ts";
import { createHostSandbox } from "../../integrations/security/host-sandbox.ts";
import { createProductResources } from "../orchestration/product-resources.ts";
import { createTurnEventJournal } from "../runtime/turn-event-journal.ts";
import {
  createProductToolGateway,
  type ProductToolConfirmationPort,
} from "./product-tool-gateway.ts";
import { composeProductProcessTools } from "./product-tools-process.ts";

const strictTest = createHostSandbox().probe().status === "available" ? test : test.skip;
function fixture(root: string, mode: SandboxMode, confirmation?: ProductToolConfirmationPort) {
  const generation = configurationGeneration.from(3);
  let policyGeneration = 3;
  const clock = createManualClock(instant(Date.now()));
  const sandbox = createHostSandbox({
    now: () => Number(clock.now()),
    policy: () => ({
      generation: policyGeneration,
      mode,
      authority: mode === "off" ? "installation-compatibility" : "user",
      boundary: {
        readRoots: [],
        writeRoots: [root],
        network: OFFLINE_SANDBOX_NETWORK,
        processes: SINGLE_PROCESS_SANDBOX,
        lifecyclePaths: [],
      },
    }),
  });
  const tools = composeProductProcessTools({
    generation,
    workspaceCwd: root,
    capture: createHostProcessCapturePort({ sandbox, clock }),
  });
  const correlation = {
    workspaceId: workspaceId.from("sandbox-workspace"),
    sessionId: sessionId.from("sandbox-session"),
    traceId: traceId.from("sandbox-trace"),
    configurationGeneration: generation,
  };
  const journal = createTurnEventJournal({
    eventStore: createInMemoryEventStore(),
    clock,
    streamId: streamId.from("sandbox-stream"),
    correlation,
  });
  const hooks = createToolHookRegistry(generation, []);
  if (!hooks.ok) throw new Error(hooks.error.code);
  const gateway = createProductToolGateway({
    sandbox,
    clock,
    resources: createProductResources(clock),
    registry: tools.registry,
    runner: tools.runner,
    journal,
    correlation,
    turnId: turnId.from("sandbox-turn"),
    hooks: hooks.value,
    disclosedToolNames: new Set(["run_process"]),
    effectLedger: new Map(),
    policy: { autoAllowEffects: new Set(["observation", "mutation", "external", "interactive"]) },
    ...(confirmation === undefined ? {} : { confirmation }),
  });
  const entry = tools.registry.resolveByName("run_process");
  if (entry === null) throw new Error("missing process tool");
  return {
    journal,
    changePolicy: () => {
      policyGeneration += 1;
    },
    execute: (input: Record<string, unknown>) =>
      gateway.execute({
        invocationId: invocationId.from("sandbox-call"),
        toolCallId: "sandbox-call",
        toolName: "run_process",
        capabilityId: entry.manifest.capabilityId,
        version: 1,
        effect: entry.manifest.effect,
        input: { executable: process.execPath, outputMode: "raw", ...input },
        signal: new AbortController().signal,
      }),
  };
}

test("live tool results and journal replay disclose the compatibility boundary", async () => {
  const root = await mkdtemp(join(tmpdir(), "falryn-sandbox-gateway-"));
  try {
    const setup = fixture(root, "off");
    const outcome = await setup.execute({ argv: ["-e", 'console.log("visible-output")'] });
    expect(outcome.status).toBe("completed");
    expect(outcome.sandbox?.[0]).toMatchObject({
      effectiveMode: "off",
      state: "terminated",
      invocationId: "sandbox-call",
      catalogGeneration: 3,
      policyGeneration: 3,
    });
    expect(outcome.sandbox?.[0]?.resourceTaskId).toBeTruthy();
    const replay = await setup.journal.replay();
    expect(replay.kind).toBe("rebuilt");
    if (replay.kind !== "rebuilt") return;
    const completed = replay.events.find(
      (event) => event.kind === "capability.invocation.completed",
    );
    expect(
      completed?.kind === "capability.invocation.completed" && completed.payload.sandbox,
    ).toEqual(outcome.sandbox);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

strictTest("extra filesystem access requires a separate exact confirmation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "falryn-sandbox-expansion-"));
  const root = join(directory, "workspace");
  const extra = join(directory, "extra");
  try {
    await mkdir(root);
    await mkdir(extra);
    await writeFile(join(extra, "input"), "approved-content");
    const input = {
      argv: [
        "-e",
        `console.log(require('node:fs').readFileSync(${JSON.stringify(join(extra, "input"))},'utf8'))`,
      ],
      sandboxExpansion: { readRoots: [extra], writeRoots: [] },
    };
    expect((await fixture(root, "strict").execute(input)).status).toBe("denied");
    let confirmations = 0;
    const setup = fixture(root, "strict", {
      async resolve(request) {
        confirmations += 1;
        expect(request.title).toContain("once");
        expect(request.normalizedInput.sandboxExpansion).toEqual({
          readRoots: [await realpath(extra)],
          writeRoots: [],
        });
        return { kind: "confirmed", confirmationId: request.confirmationId };
      },
    });
    const outcome = await setup.execute(input);
    expect(confirmations).toBe(1);
    expect(outcome.sandbox?.[0]).toMatchObject({
      effectiveMode: "strict",
      expanded: true,
      state: "terminated",
    });
    expect(JSON.stringify(outcome)).toContain("approved-content");
    expect(outcome.sandbox?.[0]?.confirmationId).toStartWith("sandbox:");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

strictTest("a policy change during confirmation refuses launch", async () => {
  const root = await mkdtemp(join(tmpdir(), "falryn-sandbox-freshness-"));
  try {
    const setup = fixture(root, "strict", {
      async resolve(request) {
        setup.changePolicy();
        return { kind: "confirmed", confirmationId: request.confirmationId };
      },
    });
    const outcome = await setup.execute({
      argv: ["-e", 'throw new Error("must not run")'],
      sandboxExpansion: { readRoots: [root], writeRoots: [] },
    });
    expect(outcome.sandbox?.[0]).toMatchObject({
      state: "refused",
      pid: null,
      reason: "sandbox-stale-authority",
    });
    expect(outcome.effect).toBe("none");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
