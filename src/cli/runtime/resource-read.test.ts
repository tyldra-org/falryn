import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFileAttachmentProbe } from "../../application/context/composer-context.ts";
import {
  createResourceResolver,
  resourceDigest,
} from "../../application/documents/resource-resolver.ts";
import { createProductResources } from "../../application/orchestration/product-resources.ts";
import { composeProductAgentRuntime } from "../../application/runtime/product-agent-runtime.ts";
import { createProductLiveTurnExecutor } from "../../application/runtime/product-live-turn.ts";
import { mergeProductToolBundles } from "../../application/tools/product-tools-merge.ts";
import { composeProductScratchTools } from "../../application/tools/product-tools-scratch.ts";
import { composeProductWorkspaceTools } from "../../application/tools/product-tools-workspace.ts";
import { createWorkspaceReader } from "../../application/workspace/workspace-read.ts";
import { artifactId, contentDigest } from "../../domain/artifacts/index.ts";
import {
  capabilityId,
  configurationGeneration,
  createStaticEnvironment,
  createSystemClock,
  invocationId,
  sessionId,
  streamId,
  traceId,
  turnId,
  workspaceId,
} from "../../domain/foundation/index.ts";
import { createStubCommandRunner } from "../../domain/process/index.ts";
import { createInMemoryFileSystem, localPath } from "../../domain/workspace/index.ts";
import { createDeterministicProviderAdapter, type ModelRequest } from "../../providers/index.ts";
import { createProductSubmissionPort } from "../../tui/composer/product-submission.ts";
import { snapshotOf } from "../../tui/composer/submission.ts";
import { LIVE_TURN_MATRIX_CONFIRMATION } from "../live-turn-matrix.test-support.ts";
import { openProductArtifactSession } from "./product-artifact-session.ts";
import { createServiceProvider } from "./services.ts";

const homes: string[] = [];
const closers: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const close of closers.splice(0)) await close();
  for (const home of homes.splice(0)) await rm(home, { recursive: true, force: true });
});
const text = "first α line\nexport const CANARY_845 = true;\nlast line\n";
async function fixture() {
  const home = await mkdtemp(join(tmpdir(), "falryn-resources-"));
  homes.push(home);
  const services = createServiceProvider(
    {
      color: "never",
      format: "human",
      nonInteractive: true,
      profile: null,
      quiet: false,
      timeoutMs: null,
      verbose: false,
      workspace: null,
      addDirs: [],
      help: false,
      version: false,
    },
    {
      home: localPath(home),
      platform: "darwin",
      environment: createStaticEnvironment({
        FALRYN_STATE_DIR: join(home, "state"),
        FALRYN_CONFIG_DIR: join(home, "config"),
      }),
      currentDirectory: localPath(home),
    },
  )();
  const durable = await openProductArtifactSession(services);
  if (!durable) throw new Error("durable store unavailable");
  closers.push(() => durable.close());
  const fileSystem = createInMemoryFileSystem({
    nodes: { "/workspace": { kind: "directory" }, "/workspace/file.ts": { kind: "file", text } },
  });
  const owner = sessionId.from("session-resource-845");
  const workspace = workspaceId.from("workspace-resource-845");
  const generation = configurationGeneration.from(0);
  const tools = composeProductWorkspaceTools({
    generation,
    fileSystem,
    commands: createStubCommandRunner(() => ({ kind: "exited", exitCode: 1, stdout: "" })),
    workspaceRoot: localPath("/workspace"),
    workspaceId: workspace,
    sessionId: owner,
    artifacts: durable.artifacts,
    loom: durable.loom,
    scratch: durable.scratch,
  });
  if (!tools.resources) throw new Error("resource reader missing");
  return {
    home,
    services,
    durable,
    fileSystem,
    tools,
    resources: tools.resources,
    owner,
    workspace,
    generation,
  };
}

