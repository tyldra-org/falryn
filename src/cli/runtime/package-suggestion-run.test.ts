import { afterAll, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCuratedCatalogs } from "../../application/extensions/curated-catalogs.ts";
import { CONFIGURATION_FILE_NAME } from "../../config/index.ts";
import { openProductStoreOrThrow } from "../../data/fixtures.ts";
import {
  catalogBytes,
  curatedDocument,
  curatedEntry,
} from "../../domain/extensions/curated-catalog-fixtures.ts";
import { createStaticEnvironment, sessionId, streamId } from "../../domain/foundation/index.ts";
import { localPath } from "../../domain/workspace/filesystem/contracts.ts";
import { createDeterministicProviderAdapter, type ModelRequest } from "../../providers/index.ts";
import { runExtensionSuggestion } from "../commands/extension-suggestion.ts";
import { runReplay } from "../commands/import-replay-commands.ts";
import { LIVE_TURN_MATRIX_CONFIRMATION } from "../live-turn-matrix.test-support.ts";
import type { GlobalOptions } from "../options.ts";
import { createRecordingCliStreams } from "../output/streams.ts";
import { runCoding } from "./coding-run.ts";
import { HOST_FACTS } from "./package-suggestion-configuration.ts";
import { openProductArtifactSession } from "./product-artifact-session.ts";
import { createServiceProvider } from "./services.ts";

const homes: string[] = [];
afterAll(async () => {
  await Promise.all(homes.map((home) => rm(home, { recursive: true, force: true })));
});

const HINT = { sourceId: "market", listingId: "tools/lint", packageId: "tools-lint" };
const MARKET_URL = "https://market.example.test/catalog.json";

async function seeded(preferences: Record<string, unknown>) {
  const home = await mkdtemp(join(tmpdir(), "falryn-suggestion-run-"));
  homes.push(home);
  const state = join(home, "state");
  const config = join(home, "config");
  const primary = join(home, "primary");
  for (const directory of [state, config, primary, join(primary, "bin")]) {
    await mkdir(directory, { recursive: true });
    await chmod(directory, 0o700);
  }
  await writeFile(
    join(config, CONFIGURATION_FILE_NAME),
    JSON.stringify({
      schemaVersion: 1,
      tools: {
        marketplaces: { sources: [{ id: "market", url: MARKET_URL }] },
        packageSuggestions: preferences,
      },
    }),
  );
  // A real admitted program: its stderr carries one hint line among ordinary output.
  const tool = join(primary, "bin", "lint-tool");
  await writeFile(
    tool,
    [
      "#!/bin/sh",
      "echo 'lint: no configuration found' >&2",
      `printf '%s\\n' 'falryn-package-hint/1 ${JSON.stringify(HINT)}' >&2`,
      "echo checked",
      "",
    ].join("\n"),
  );
  await chmod(tool, 0o755);
  const globals: GlobalOptions = {
    format: "json",
    color: "never",
    quiet: false,
    verbose: false,
    nonInteractive: true,
    workspace: primary,
    addDirs: [],
    profile: null,
    timeoutMs: null,
    help: false,
    version: false,
  };
  const services = createServiceProvider(globals, {
    home: localPath(home),
    platform: process.platform === "darwin" ? "darwin" : "linux",
    environment: createStaticEnvironment({ FALRYN_STATE_DIR: state, FALRYN_CONFIG_DIR: config }),
    currentDirectory: localPath(primary),
  });
  return { home, state, config, primary, tool, globals, services };
}

/** Stores the marketplace catalog the way a refresh does, with its dated origin. */
async function publish(services: ReturnType<typeof createServiceProvider>, entries: unknown[]) {
  const session = await openProductArtifactSession(services());
  if (session === null) throw new Error("product session unavailable");
  try {
    const refreshed = await createCuratedCatalogs({
      store: session.curatedCatalogs,
      now: () => Date.now(),
      host: HOST_FACTS(),
      marketplaces: () => [{ id: "market", url: MARKET_URL, enabled: true, maxAgeHours: 24 }],
      fetch: {
        async fetch() {
          return {
            kind: "received",
            bytes: catalogBytes(curatedDocument(entries, { source: "market" })),
            fetchedAt: Date.now(),
          };
        },
      },
    }).refresh("market", new AbortController().signal);
    expect(refreshed).toMatchObject({
      status: "refreshed",
      results: [{ receipt: { status: "imported" } }],
    });
  } finally {
    await session.close();
  }
}

