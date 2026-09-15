import { afterEach, expect, test } from "bun:test";
import { createProductCheckpointAction } from "../../application/compression/product-checkpoint.ts";
import { conversationBudget } from "../../application/context/conversation-budget.ts";
import {
  reflectionBinding,
  reflectionCandidate,
  reflectionRecord,
  reflectionValue,
} from "../../application/memory/reflection.fixtures.ts";
import { createTurnEventJournal } from "../../application/runtime/turn-event-journal.ts";
import { createConversationHistoryReader } from "../../application/sessions/conversation-history.ts";
import { historyDigest } from "../../application/sessions/session-history.ts";
import { artifactId } from "../../domain/artifacts/index.ts";
import {
  configurationGeneration,
  instant,
  streamId,
  turnId,
  workspaceId,
} from "../../domain/foundation/index.ts";
import { createAnthropicSdkAdapter } from "../../integrations/index.ts";
import { toAnthropicMessages } from "../../integrations/providers/anthropic-sdk-adapter/requests.ts";
import { toGoogleMessages } from "../../integrations/providers/google-genai-sdk-adapter/requests.ts";
import {
  catalogFromAdapterModels,
  createDeterministicProviderAdapter,
  type ModelRequest,
} from "../../providers/index.ts";
import { snapshotOf } from "../../tui/composer/index.ts";
import {
  createLiveTurnMatrixFixture,
  LIVE_TURN_MATRIX_CONFIRMATION,
  LIVE_TURN_MATRIX_FINAL_TEXT,
  LIVE_TURN_MATRIX_PROMPT,
} from "../live-turn-matrix.test-support.ts";
import { createRecordingCliStreams } from "../output/streams.ts";
import { runCoding } from "./coding-run.ts";
import { createCheckpointFixture } from "./history-checkpoint.fixtures.ts";
import { composeProductShellAttachments } from "./product-shell-attachments.ts";

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
});
async function fixture() {
  const f = await createCheckpointFixture();
  cleanups.push(() => f.close());
  return f;
}
const signal = () => new AbortController().signal;

test("real checkpoint publication, repeated compaction and SQLite reopen preserve the same authorized messages", async () => {
  const f = await fixture();
  const read = () =>
    createConversationHistoryReader(f.ports).read(
      { currentTurnId: turnId.from("next") },
      f.resources,
    );
  const original = await read();
  expect(original.ok).toBe(true);
  if (!original.ok) throw new Error(original.code);
  expect(original.value.messages).toHaveLength(2);
  expect(Object.isFrozen(original.value.messages[0]?.parts)).toBe(true);
  expect(original.value.messages[0]).toMatchObject({ role: "user", parts: [{ text: f.text }] });
  for (let n = 0; n < 2; n++) {
    const preview = await f.action.run({ action: "preview" }, f.resources, signal());
    if (preview.kind === "refused") throw new Error(preview.reason);
    expect(
      (
        await f.action.run(
          { action: "apply", candidateId: preview.candidateId },
          f.resources,
          signal(),
        )
      ).kind,
    ).toBe("applied");
    const current = await read();
    if (!current.ok) throw new Error(current.code);
    expect(current.value.messages).toEqual(original.value.messages);
    expect(current.value.projectionDigest).toBe(original.value.projectionDigest);
    expect(current.value.checkpointId).toBe(preview.checkpointId);
    // A new request authority produces a new checkpoint generation over the same retained facts.
    f.authority.contextGeneration = String(n + 1);
  }
  await f.durable.close();
  const reopened = await createCheckpointFixture(f.home);
  cleanups.push(() => reopened.close());
  const restored = await createConversationHistoryReader(reopened.ports).read(
    { currentTurnId: turnId.from("reopened-next") },
    reopened.resources,
  );
  if (!restored.ok) throw new Error(restored.code);
  expect(restored.value.messages).toEqual(original.value.messages);
  expect(restored.value.checkpointId).not.toBeNull();
  reopened.revoke();
  expect(restored.value.current()).toBe(false);
  expect(
    await createConversationHistoryReader(reopened.ports).read(
      { currentTurnId: turnId.from("denied") },
      reopened.resources,
    ),
  ).toEqual({ ok: false, code: "unauthorized" });
});

