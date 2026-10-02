import { afterEach, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCuratedCatalogs } from "../../application/extensions/curated-catalogs.ts";
import { createPackageSuggestionResolver } from "../../application/extensions/package-suggestions.ts";
import {
  catalogBytes,
  curatedDocument,
  curatedEntry,
} from "../../domain/extensions/curated-catalog-fixtures.ts";
import type { MarketplaceSource } from "../../domain/extensions/marketplace.ts";
import { configurationGeneration, createStaticEnvironment } from "../../domain/foundation/index.ts";
import { localPath } from "../../domain/workspace/filesystem/contracts.ts";
import { reduceTranscript } from "../../presentation/transcript/reducer.ts";
import { createDeterministicProviderAdapter } from "../../providers/index.ts";
import { snapshotOf } from "../../tui/composer/index.ts";
import { LIVE_TURN_MATRIX_CONFIRMATION } from "../live-turn-matrix.test-support.ts";
import type { GlobalOptions } from "../options.ts";
import { HOST_FACTS } from "./package-suggestion-configuration.ts";
import { openProductArtifactSession } from "./product-artifact-session.ts";
import { composeProductShellAttachments } from "./product-shell-attachments.ts";
import { createServiceProvider } from "./services.ts";

const homes: string[] = [];
const sessions: NonNullable<Awaited<ReturnType<typeof openProductArtifactSession>>>[] = [];
afterEach(async () => {
  for (const session of sessions.splice(0)) await session.close();
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});

const GLOBALS: GlobalOptions = {
  format: "human",
  color: "never",
  quiet: false,
  verbose: false,
  nonInteractive: false,
  workspace: null,
  addDirs: [],
  profile: null,
  timeoutMs: null,
  help: false,
  version: false,
};
const MARKET: MarketplaceSource = {
  id: "market",
  url: "https://market.example.test/catalog.json",
  enabled: true,
  maxAgeHours: 24,
};

test(
  "the terminal records one suggestion notice per settled turn and /suggestions lists the same facts",
  async () => {
    const home = await mkdtemp(join(tmpdir(), "falryn-suggestion-shell-"));
    homes.push(home);
    const root = await realpath(home);
    await mkdir(join(root, "bin"));
    const tool = join(root, "bin", "lint-tool");
    await writeFile(
      tool,
      `#!/bin/sh\nprintf '%s\\n' 'falryn-package-hint/1 {"sourceId":"market","listingId":"tools/lint","packageId":"tools-lint"}' >&2\n`,
    );
    await chmod(tool, 0o755);
    const services = createServiceProvider(
      { ...GLOBALS, workspace: root },
      {
        home: localPath(home),
        currentDirectory: localPath(root),
        environment: createStaticEnvironment({
          FALRYN_STATE_DIR: join(home, "state"),
          FALRYN_CONFIG_DIR: join(home, "config"),
        }),
      },
    )();
    const workspace = await services.ensureWorkspaceSet();
    if (!workspace.ok) throw new Error("fixture workspace unavailable");
    const history = await openProductArtifactSession(services);
    if (!history) throw new Error("history store unavailable");
    sessions.push(history);
    const catalogs = createCuratedCatalogs({
      store: history.curatedCatalogs,
      now: () => Date.now(),
      host: HOST_FACTS(),
      marketplaces: () => [MARKET],
      fetch: {
        async fetch() {
          return {
            kind: "received",
            bytes: catalogBytes(
              curatedDocument(
                [
                  {
                    ...curatedEntry("tools/lint"),
                    title: "Lint rules",
                    relevance: { files: ["*.lint.json"] },
                  },
                ],
                { source: "market" },
              ),
            ),
            fetchedAt: Date.now(),
          };
        },
      },
    });
    await catalogs.refresh("market", new AbortController().signal);

    let index = 0;
    const adapter = createDeterministicProviderAdapter({
      script: () =>
        index++ % 2 === 0
          ? {
              kind: "tool",
              name: "run_process",
              toolCallId: `lint-${index}`,
              argumentFragments: [
                JSON.stringify({ executable: tool, argv: [], outputMode: "raw" }),
              ],
            }
          : { kind: "text", text: "Lint ran." },
    });
    const model = adapter.supportedModels[0];
    if (model === undefined) throw new Error("fixture model unavailable");
    const clock = services.clock;
    const attached = await composeProductShellAttachments({
      eventStore: history.eventStore,
      artifacts: history.artifacts,
      clock,
      fileSystem: services.fileSystem,
      workspaceSet: workspace.value.set,
      configurationGeneration: configurationGeneration.from(0),
      toolConfirmation: LIVE_TURN_MATRIX_CONFIRMATION,
      packageSuggestions: () =>
        createPackageSuggestionResolver({
          catalogs,
          preferences: () => ({ sources: ["market"], dismissed: [] }),
          marketplaces: () => [MARKET],
        }),
      packageSuggestionProposals: () => ["team-market"],
      provider: {
        kind: "ready",
        adapter,
        session: {
          kind: "ready",
          release: async () => {},
          connection: {
            profile: {
              ...adapter.identity,
              adapterKind: "deterministic",
              displayName: "Suggestion fixture",
              endpoint: null,
              credential: null,
              organization: null,
              project: null,
              enabledModels: [model],
              transportCompatibility: null,
              modelCapabilities: [],
              discovery: "static",
              timeouts: { connectMs: 1_000, requestMs: 10_000 },
            },
            account: null,
            updatedAt: clock.now(),
          },
          auth: {
            profileId: adapter.identity.profileId,
            state: "ready",
            consumer: "provider:fixture",
            observedAt: clock.now(),
            health: null,
            code: null,
            retryable: false,
          },
          catalog: {
            generation: 1,
            provenance: "static-config",
            fetchedAt: clock.now(),
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
    if (attached === null) throw new Error("terminal composition unavailable");

    for (const turn of [1, 2])
      expect((await attached.submission.submit(snapshotOf(`lint ${turn}`, turn))).kind).toBe(
        "accepted",
      );
    // Two turns ran the same command; the suggestion surfaced once.
    const recorded = attached.transcriptFeed
      .events()
      .filter((event) => event.kind === "extension.suggestion.recorded");
    expect(recorded).toHaveLength(1);
    const notices = reduceTranscript(recorded).blocks.filter((block) => block.kind === "notice");
    expect(JSON.stringify(notices)).toContain("Suggested package Lint rules (market:tools/lint).");
    expect(JSON.stringify(notices)).toContain("Nothing was installed");

    const lines = (await attached.submission.listSuggestions?.()) ?? [];
    expect(lines.join("\n")).toContain("market:tools/lint · skill · Lint rules · 1.0.0");
    expect(lines.join("\n")).toContain("lint-tool's hint");
    expect(lines.join("\n")).toMatch(/Source: fetched \d{4}-/);
    expect(lines.join("\n")).toContain("Install: available after review.");
    expect(lines.join("\n")).toContain(
      "Proposed by project configuration, not enabled: team-market.",
    );
    await attached.close();
  },
  { timeout: 60_000 }, // Two live terminal turns, each running a real process.
);