function provider(tool: string | null, onRequest?: (index: number) => void) {
  const requests: ModelRequest[] = [];
  const adapter = createDeterministicProviderAdapter({
    onRequest: (request) => {
      requests.push(request);
      onRequest?.(requests.length - 1);
    },
    script: (_request, index) =>
      index === 0 && tool !== null
        ? {
            kind: "tool",
            toolCallId: "call-lint",
            name: "run_process",
            argumentFragments: [JSON.stringify({ executable: tool, argv: [], outputMode: "raw" })],
          }
        : { kind: "text", text: "Lint ran.", finishReason: "stop" },
  });
  return { adapter, requests };
}

async function run(
  home: Awaited<ReturnType<typeof seeded>>,
  tool: string | null,
  session: string,
  options: {
    /** Resume this existing session instead of starting it. */
    readonly resume?: boolean;
    readonly signal?: AbortSignal;
    readonly onRequest?: (index: number) => void;
  } = {},
) {
  const model = provider(tool, options.onRequest);
  const result = await runCoding(
    home.services,
    { promptParts: ["run the linter"], ...(options.resume ? { session } : {}) },
    {
      input: createRecordingCliStreams({ stdin: null }).input,
      globals: home.globals,
      providerAdapter: model.adapter,
      toolConfirmation: LIVE_TURN_MATRIX_CONFIRMATION,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      ...(options.resume
        ? {}
        : {
            identities: {
              sessionId: session,
              turnId: `turn-${session}`,
              traceId: `trace-${session}`,
            },
          }),
    },
  );
  return { result, requests: model.requests };
}

/** Recorded suggestion events in one session's stream. */
async function recordedCount(home: Awaited<ReturnType<typeof seeded>>, session: string) {
  const durable = await openProductArtifactSession(home.services());
  if (durable === null) throw new Error("product session unavailable");
  try {
    const events = await durable.eventStore.readFrom(
      { streamId: streamId.from(`live-turn:${session}`), afterSequence: null },
      500,
    );
    if (!events.ok) throw new Error("stream unavailable");
    return events.value.filter((event) => event.kind === "extension.suggestion.recorded").length;
  } finally {
    await durable.close();
  }
}

async function expectNothingInstalled(home: Awaited<ReturnType<typeof seeded>>) {
  const database = await openProductStoreOrThrow(localPath(home.state));
  try {
    for (const table of ["installed_packages", "package_versions", "package_operations"]) {
      const rows = database.read(`SELECT COUNT(*) AS count FROM ${table}`);
      expect(rows.ok && rows.value[0]?.count).toBe(0);
    }
  } finally {
    await database.close();
  }
}

const lintListing = (relevance: Record<string, unknown>) => ({
  ...curatedEntry("tools/lint", { versions: ["1.0.0"] }),
  title: "Lint rules",
  relevance,
});