test("scope, stale boundaries, cancellation and required missing retained bytes fail explicitly", async () => {
  const f = await fixture();
  const reader = createConversationHistoryReader(f.ports);
  expect(
    await reader.read({ currentTurnId: turnId.from("next"), throughSequence: 999 }, f.resources),
  ).toEqual({ ok: false, code: "stale-boundary" });
  expect(
    await createConversationHistoryReader({
      ...f.ports,
      correlation: { ...f.correlation, workspaceId: workspaceId.from("foreign") },
    }).read({ currentTurnId: turnId.from("next") }, f.resources),
  ).toEqual({ ok: false, code: "unauthorized" });
  const cancelled = new AbortController();
  cancelled.abort();
  expect(
    (await reader.read({ currentTurnId: turnId.from("next") }, f.resources, cancelled.signal)).ok,
  ).toBe(false);
  const captured = await reader.read({ currentTurnId: turnId.from("next") }, f.resources);
  if (!captured.ok) throw new Error(captured.code);
  const retained = captured.value.records[0]?.event.payload.evidence;
  if (retained?.availability !== "retained") throw new Error("fixture must retain bytes");
  const missing = createConversationHistoryReader({
    ...f.ports,
    artifacts: {
      ...f.durable.artifacts,
      get(id) {
        return String(id) === retained.artifactId
          ? { ok: true, value: null }
          : f.durable.artifacts.get(id);
      },
    },
  });
  expect(await missing.read({ currentTurnId: turnId.from("next") }, f.resources)).toEqual({
    ok: false,
    code: "missing",
  });
  expect(f.durable.artifacts.get(artifactId.from(retained.artifactId)).ok).toBe(true);
});

test("partial output is labelled, hook receipts stay inert and an incomplete tool pair cannot become success", async () => {
  const f = await fixture();
  const recorded = await f.history.record(
    f.turn,
    {
      version: 1,
      type: "message",
      id: "partial-output",
      messageId: "interrupted-answer",
      generation: 0,
      part: 1,
      role: "assistant",
      attemptId: "interrupted",
      completion: "partial",
      relations: [],
    },
    "PARTIAL_ANSWER_CANARY",
    f.resources,
  );
  expect(recorded.committed).toBe(true);
  expect(
    (
      await f.history.record(
        f.turn,
        {
          version: 1,
          type: "gate",
          id: "old-hook-receipt",
          generation: 0,
          invocationId: "old-invocation",
          proposalId: "old-proposal",
          stage: "post-hook",
          decision: "observed",
          declaredEffect: "external",
          cancelled: false,
        },
        JSON.stringify({ text: "OLD_HOOK_OUTPUT_CANARY", command: "do not execute" }),
        f.resources,
      )
    ).committed,
  ).toBe(true);
  const reader = createConversationHistoryReader(f.ports);
  const partial = await reader.read({ currentTurnId: turnId.from("next") }, f.resources);
  if (!partial.ok) throw new Error(partial.code);
  expect(JSON.stringify(partial.value.messages)).toContain("Historical partial assistant output");
  expect(JSON.stringify(partial.value.messages)).toContain("PARTIAL_ANSWER_CANARY");
  expect(JSON.stringify(partial.value.messages)).not.toContain("OLD_HOOK_OUTPUT_CANARY");
  expect(partial.value.omissions).toContainEqual({
    id: "old-hook-receipt",
    reason: "causal-evidence-retained-outside-messages",
  });
  expect(
    (
      await f.history.record(
        f.turn,
        {
          version: 1,
          type: "proposal",
          id: "pending-proposal",
          generation: 0,
          stage: "assembled",
          inputDigest: historyDigest("{}"),
          attemptId: "interrupted",
          proposalId: "pending-call",
          invocationId: null,
          name: "list_dir",
          catalogGeneration: 0,
          policyGeneration: 0,
          disclosureDigest: historyDigest("[]"),
        },
        JSON.stringify({ toolCallId: "pending-call", name: "list_dir", arguments: { path: "." } }),
        f.resources,
      )
    ).committed,
  ).toBe(true);
  expect(await reader.read({ currentTurnId: turnId.from("next") }, f.resources)).toEqual({
    ok: false,
    code: "tool-pair-incomplete",
  });
});