test("virtual adapters recheck authority and retained evidence never replays the byte producer", async () => {
  const f = await fixture();
  let reads = 0;
  let allowed = true;
  const bytes = new TextEncoder().encode("retained mcp evidence\n");
  const tools = composeProductWorkspaceTools({
    generation: f.generation,
    fileSystem: f.fileSystem,
    commands: createStubCommandRunner(() => ({ kind: "exited", exitCode: 1, stdout: "" })),
    workspaceRoot: localPath("/workspace"),
    workspaceId: f.workspace,
    sessionId: f.owner,
    artifacts: f.durable.artifacts,
    loom: f.durable.loom,
    virtualResources: {
      async authorize() {
        return allowed
          ? { ok: true, value: { sensitivity: "user-content", generation: "0" } }
          : { ok: false, error: { code: "denied" } };
      },
      reader: {
        async describe(uri) {
          return {
            ok: true,
            value: {
              uri,
              mediaType: "text/plain",
              byteLength: bytes.length,
              digest: contentDigest.from(resourceDigest(bytes)),
              freshness: "snapshot",
              retention: "retained",
              exactBytes: true,
            },
          };
        },
        async readRange(_uri, offset, length) {
          reads++;
          return { ok: true, value: bytes.slice(offset, offset + length) };
        },
      },
    },
  });
  const run = (resources: unknown[]) =>
    tools.runner.execute({
      invocationId: invocationId.from("virtual-test"),
      toolCallId: "virtual",
      toolName: "read",
      capabilityId: capabilityId.from("builtin:workspace/read@1"),
      version: 1,
      effect: "observation",
      input: { resources },
      signal: new AbortController().signal,
    });
  const first = await run([{ kind: "virtual", uri: "mcp://server/resource" }]);
  expect(first.status).toBe("completed");
  const serialized = JSON.stringify(first);
  const reference = /resource-evidence-[0-9a-f-]+/u.exec(serialized)?.[0];
  expect(reference).toBeDefined();
  const repeat = await Promise.all([
    run([{ kind: "evidence", reference }]),
    run([{ kind: "evidence", reference }]),
  ]);
  expect(JSON.stringify(repeat)).toContain("retained mcp evidence");
  expect(reads).toBe(1);
  allowed = false;
  const denied = await run([{ kind: "evidence", reference }]);
  expect(JSON.stringify(denied)).toContain("denied");
  expect(JSON.stringify(denied)).not.toContain("retained mcp evidence");
});

test("native discovery and regex matches carry shared Read targets and truthful projection metadata", async () => {
  const f = await fixture();
  const run = (input: Record<string, unknown>) =>
    f.tools.runner.execute({
      invocationId: invocationId.from("search-test"),
      toolCallId: "search",
      toolName: "search",
      capabilityId: capabilityId.from("builtin:workspace/search@1"),
      version: 1,
      effect: "observation",
      input,
      signal: new AbortController().signal,
    });
  const paths = await run({ mode: "paths", query: "*.ts" });
  expect(JSON.stringify(paths)).toContain("file.ts");
  expect(JSON.stringify(paths)).toContain("readTarget");
  const regex = await run({ mode: "regex", query: "CANARY_[0-9]+" });
  expect(JSON.stringify(regex)).toContain("resource-evidence-");
  expect(JSON.stringify(regex)).toContain("unqualified-structured-format");
  expect(JSON.stringify(regex)).toContain('"exactMatchEvidence":true');
});

test("a changed search line remains discovery even if it still contains the original excerpt", async () => {
  const f = await fixture();
  const tools = composeProductWorkspaceTools({
    generation: f.generation,
    fileSystem: {
      ...f.fileSystem,
      async readText(...args) {
        const read = await f.fileSystem.readText(...args);
        await f.fileSystem.writeBytes(
          localPath("/workspace/file.ts"),
          new TextEncoder().encode(text.replace("export const", "// changed: export const")),
        );
        return read;
      },
    },
    commands: createStubCommandRunner(() => ({ kind: "exited", exitCode: 1, stdout: "" })),
    workspaceRoot: localPath("/workspace"),
    workspaceId: f.workspace,
    sessionId: f.owner,
    artifacts: f.durable.artifacts,
    loom: f.durable.loom,
  });
  const result = await tools.runner.execute({
    invocationId: invocationId.from("search-changed"),
    toolCallId: "search",
    toolName: "search",
    capabilityId: capabilityId.from("builtin:workspace/search@1"),
    version: 1,
    effect: "observation",
    input: { mode: "literal", query: "CANARY" },
    signal: new AbortController().signal,
  });
  expect(JSON.stringify(result)).toContain('"exactMatchEvidence":false');
  expect(JSON.stringify(result)).toContain('"freshness":"discovery"');
  expect(JSON.stringify(result)).toContain("// changed:");
});