test(
  "a real command's hint and a relevance declaration converge on one recorded, uninstalled suggestion",
  async () => {
    const home = await seeded({ sources: ["market"] });
    await publish(home.services, [lintListing({ executables: ["lint-tool"] })]);

    const { result, requests } = await run(home, home.tool, "session-suggest");
    expect(result.outcome.kind).toBe("completed");
    expect(result.payload?.suggestion).toEqual({
      version: 1,
      surfaced: expect.objectContaining({
        sourceId: "market",
        listingId: "tools/lint",
        packageId: "tools-lint",
        packageVersion: "1.0.0",
        reasons: [
          { kind: "hint", executable: "lint-tool", invocationId: expect.any(String) },
          { kind: "relevance", signal: "executable", rule: "lint-tool" },
        ],
      }),
      additional: [],
    });
    // The model saw the exact stderr, marker included; the capture was not rewritten.
    expect(JSON.stringify(requests[1])).toContain("falryn-package-hint/1");
    expect(JSON.stringify(requests[1])).toContain("lint: no configuration found");
    // Matching made no model request of its own: one tool turn, one continuation.
    expect(requests).toHaveLength(2);

    const durable = await openProductArtifactSession(home.services());
    if (durable === null) throw new Error("product session unavailable");
    const events = await durable.eventStore.readFrom(
      { streamId: streamId.from("live-turn:session-suggest"), afterSequence: null },
      200,
    );
    await durable.close();
    expect(
      events.ok && events.value.filter((e) => e.kind === "extension.suggestion.recorded"),
    ).toHaveLength(1);

    const listed = await runExtensionSuggestion(
      home.services,
      { operation: "list", sessionId: "session-suggest" },
      home.globals,
    );
    expect(listed.payload).toMatchObject({
      status: "listed",
      page: {
        status: "resolved",
        suggestions: [
          {
            listingId: "tools/lint",
            freshness: { state: "fresh" },
            install: { status: "available" },
            state: "suggested",
            handoff: {
              listing: { sourceId: "market", listingId: "tools/lint", packageVersion: "1.0.0" },
            },
          },
        ],
        refusals: [],
      },
      preferences: { sources: ["market"], dismissed: [] },
    });
    const revision =
      listed.payload?.status === "listed" ? listed.payload.preferences.revision : undefined;
    expect(typeof revision).toBe("string");

    const dismissed = await runExtensionSuggestion(
      home.services,
      {
        operation: "dismiss",
        sourceId: "market",
        packageId: "tools-lint",
        expectedRevision: revision ?? null,
      },
      home.globals,
    );
    expect(dismissed.payload).toMatchObject({ status: "dismissed", changed: true });
    // A writer holding the old revision cannot overwrite the newer preferences.
    const stale = await runExtensionSuggestion(
      home.services,
      { operation: "reset", expectedRevision: revision ?? null },
      home.globals,
    );
    expect(stale.payload).toEqual({ status: "failed", code: "suggestion-preferences-stale" });
    expect(stale.outcome.kind).toBe("failed");

    const after = await runExtensionSuggestion(
      home.services,
      { operation: "list", sessionId: "session-suggest" },
      home.globals,
    );
    expect(after.payload).toMatchObject({
      page: {
        suggestions: [
          { state: "dismissed", install: { code: "suggestion-dismissed" }, handoff: null },
        ],
      },
      preferences: { dismissed: [{ sourceId: "market", packageId: "tools-lint" }] },
    });

    // The same command in a new session surfaces nothing once dismissed.
    expect((await run(home, home.tool, "session-dismissed")).result.payload?.suggestion).toBe(
      undefined,
    );
    // Nothing was installed, staged or enabled at any point.
    const database = await openProductStoreOrThrow(localPath(home.state));
    try {
      for (const table of ["installed_packages", "package_versions", "package_operations"]) {
        const rows = database.read(`SELECT COUNT(*) AS count FROM ${table}`);
        expect(rows.ok && rows.value[0]?.count).toBe(0);
      }
    } finally {
      await database.close();
    }
  },
  { timeout: 90_000 }, // Three live product turns and five CLI actions over one SQLite home.
);

test(
  "spoofed and un-opted hints record nothing; a restarted session replays no marker",
  async () => {
    const home = await seeded({ sources: [] });
    await publish(home.services, [lintListing({ files: ["*.lint.json"] })]);
    const first = await run(home, home.tool, "session-not-opted");
    expect(first.result.outcome.kind).toBe("completed");
    expect(first.result.payload?.suggestion).toBeUndefined();

    // Opting in later never reaches back into an earlier session's output.
    await writeFile(
      join(home.config, CONFIGURATION_FILE_NAME),
      JSON.stringify({
        schemaVersion: 1,
        tools: {
          marketplaces: { sources: [{ id: "market", url: MARKET_URL }] },
          packageSuggestions: { sources: ["market"] },
        },
      }),
    );
    const resumed = await run(home, null, "session-after-opt-in");
    expect(resumed.result.payload?.suggestion).toBeUndefined();
    const listed = await runExtensionSuggestion(
      home.services,
      { operation: "list", sessionId: "session-not-opted" },
      home.globals,
    );
    expect(listed.payload).toMatchObject({
      status: "listed",
      page: { status: "resolved", suggestions: [], refusals: [] },
    });

    // A listing that names another package than the hint is refused at inspect, too.
    const spoofed = await runExtensionSuggestion(
      home.services,
      {
        operation: "inspect",
        sourceId: "market",
        listingId: "tools/lint",
        packageId: "attacker-package",
        packageVersion: null,
      },
      home.globals,
    );
    expect(spoofed.payload).toMatchObject({
      status: "inspected",
      page: { suggestions: [], refusals: [{ code: "suggestion-identity-mismatch" }] },
    });
  },
  { timeout: 90_000 }, // Two live product turns and two CLI actions over one SQLite home.
);