test("checkpoint copies cannot recover expired or corrupt originals, and admitted bytes do not change after later commits", async () => {
  const f = await fixture();
  const preview = await f.action.run({ action: "preview" }, f.resources, signal());
  if (preview.kind === "refused") throw new Error(preview.reason);
  await f.action.run({ action: "apply", candidateId: preview.candidateId }, f.resources, signal());
  const reader = createConversationHistoryReader(f.ports);
  const before = await reader.read({ currentTurnId: turnId.from("next") }, f.resources);
  if (!before.ok) throw new Error(before.code);
  const bound = JSON.stringify(before.value.messages);
  await f.history.record(
    f.turn,
    {
      version: 1,
      type: "message",
      id: "late-correction",
      generation: 1,
      messageId: "late-correction",
      part: 0,
      role: "user",
      attemptId: null,
      completion: "complete",
      relations: [],
    },
    "LATER_CORRECTION_CANARY",
    f.resources,
  );
  expect(JSON.stringify(before.value.messages)).toBe(bound);
  const next = await reader.read({ currentTurnId: turnId.from("next") }, f.resources);
  if (!next.ok) throw new Error(next.code);
  expect(JSON.stringify(next.value.messages)).toContain("LATER_CORRECTION_CANARY");
  const evidence = before.value.records[0]?.event.payload.evidence;
  if (evidence?.availability !== "retained") throw new Error("missing retained source");
  for (const state of ["missing", "quarantined"] as const) {
    const invalid = createConversationHistoryReader({
      ...f.ports,
      artifacts: {
        ...f.durable.artifacts,
        get(id) {
          const found = f.durable.artifacts.get(id);
          return String(id) === evidence.artifactId && found.ok && found.value
            ? { ok: true, value: { ...found.value, availability: state } }
            : found;
        },
      },
    });
    expect(await invalid.read({ currentTurnId: turnId.from("next") }, f.resources)).toEqual({
      ok: false,
      code: state === "missing" ? "expired" : "corrupt",
    });
  }
});

test("whole-input admission charges schemas, UTF-8 and continuation reserves and refuses unknown media cost", () => {
  const messages = [
    { role: "user" as const, parts: [{ kind: "text" as const, text: "α".repeat(10000) }] },
  ];
  const tools = [{ name: "tool", description: "schema".repeat(2000), parameters: {} }];
  const small = conversationBudget(
    messages,
    tools,
    { maxOutputTokens: 1000 },
    { contextTokens: 4096, outputTokens: 8192 },
  );
  expect(small.reason).toBe("insufficient-budget");
  expect(small.bytes).toBeGreaterThan(32000);
  expect(small.continuationTokens).toBe(1000);
  expect(
    conversationBudget(messages, tools, {}, { contextTokens: 128000, outputTokens: 8192 }).reason,
  ).toBeNull();
  expect(
    conversationBudget(
      [
        {
          role: "user",
          parts: [{ kind: "image", handle: "retained-image", mediaType: "image/png" }],
        },
      ],
      [],
      {},
      { contextTokens: 128000, outputTokens: 8192 },
    ).reason,
  ).toBe("modality-budget-unavailable");
});