test("corruption, sensitivity changes and expired metadata cannot be presented as exact recovery", async () => {
  const f = await fixture();
  const selected = await f.resources.retainSelection(
    "web:retained",
    new TextEncoder().encode(text),
    "text/plain",
  );
  if (!selected.ok || selected.value.kind !== "artifact") throw new Error("retention failed");
  const target = selected.value;
  let corrupt = false;
  let denied = false;
  let expired = false;
  const resolver = createResourceResolver({
    reader: createWorkspaceReader(f.fileSystem),
    workspaceRoot: localPath("/workspace"),
    workspaceId: f.workspace,
    sessionId: f.owner,
    generation: "0",
    loom: f.durable.loom,
    artifacts: {
      ...f.durable.artifacts,
      get(id) {
        const record = f.durable.artifacts.get(id);
        if (!record.ok || !record.value || String(id) !== target.artifactId) return record;
        return {
          ok: true,
          value: {
            ...record.value,
            sensitivity: denied ? "restricted" : record.value.sensitivity,
            availability: expired ? "missing" : record.value.availability,
          },
        };
      },
      async readRange(id, offset, length, signal) {
        const result = await f.durable.artifacts.readRange(id, offset, length, signal);
        if (!result.ok || !corrupt || String(id) !== target.artifactId) return result;
        const bytes = result.value.bytes.slice();
        bytes[0] = 0;
        return { ok: true, value: { ...result.value, bytes } };
      },
    },
  });
  const first = await resolver.read({ resources: [target] });
  if (!first.ok || first.value.items[0]?.status !== "read") throw new Error("initial read failed");
  const reference = first.value.items[0].reference;
  corrupt = true;
  expect(await resolver.read({ resources: [reference] })).toMatchObject({
    ok: true,
    value: { items: [{ code: "corrupt" }] },
  });
  corrupt = false;
  denied = true;
  expect(await resolver.read({ resources: [reference] })).toMatchObject({
    ok: true,
    value: { items: [{ code: "denied" }] },
  });
  denied = false;
  expired = true;
  expect(await resolver.read({ resources: [reference] })).toMatchObject({
    ok: true,
    value: { items: [{ code: "expired" }] },
  });
});

test("scratch revisions use the durable owner and become unavailable on discard", async () => {
  const f = await fixture();
  const bundle = mergeProductToolBundles(f.generation, [
    f.tools,
    composeProductScratchTools({
      generation: f.generation,
      scratch: f.durable.scratch,
      sessionId: f.owner,
    }),
  ]);
  const handle = `scratch://session/${f.owner}/notes`;
  const adapter = createDeterministicProviderAdapter({
    script(_request, index) {
      if (index === 0)
        return {
          kind: "tool",
          toolCallId: "scratch-write",
          name: "scratch_write",
          argumentFragments: [JSON.stringify({ name: "notes", text: "SCRATCH_845" })],
        };
      if (index === 1)
        return {
          kind: "tool",
          toolCallId: "scratch-search",
          name: "search",
          argumentFragments: [
            JSON.stringify({
              resources: [{ kind: "scratch", handle, revision: 1 }],
              query: "SCRATCH",
            }),
          ],
        };
      return { kind: "text", text: "done" };
    },
  });
  const clock = createSystemClock();
  const runtime = composeProductAgentRuntime({
    eventStore: f.durable.eventStore,
    historyArtifacts: f.durable.artifacts,
    clock,
    resources: createProductResources(clock),
    toolConfirmation: LIVE_TURN_MATRIX_CONFIRMATION,
    streamId: streamId.from("scratch-resource-turns"),
    correlation: {
      workspaceId: f.workspace,
      sessionId: f.owner,
      traceId: traceId.from("scratch-resource-trace"),
      configurationGeneration: f.generation,
    },
    providerAdapter: adapter,
    toolRegistry: bundle.registry,
    toolRunner: bundle.runner,
  });
  if (!runtime.ok) throw new Error(runtime.error.code);
  const executor = createProductLiveTurnExecutor({
    runtime: runtime.value,
    artifacts: f.durable.artifacts,
    clock,
    resources: f.resources,
    providerCatalog: {
      generation: 1,
      provenance: "static-config",
      fetchedAt: null,
      expiresAt: null,
      models: adapter.modelCapabilities ?? [],
    },
  });
  const executed = await executor.run({
    prompt: "Write scratch notes then search resources",
    turnId: turnId.from("scratch-resource-turn"),
  });
  expect({ kind: executed.kind, code: executed.code, message: executed.message }).toMatchObject({
    kind: "completed",
  });
  const read = await f.resources.read({ resources: [{ kind: "scratch", handle, revision: 1 }] });
  expect(read).toMatchObject({
    ok: true,
    value: { items: [{ status: "read", segments: [{ text: "SCRATCH_845" }] }] },
  });
  if (!read.ok || read.value.items[0]?.status !== "read") return;
  const reference = read.value.items[0].reference;
  expect(f.durable.scratch.discard(f.owner, handle, 1).ok).toBe(true);
  expect(await f.resources.read({ resources: [reference] })).toMatchObject({
    ok: true,
    value: { items: [{ code: "discarded" }] },
  });
});