test(
  "a resumed or replayed session surfaces nothing from its historical output",
  async () => {
    const home = await seeded({ sources: ["market"] });
    await publish(home.services, [
      lintListing({ files: ["*.never-matched"] }),
      // Relevant to the kind of capability the command used, not to any name.
      {
        ...curatedEntry("tools/proc", { versions: ["1.0.0"] }),
        relevance: { capabilities: ["process"] },
      },
    ]);
    const first = await run(home, home.tool, "session-restart");
    expect(first.result.payload?.suggestion).toMatchObject({
      surfaced: { listingId: "tools/lint", reasons: [{ kind: "hint", executable: "lint-tool" }] },
      additional: [
        {
          listingId: "tools/proc",
          reasons: [{ kind: "relevance", signal: "capability", rule: "process" }],
        },
      ],
    });
    expect(await recordedCount(home, "session-restart")).toBe(1);

    // A resumed session starts with no observations; its stored output is never rescanned.
    const resumed = await run(home, null, "session-restart", { resume: true });
    expect(resumed.result.payload?.stage, JSON.stringify(resumed.result.errors)).toBe(
      "attempt-completed",
    );
    expect(resumed.result.payload?.sessionId).toBe("session-restart");
    expect(resumed.result.payload?.suggestion).toBeUndefined();

    const replay = await runReplay(home.services, {
      sessionId: sessionId.from("session-restart"),
    });
    expect(replay.outcome.kind).toBe("completed");
    expect(replay.payload?.effectFree).toBe(true);
    expect(await recordedCount(home, "session-restart")).toBe(1);
    await expectNothingInstalled(home);
  },
  { timeout: 90_000 }, // Two live product turns and a replay over one SQLite home.
);

test(
  "a cancelled turn records no suggestion and leaves the source command's capture intact",
  async () => {
    const home = await seeded({ sources: ["market"] });
    await publish(home.services, [lintListing({ executables: ["lint-tool"] })]);
    const controller = new AbortController();
    // Cancel once the command has run and its stderr was observed: the continuation request.
    const cancelled = await run(home, home.tool, "session-cancelled", {
      signal: controller.signal,
      onRequest: (index) => {
        if (index === 1) controller.abort();
      },
    });
    expect(cancelled.result.outcome.kind).toBe("cancelled");
    expect(cancelled.result.payload?.suggestion).toBeUndefined();
    // Cancelling ended only the subscription: the command finished and its exact output was kept.
    expect(JSON.stringify(cancelled.requests[1])).toContain("falryn-package-hint/1");
    expect(JSON.stringify(cancelled.requests[1])).toContain("checked");
    expect(await recordedCount(home, "session-cancelled")).toBe(0);
    await expectNothingInstalled(home);
  },
  { timeout: 60_000 }, // One live product turn with a real command.
);

test(
  "two concurrent dismissals cannot lose either update",
  async () => {
    const home = await seeded({ sources: ["market"] });
    const read = await runExtensionSuggestion(
      home.services,
      {
        operation: "inspect",
        sourceId: "market",
        listingId: "tools/lint",
        packageId: "tools-lint",
        packageVersion: null,
      },
      home.globals,
    );
    const revision =
      read.payload?.status === "inspected" ? read.payload.preferences.revision : null;
    expect(typeof revision).toBe("string");
    const dismiss = (packageId: string, expectedRevision: string | null) =>
      runExtensionSuggestion(
        home.services,
        { operation: "dismiss", sourceId: "market", packageId, expectedRevision },
        home.globals,
      );

    // Two sessions holding the same revision race; exactly one write can win.
    const raced = await Promise.all([dismiss("tools-a", revision), dismiss("tools-b", revision)]);
    const statuses = raced.map((result) => result.payload?.status).sort();
    expect(statuses).toEqual(["dismissed", "failed"]);
    const loser = raced.find((result) => result.payload?.status === "failed");
    expect(loser?.payload).toEqual({ status: "failed", code: "suggestion-preferences-stale" });
    const winner = raced.find((result) => result.payload?.status === "dismissed");
    if (winner?.payload?.status !== "dismissed") throw new Error("expected a winner");
    const winnerId = winner.payload.preferences.dismissed[0]?.packageId;
    const loserId = winnerId === "tools-a" ? "tools-b" : "tools-a";

    // The refused writer rereads and retries; both dismissals are kept.
    const retried = await dismiss(loserId, winner.payload.preferences.revision);
    expect(retried.payload).toMatchObject({ status: "dismissed", changed: true });
    const finalIds =
      retried.payload?.status === "dismissed"
        ? retried.payload.preferences.dismissed.map((item) => item.packageId).sort()
        : [];
    expect(finalIds).toEqual(["tools-a", "tools-b"]);
  },
  { timeout: 30_000 }, // Four CLI actions over one configuration file.
);