test("two real headless turns consume settled tool evidence once across checkpoint and reopen", async () => {
  const f = await fixture();
  const requests: ModelRequest[] = [];
  let toolCalls = 0;
  const adapter = createDeterministicProviderAdapter({
    onRequest: (request) => requests.push(structuredClone(request)),
    script: (_request, index) => {
      if (index === 0) {
        toolCalls++;
        return {
          kind: "tool",
          toolCallId: "history-read",
          name: "list_dir",
          argumentFragments: ['{"path":"."}'],
        };
      }
      return { kind: "text", text: index === 1 ? "ASSISTANT_PRIOR_CANARY" : "continued" };
    },
  });
  const ids = {
    sessionId: "continuity-session",
    traceId: "continuity-trace",
    workspaceId: "continuity-workspace",
  };
  const run = (text: string, turn: string) =>
    runCoding(
      () => f.services,
      { promptParts: [text] },
      {
        input: createRecordingCliStreams().input,
        providerAdapter: adapter,
        identities: { ...ids, turnId: turn },
      },
    );
  const first = await run(
    "USER_PRIOR_CANARY inspect the directory. RATIONALE_CANARY: preserve original bytes. " +
      "OUTSTANDING_TASK_CANARY: the release review remains unfinished.",
    "first-live",
  );
  expect(first.payload?.stage, JSON.stringify(first.errors)).toBe("attempt-completed");
  expect(requests).toHaveLength(2);
  const stream = streamId.from(`live-turn:${ids.sessionId}`);
  const events = await f.durable.eventStore.readFrom(
    { streamId: stream, afterSequence: null },
    1000,
  );
  if (!events.ok) throw new Error(events.error.code);
  const correlation = events.value[0]?.correlation;
  if (!correlation) throw new Error("missing live correlation");
  const binding = {
    ...reflectionBinding,
    sessionId: String(correlation.sessionId),
    workspaceId: String(correlation.workspaceId),
    streamId: String(stream),
    configurationGeneration: Number(correlation.configurationGeneration),
  };
  let allowCandidate = true;
  const reflection = f.durable.openReflection(
    {
      current: () => binding,
      sourceAllowed: () => true,
      artifactAllowed: () => true,
      candidateAllowed: () => allowCandidate,
      preparedAllowed: () => true,
    },
    f.resources,
  );
  const send = (command: unknown) => reflection.execute(JSON.stringify(command));
  const pending = reflectionRecord(
    await send({
      action: "create",
      binding,
      transform: "pending-history-preparation",
      range: { first: 1, last: events.value.length },
      reason: "explicit",
    }),
  );
  expect(pending.state).toBe("due");
  const journal = createTurnEventJournal({
    eventStore: f.durable.eventStore,
    streamId: stream,
    correlation,
    clock: f.services.clock,
  });
  const authority = {
    ...f.authority,
    protectedRequest: JSON.stringify(requests[0]),
    instructionDigest: historyDigest(JSON.stringify(requests[0])),
    systemAndSkillsTokens: Math.ceil(Buffer.byteLength(JSON.stringify(requests[0])) / 4),
  };
  const action = createProductCheckpointAction({
    ...f.ports,
    correlation,
    streamId: stream,
    journal,
    authority: () => authority,
  });
  const preview = await action.run({ action: "preview" }, f.resources, signal());
  if (preview.kind === "refused") throw new Error(preview.reason);
  expect(
    (await action.run({ action: "apply", candidateId: preview.candidateId }, f.resources, signal()))
      .kind,
  ).toBe("applied");
  const second = await run(
    "USER_CURRENT_CANARY CORRECTION_CANARY: the release review moved to tomorrow; it is still unfinished.",
    "second-live",
  );
  expect(second.payload?.stage, JSON.stringify(second.errors)).toBe("attempt-completed");
  expect(requests).toHaveLength(3);
  const next = requests[2];
  if (!next) throw new Error("missing next request");
  expect(
    next?.messages
      .filter((message) => message.role === "user")
      .map((message) => JSON.stringify(message))
      .join("\n"),
  ).toContain("USER_PRIOR_CANARY");
  expect(
    next?.messages
      .filter((message) => message.role === "assistant")
      .map((message) => JSON.stringify(message))
      .join("\n"),
  ).toContain("ASSISTANT_PRIOR_CANARY");
  expect(JSON.stringify(next).match(/USER_CURRENT_CANARY/g)).toHaveLength(1);
  expect(next?.messages.filter((message) => message.role === "tool")).toHaveLength(1);
  expect(
    next?.messages.flatMap((message) => message.toolCalls ?? []).map((call) => call.toolCallId),
  ).toEqual(["history-read"]);
  expect(toolCalls).toBe(1);
  expect(JSON.stringify(next)).not.toContain(f.text);
  const leased = reflectionValue(
    await send({ action: "lease", id: pending.id, durationMs: 10000, process: null }),
  );
  if (leased.kind !== "record" || !leased.fence) throw new Error("missing reflection fence");
  const candidate = reflectionRecord(
    await send({
      action: "publish",
      id: pending.id,
      fence: leased.fence,
      publicationId: "history-candidate",
      range: pending.range,
      disposition: "processed",
      prepared: null,
      candidates: [
        {
          ...reflectionCandidate,
          sources: [String(events.value.at(-1)?.eventId)],
          content: "UNREVIEWED_MEMORY_CANARY",
        },
      ],
    }),
  );
  expect(candidate.candidates).toHaveLength(1);
  allowCandidate = false;
  const google = toGoogleMessages(next.messages, new Map());
  expect(JSON.stringify(google.contents)).toContain('"functionCall":{"id":"history-read"');
  expect(JSON.stringify(google.contents)).toContain('"functionResponse":{"id":"history-read"');
  const anthropic = createAnthropicSdkAdapter({
    profileId: "history-conversion",
    supportedModels: ["claude-test"],
    resolveApiKey: async () => null,
  });
  const compatibility = anthropic.transportCompatibility?.declaration;
  if (compatibility?.dialect !== "anthropic-messages")
    throw new Error("missing Anthropic declaration");
  const translated = toAnthropicMessages(next.messages, undefined, compatibility, new Map());
  expect(JSON.stringify(translated.messages)).toContain('"tool_use_id":"history-read"');
  expect(JSON.stringify(translated.messages)).toContain("ASSISTANT_PRIOR_CANARY");
  const secondPreview = await action.run({ action: "preview" }, f.resources, signal());
  if (secondPreview.kind === "refused") throw new Error(secondPreview.reason);
  expect(
    (
      await action.run(
        { action: "apply", candidateId: secondPreview.candidateId },
        f.resources,
        signal(),
      )
    ).kind,
  ).toBe("applied");
  const third = await run("THIRD_TURN_CANARY the correction still applies", "third-live");
  expect(third.payload?.stage, JSON.stringify(third.errors)).toBe("attempt-completed");
  expect(JSON.stringify(requests[3]?.messages)).not.toContain("UNREVIEWED_MEMORY_CANARY");
  for (const canary of ["RATIONALE_CANARY", "OUTSTANDING_TASK_CANARY", "CORRECTION_CANARY"])
    expect(JSON.stringify(requests[3]?.messages)).toContain(canary);
  expect(
    requests[3]?.messages
      .filter((message) => message.role !== "system")
      .slice(0, next.messages.filter((message) => message.role !== "system").length - 1),
  ).toEqual(next.messages.filter((message) => message.role !== "system").slice(0, -1));
  expect(toolCalls).toBe(1);
  const catalog = catalogFromAdapterModels(adapter.supportedModels, {
    generation: 0,
    fetchedAt: instant(0),
    capabilities: adapter.modelCapabilities,
  });
  const refused = await runCoding(
    () => f.services,
    { promptParts: ["SMALL_WINDOW_CURRENT"] },
    {
      input: createRecordingCliStreams().input,
      providerAdapter: adapter,
      identities: { ...ids, turnId: "small-window" },
      providerCatalog: {
        ...catalog,
        models: catalog.models.map((model) => ({
          ...model,
          contextTokens: 1024,
          outputTokens: 256,
        })),
      },
    },
  );
  expect(refused.payload?.stage).toBe("attempt-failed");
  expect(JSON.stringify(refused.errors)).toContain("history.insufficient-budget");
  expect(requests).toHaveLength(4);
});