test("retained resource evidence survives resolver restart and remains historical after an external write", async () => {
  const f = await fixture();
  const found = await f.resources.read({
    resources: [{ kind: "workspace", path: "file.ts" }],
    projection: { kind: "search", query: "CANARY" },
  });
  expect(found.ok).toBe(true);
  if (!found.ok) return;
  const item = found.value.items[0];
  expect(item?.status).toBe("read");
  if (item?.status !== "read") return;
  expect(item.segments[0]?.text).toContain("CANARY_845");
  expect(item.source.coverage[0]?.offset).toBe(new TextEncoder().encode("first α line\n").length);
  await f.durable.close();
  closers.shift();
  const restarted = await openProductArtifactSession(f.services);
  if (!restarted) throw new Error("restart failed");
  closers.push(() => restarted.close());
  const reopened = createResourceResolver({
    reader: createWorkspaceReader(f.fileSystem),
    artifacts: restarted.artifacts,
    loom: restarted.loom,
    workspaceRoot: localPath("/workspace"),
    workspaceId: f.workspace,
    sessionId: f.owner,
    generation: "0",
  });
  await f.fileSystem.writeBytes(
    localPath("/workspace/file.ts"),
    new TextEncoder().encode("changed\n"),
  );
  const retained = await reopened.read({
    resources: [item.reference],
    projection: { kind: "exact" },
  });
  expect(retained.ok).toBe(true);
  if (!retained.ok) return;
  expect(retained.value.items[0]).toMatchObject({
    status: "read",
    currentness: "historical",
    writable: false,
    segments: [{ text }],
  });
  const wrongRoot = createResourceResolver({
    reader: createWorkspaceReader(f.fileSystem),
    artifacts: restarted.artifacts,
    workspaceRoot: localPath("/other"),
    workspaceId: f.workspace,
    sessionId: f.owner,
    generation: "0",
  });
  expect(await wrongRoot.read({ resources: [item.reference] })).toMatchObject({
    ok: true,
    value: { items: [{ code: "wrong-scope" }] },
  });
});