test("the interactive host consumes prior input, answer and stable tool results after repeated compaction without replaying effects", async () => {
  const f = await fixture();
  await f.services.ensureWorkspaceSet();
  const matrix = createLiveTurnMatrixFixture(f.durable.artifacts, "history-tui-capture");
  const adapter = matrix.provider;
  const profile = {
    ...adapter.identity,
    endpoint: null,
    credential: null,
    organization: null,
    project: null,
    enabledModels: [...adapter.supportedModels],
    transportCompatibility: null,
    modelCapabilities: [],
    discovery: "static" as const,
    timeouts: { connectMs: 1000, requestMs: 10000 },
  };
  const attached = await composeProductShellAttachments({
    eventStore: f.durable.eventStore,
    clock: f.services.clock,
    fileSystem: f.services.fileSystem,
    workspaceSet: f.services.workspaceSet,
    configurationGeneration: configurationGeneration.from(0),
    artifacts: f.durable.artifacts,
    loom: f.durable.loom,
    scratch: f.durable.scratch,
    processCapture: matrix.processCapture,
    toolConfirmation: LIVE_TURN_MATRIX_CONFIRMATION,
    provider: {
      kind: "ready",
      adapter,
      session: {
        kind: "ready",
        release: async () => {},
        connection: { profile, account: null, updatedAt: f.services.clock.now() },
        auth: {
          profileId: adapter.identity.profileId,
          state: "ready",
          consumer: "provider:history",
          observedAt: instant(0),
          health: null,
          code: null,
          retryable: false,
        },
        catalog: catalogFromAdapterModels(adapter.supportedModels, {
          generation: 0,
          fetchedAt: instant(0),
          capabilities: adapter.modelCapabilities,
        }),
      },
    },
  });
  if (!attached) throw new Error("interactive host unavailable");
  expect((await attached.submission.submit(snapshotOf(LIVE_TURN_MATRIX_PROMPT, 1))).kind).toBe(
    "accepted",
  );
  expect(matrix.captures).toBe(1);
  for (let n = 0; n < 2; n++) {
    const preview = await attached.submission.compact?.(null, signal());
    const id = preview?.message.match(/Checkpoint preview: ([a-f0-9-]+)\./u)?.[1];
    expect(id, preview?.message).toBeDefined();
    expect((await attached.submission.compact?.(`apply ${id}`, signal()))?.message).toContain(
      "Checkpoint applied:",
    );
    const result = await attached.submission.submit(
      snapshotOf(`FOLLOWUP_${n} preserve my latest correction and unfinished task`, n + 2),
    );
    expect(result.kind, JSON.stringify(result)).toBe("accepted");
    const request = matrix.requests.at(-1);
    if (!request) throw new Error("missing provider request");
    expect(
      request.messages
        .filter((message) => message.role === "user")
        .some((message) => JSON.stringify(message).includes(LIVE_TURN_MATRIX_PROMPT)),
    ).toBe(true);
    expect(
      request.messages
        .filter((message) => message.role === "assistant")
        .some((message) => JSON.stringify(message).includes(LIVE_TURN_MATRIX_FINAL_TEXT)),
    ).toBe(true);
    expect(request.messages.filter((message) => message.role === "tool")).toHaveLength(1);
    expect(matrix.captures).toBe(1);
  }
  expect(matrix.requests[3]?.messages.filter((message) => message.role === "tool")).toEqual(
    matrix.requests[2]?.messages.filter((message) => message.role === "tool"),
  );
  expect(await attached.sessionCreation.create()).toMatchObject({ ok: true });
  expect((await attached.submission.submit(snapshotOf("FOREIGN_SESSION_FRESH", 5))).kind).toBe(
    "accepted",
  );
  expect(JSON.stringify(matrix.requests.at(-1))).not.toContain("FOLLOWUP_0");
  expect(JSON.stringify(matrix.requests.at(-1))).not.toContain(LIVE_TURN_MATRIX_FINAL_TEXT);
});

test("persisted parallel tool groups retain pairing, and duplicate identities refuse conversion", async () => {
  const f = await fixture();
  for (const id of ["parallel-a", "parallel-b"]) {
    const written = await f.history.record(
      f.turn,
      {
        version: 1,
        type: "proposal",
        id,
        generation: 0,
        stage: "assembled",
        inputDigest: historyDigest("{}"),
        attemptId: "parallel-attempt",
        proposalId: id,
        invocationId: null,
        name: "list_dir",
        catalogGeneration: 0,
        policyGeneration: 0,
        disclosureDigest: historyDigest("[]"),
      },
      JSON.stringify({ toolCallId: id, name: "list_dir", arguments: { path: "." } }),
      f.resources,
    );
    expect(written.committed).toBe(true);
  }
  for (const id of ["parallel-a", "parallel-b"]) {
    const written = await f.history.record(
      f.turn,
      {
        version: 1,
        type: "result",
        id: `${id}-result`,
        generation: 0,
        proposalId: id,
        invocationId: null,
        capabilityId: null,
        status: "completed",
        effect: "none",
        reason: "",
        relations: [],
      },
      JSON.stringify({ evidence: `EXACT_${id}` }),
      f.resources,
    );
    expect(written.committed).toBe(true);
  }
  const reader = createConversationHistoryReader(f.ports);
  const read = await reader.read({ currentTurnId: turnId.from("next") }, f.resources);
  if (!read.ok) throw new Error(read.code);
  expect(read.value.messages.filter((message) => message.toolCalls)).toHaveLength(1);
  expect(read.value.messages.find((message) => message.toolCalls)?.toolCalls).toHaveLength(2);
  expect(read.value.messages.filter((message) => message.role === "tool")).toHaveLength(2);
  expect(() => toGoogleMessages(read.value.messages, new Map())).not.toThrow();
  const prior = read.value.records.find((record) => record.event.payload.id === "parallel-a");
  if (!prior) throw new Error("missing proposal");
  const repeated = await f.history.record(
    turnId.from("other-turn"),
    {
      ...prior.event.payload,
      id: "repeated-call",
    },
    prior.text,
    f.resources,
  );
  expect(repeated.committed).toBe(true);
  expect(await reader.read({ currentTurnId: turnId.from("next") }, f.resources)).toEqual({
    ok: false,
    code: "duplicate-tool-call",
  });
});