test("bounded disjoint ranges, partial resources, malformed references and cancellation", async () => {
  const f = await fixture();
  const selected = await f.resources.retainSelection(
    "capture:one",
    new TextEncoder().encode(text),
    "text/plain",
  );
  expect(selected.ok).toBe(true);
  if (!selected.ok) return;
  const result = await f.resources.read({
    resources: [
      selected.value,
      { kind: "virtual", uri: "mcp://server/missing" },
      { kind: "workspace", path: "file.ts", root: "/denied" },
    ],
    projection: {
      kind: "ranges",
      ranges: [
        { offset: 0, length: 5 },
        { offset: 14, length: 6 },
      ],
    },
  });
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.value.items[0]?.status).toBe("read");
  expect(result.value.items[1]).toMatchObject({ code: "unsupported-resource-host" });
  expect(result.value.items[2]).toMatchObject({ code: "wrong-root" });
  expect(result.value.aggregateBytes).toBe(11);
  expect(
    await f.resources.read({ resources: [{ kind: "evidence", reference: "invented" }] }),
  ).toMatchObject({ ok: true, value: { items: [{ code: "invalid-reference" }] } });
  expect(
    await f.resources.read({ resources: [selected.value] }, AbortSignal.abort()),
  ).toMatchObject({ ok: true, value: { items: [{ code: "cancelled" }] } });
  const exact = await f.resources.read({ resources: [selected.value] });
  expect(exact.ok).toBe(true);
  if (!exact.ok) return;
  const item = exact.value.items[0];
  if (item?.status !== "read" || item.reference?.kind !== "evidence")
    throw new Error("missing reference");
  const record = f.durable.artifacts.get(artifactId.from(item.reference.reference));
  expect(record.ok).toBe(true);
  expect(await f.resources.read({ resources: [selected.value], maxBytes: 5 })).toMatchObject({
    ok: true,
    value: { aggregateBytes: 5, items: [{ complete: false, omissions: ["output-limit"] }] },
  });
});

test("selected file and attachment-only paste reach the real provider; stale selection never calls it", async () => {
  const f = await fixture();
  const requests: ModelRequest[] = [];
  const adapter = createDeterministicProviderAdapter({
    script: { kind: "text", text: "received" },
    onRequest: (request) => requests.push(request),
  });
  const clock = createSystemClock();
  const runtime = composeProductAgentRuntime({
    eventStore: f.durable.eventStore,
    historyArtifacts: f.durable.artifacts,
    clock,
    resources: createProductResources(clock),
    streamId: streamId.from("resource-turns"),
    correlation: {
      workspaceId: f.workspace,
      sessionId: f.owner,
      traceId: traceId.from("resource-trace"),
      configurationGeneration: f.generation,
    },
    providerAdapter: adapter,
    toolRegistry: f.tools.registry,
    toolRunner: f.tools.runner,
  });
  if (!runtime.ok) throw new Error(runtime.error.code);
  const executor = createProductLiveTurnExecutor({
    runtime: runtime.value,
    artifacts: f.durable.artifacts,
    clock,
    resources: f.resources,
    providerCatalog: {
      generation: 1,
      provenance: "static-config",
      fetchedAt: null,
      expiresAt: null,
      models: adapter.modelCapabilities ?? [],
    },
  });
  const submission = createProductSubmissionPort({
    executor,
    sessionId: f.owner,
    configurationGeneration: f.generation,
  });
  const probe = createFileAttachmentProbe({
    fileSystem: f.fileSystem,
    workspace: localPath("/workspace"),
  });
  if (!probe) throw new Error("probe unavailable");
  const attachment = await probe.inspect("file.ts");
  const outcome = await submission.submit(
    snapshotOf("Inspect the selected source", 1, [attachment]),
  );
  expect(outcome.kind).toBe("accepted");
  expect(JSON.stringify(requests[0])).toContain("CANARY_845");
  const bytes = new TextEncoder().encode("PASTE_ONLY_845\n".repeat(1200));
  const paste = {
    ...attachment,
    id: "paste1",
    kind: "paste" as const,
    identity: "paste:one",
    digest: resourceDigest(bytes),
    revision: null,
    byteLength: bytes.length,
  };
  expect(
    await submission.submit(snapshotOf("", 2, [paste]), { payloads: { get: () => bytes } }),
  ).toMatchObject({ kind: "accepted" });
  expect(JSON.stringify(requests[1])).toContain("PASTE_ONLY_845");
  expect(JSON.stringify(requests[1])).toContain("output-limit");
  const transcriptBytes = new TextEncoder().encode("TRANSCRIPT_RANGE_845");
  const transcript = {
    ...paste,
    id: "transcript1",
    kind: "transcript" as const,
    identity: "transcript:block:range",
    digest: resourceDigest(transcriptBytes),
    byteLength: transcriptBytes.length,
  };
  expect(
    await submission.submit(snapshotOf("", 3, [transcript]), {
      payloads: { get: () => transcriptBytes },
    }),
  ).toMatchObject({ kind: "accepted" });
  expect(JSON.stringify(requests[2])).toContain("TRANSCRIPT_RANGE_845");
  const retained = await f.resources.retainSelection(
    "artifact-selection",
    transcriptBytes,
    "text/plain",
  );
  if (!retained.ok || retained.value.kind !== "artifact")
    throw new Error("artifact selection failed");
  const artifact = {
    ...transcript,
    kind: "artifact" as const,
    id: "artifact1",
    identity: `artifact:${retained.value.artifactId}`,
  };
  expect(await submission.submit(snapshotOf("", 4, [artifact]))).toMatchObject({
    kind: "accepted",
  });
  expect(JSON.stringify(requests[3])).toContain("TRANSCRIPT_RANGE_845");
  expect(
    await submission.submit(snapshotOf("inspect", 5, [{ ...artifact, mediaType: "image/png" }])),
  ).toMatchObject({ kind: "unavailable" });
  expect(
    await submission.submit(snapshotOf("inspect", 6, [{ ...attachment, secret: true }])),
  ).toMatchObject({ kind: "unavailable" });
  expect(
    await submission.submit(snapshotOf("inspect", 7, [attachment]), {
      payloads: { get: () => null },
      signal: AbortSignal.abort(),
    }),
  ).toMatchObject({ kind: "unavailable" });
  await f.fileSystem.writeBytes(
    localPath("/workspace/file.ts"),
    new TextEncoder().encode("new revision"),
  );
  const draft = snapshotOf("inspect", 3, [attachment]);
  expect(await submission.submit(draft)).toMatchObject({ kind: "unavailable", snapshot: draft });
  expect(requests).toHaveLength(4);
});

test("model Search result resolves through model Read in the actual gateway continuation", async () => {
  const f = await fixture();
  const requests: ModelRequest[] = [];
  let reference: unknown;
  const adapter = createDeterministicProviderAdapter({
    onRequest: (request) => requests.push(request),
    script(request, index) {
      if (index === 0)
        return {
          kind: "tool",
          toolCallId: "search-one",
          name: "search",
          argumentFragments: [
            JSON.stringify({
              resources: [{ kind: "workspace", path: "file.ts" }],
              query: "CANARY",
            }),
          ],
        };
      if (index === 1) {
        const encoded = JSON.stringify(request);
        const match = /resource-evidence-[0-9a-f-]+/u.exec(encoded);
        if (!match) return { kind: "text", text: "missing reference" };
        reference = { kind: "evidence", reference: match[0] };
        return {
          kind: "tool",
          toolCallId: "read-one",
          name: "read",
          argumentFragments: [
            JSON.stringify({
              resources: [reference],
              projection: {
                kind: "ranges",
                ranges: [
                  { offset: 0, length: 5 },
                  { offset: 14, length: 6 },
                ],
              },
            }),
          ],
        };
      }
      return { kind: "text", text: "verified" };
    },
  });
  const clock = createSystemClock();
  const runtime = composeProductAgentRuntime({
    eventStore: f.durable.eventStore,
    historyArtifacts: f.durable.artifacts,
    clock,
    resources: createProductResources(clock),
    streamId: streamId.from("resource-gateway"),
    correlation: {
      workspaceId: f.workspace,
      sessionId: f.owner,
      traceId: traceId.from("gateway-trace"),
      configurationGeneration: f.generation,
    },
    providerAdapter: adapter,
    toolRegistry: f.tools.registry,
    toolRunner: f.tools.runner,
  });
  if (!runtime.ok) throw new Error(runtime.error.code);
  const executor = createProductLiveTurnExecutor({
    runtime: runtime.value,
    artifacts: f.durable.artifacts,
    clock,
    resources: f.resources,
    providerCatalog: {
      generation: 1,
      provenance: "static-config",
      fetchedAt: null,
      expiresAt: null,
      models: adapter.modelCapabilities ?? [],
    },
  });
  const result = await executor.run({
    prompt: "Search resources for CANARY then read exact source ranges",
    turnId: turnId.from("gateway-turn"),
  });
  expect(result.kind).toBe("completed");
  expect(result.toolResults).toBe(2);
  expect(reference).toBeDefined();
  expect(requests).toHaveLength(3);
  expect(JSON.stringify(requests[2])).toContain("per-resource");
});
