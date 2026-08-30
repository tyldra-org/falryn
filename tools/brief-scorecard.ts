#!/usr/bin/env bun
/** Live matched Brief/Caveman response-density scorecard (#827). */

import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import {
  CAVEMAN_ADAPTER_VERSION,
  CAVEMAN_PINNED_COMMIT,
  CAVEMAN_PINNED_SKILL_DIGEST,
  type CavemanSourcePort,
  composeProductCredentials,
  loadPinnedCavemanPolicy,
  resolveProviderApiKey,
} from "../src/application/index.ts";
import { runCoding } from "../src/cli/coding-run.ts";
import type { GlobalOptions } from "../src/cli/options.ts";
import { createServiceProvider } from "../src/cli/services.ts";
import { createRecordingCliStreams } from "../src/cli/streams.ts";
import {
  BRIEF_STRATEGY_VERSION,
  type BriefComparisonArm,
  type BriefComparisonMatch,
  type BriefComparisonPair,
  type BriefComparisonUsage,
  compareBriefPair,
  createStaticEnvironment,
  createSystemClock,
  instant,
  localPath,
  ok,
  type PromptSectionInput,
} from "../src/domain/index.ts";
import {
  createCommandCodeProviderAdapter,
  createHostCommandRunner,
  createHostEnvironment,
  createOpenAiSdkAdapter,
  hostPlatform,
} from "../src/integrations/index.ts";
import {
  COMMAND_CODE_OPENAI_BASE_URL,
  COMMAND_CODE_PROVIDER_ID,
  capabilityFromDeclaration,
  catalogFromAdapterModels,
  knownModelCapability,
  type ModelCatalog,
  type ModelRequest,
  type ProviderAdapterKind,
  type ProviderAdapterPort,
  providerCredentialEnvironment,
  providerEnvironmentCredentialReference,
} from "../src/providers/index.ts";
import {
  BRIEF_RESPONSE_FIXTURES,
  type BriefResponseFixture,
} from "./fixtures/brief-response-corpus.ts";

const RESPONSE_TOKENIZER = "utf8-bytes-div4.v1";
const DEFAULT_OUTPUT_LIMIT = 2_048;
const MAX_REPETITIONS = 4;
const DEFAULT_OPENAI_MODEL = "gpt-4o-mini";
const DEFAULT_COMMAND_CODE_MODEL = "MiniMaxAI/MiniMax-M3";
const BRIEF_SCORECARD_SCHEMA_VERSION = 2;

type ScorecardProviderId = "openai" | "commandcode";

type ScorecardProvider = {
  readonly adapter: ProviderAdapterPort;
  readonly catalog: ModelCatalog;
  readonly model: string;
};

type Options = {
  readonly format: "human" | "json";
  readonly repetitions: number;
  readonly cavemanRoot: string;
  readonly output: string | null;
  readonly fixture: string | null;
};

export type ScorecardReport = {
  readonly schemaVersion: typeof BRIEF_SCORECARD_SCHEMA_VERSION;
  readonly generatedAt: string;
  readonly baseline: {
    readonly commit: string;
    readonly sourceDigest: string;
    readonly adapterVersion: string;
  };
  readonly provider: { readonly id: string; readonly model: string };
  readonly settings: {
    readonly repetitions: number;
    readonly outputTokenLimit: number;
    readonly responseTokenizer: string;
    readonly concurrency: 1;
    readonly toolExposure: "none";
  };
  readonly attempts: readonly BriefComparisonArm[];
  readonly pairs: readonly BriefComparisonPair[];
  readonly results: readonly ReturnType<typeof compareBriefPair>[];
  readonly summary: {
    readonly total: number;
    readonly passed: number;
    readonly tied: number;
    readonly lost: number;
    readonly invalid: number;
    readonly accepted: number;
    readonly partial: boolean;
    readonly complete: boolean;
  };
};

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function estimatedTokens(value: string): number {
  return Math.ceil(utf8Bytes(value) / 4);
}

/** Ignore presentation-only differences while preserving wording, order, and punctuation. */
export function responseContainsBriefFact(response: string, fact: string): boolean {
  const normalize = (value: string) =>
    value
      .normalize("NFKC")
      .replace(/[`*]/g, "")
      .replace(/\s+/g, " ")
      .trim()
      .toLocaleLowerCase("en-US");
  return normalize(response).includes(normalize(fact));
}

function withoutResponsePolicy(text: string): string {
  return text.replace(/\n?\n?\[brief source=[^\]]+\]\n[\s\S]*$/u, "");
}

function commonInstructionDigest(requests: readonly ModelRequest[]): string {
  return digest(
    JSON.stringify(
      requests.map((request) => ({
        messages: request.messages.map((message) => ({
          ...message,
          parts: message.parts.map((part) =>
            part.kind === "text" ? { ...part, text: withoutResponsePolicy(part.text) } : part,
          ),
        })),
        tools: request.tools,
        output: request.output,
        budgets: request.budgets,
        metadata: request.metadata,
      })),
    ),
  );
}

function parseOptions(argv: readonly string[]): Options {
  let format: Options["format"] = "human";
  let repetitions = 2;
  let cavemanRoot = resolve(process.cwd(), "../falryn-references/research/ref_repo/caveman");
  let output: string | null = null;
  let fixture: string | null = null;
  for (const argument of argv) {
    if (argument === "--format=json") format = "json";
    else if (argument === "--format=human") format = "human";
    else if (argument.startsWith("--repetitions=")) {
      repetitions = Number(argument.slice("--repetitions=".length));
    } else if (argument.startsWith("--caveman-root=")) {
      cavemanRoot = resolve(argument.slice("--caveman-root=".length));
    } else if (argument.startsWith("--output=")) {
      output = resolve(argument.slice("--output=".length));
    } else if (argument.startsWith("--fixture=")) {
      fixture = argument.slice("--fixture=".length);
    } else {
      throw new Error(`unsupported argument: ${argument}`);
    }
  }
  if (!Number.isInteger(repetitions) || repetitions < 1 || repetitions > MAX_REPETITIONS) {
    throw new Error(`repetitions must be an integer from 1 to ${MAX_REPETITIONS}`);
  }
  return { format, repetitions, cavemanRoot, output, fixture };
}

function gitSource(root: string): CavemanSourcePort {
  return {
    async read(input) {
      if (input.signal?.aborted === true) {
        return { ok: false, error: { code: "cancelled", detail: "cancelled" } };
      }
      const process = Bun.spawn(["git", "-C", root, "show", `${input.commit}:${input.path}`], {
        stdout: "pipe",
        stderr: "ignore",
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      });
      const [content, exitCode] = await Promise.all([
        new Response(process.stdout).text(),
        process.exited,
      ]);
      return exitCode === 0
        ? ok({ commit: input.commit, content })
        : {
            ok: false,
            error: { code: "unavailable" as const, detail: `git show exited ${exitCode}` },
          };
    },
  };
}

function providerCatalog(
  adapter: ProviderAdapterPort,
  adapterKind: ProviderAdapterKind,
  provider: string,
  model: string,
  baseUrl: string,
): ModelCatalog {
  const declaration = knownModelCapability(adapterKind, model, baseUrl, provider);
  if (declaration === null) {
    throw new Error(
      `Brief scorecard requires a source-verified ${provider} capability declaration for ${model}`,
    );
  }
  return catalogFromAdapterModels(adapter.supportedModels, {
    generation: 1,
    fetchedAt: instant(Date.now()),
    capabilities: [
      capabilityFromDeclaration(declaration, {
        availability: "available",
        provenance: ["provider-manifest"],
      }),
    ],
  });
}

async function requiredCredential(
  environment: Readonly<Record<string, string | undefined>>,
  provider: ScorecardProviderId,
  useHostSession: boolean,
): Promise<string> {
  const names = providerCredentialEnvironment(provider)?.variables;
  if (names === undefined) {
    throw new Error(`Brief scorecard has no credential environment declaration for ${provider}`);
  }
  const staticValues = Object.fromEntries(
    Object.entries(environment).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );
  const environmentPort = useHostSession
    ? createHostEnvironment()
    : createStaticEnvironment(staticValues);
  const credentials = composeProductCredentials({
    clock: createSystemClock(),
    commands: createHostCommandRunner(),
    platform: hostPlatform(),
    environment: environmentPort,
    ...(useHostSession ? {} : { sessionEnvironment: null }),
  });
  const reference = providerEnvironmentCredentialReference(provider, "brief-scorecard");
  const value = await resolveProviderApiKey(credentials.resolver, reference);
  if (value === null) {
    throw new Error(`${names.join(" or ")} is required for matched live runs`);
  }
  return value;
}

/** Resolve one source-verified provider/model pair for a matched live scorecard. */
export async function createBriefScorecardProvider(
  suppliedEnvironment?: Readonly<Record<string, string | undefined>>,
): Promise<ScorecardProvider> {
  const environment = suppliedEnvironment ?? process.env;
  const configuredProvider = environment.FALRYN_BRIEF_PROVIDER ?? "openai";
  if (configuredProvider !== "openai" && configuredProvider !== "commandcode") {
    throw new Error(`unsupported Brief scorecard provider: ${configuredProvider}`);
  }
  const provider: ScorecardProviderId = configuredProvider;
  if (provider === "commandcode") {
    const apiKey = await requiredCredential(
      environment,
      provider,
      suppliedEnvironment === undefined,
    );
    const model = environment.FALRYN_BRIEF_MODEL ?? DEFAULT_COMMAND_CODE_MODEL;
    const adapter = createCommandCodeProviderAdapter({
      profileId: "brief-scorecard",
      resolveApiKey: async () => apiKey,
      supportedModels: [model],
    });
    return {
      adapter,
      catalog: providerCatalog(
        adapter,
        "commandcode",
        COMMAND_CODE_PROVIDER_ID,
        model,
        COMMAND_CODE_OPENAI_BASE_URL,
      ),
      model,
    };
  }
  const apiKey = await requiredCredential(environment, provider, suppliedEnvironment === undefined);
  const model = environment.FALRYN_BRIEF_MODEL ?? DEFAULT_OPENAI_MODEL;
  const baseUrl = (environment.FALRYN_OPENAI_BASE_URL ?? "https://api.openai.com/v1").replace(
    /\/+$/,
    "",
  );
  const adapter = createOpenAiSdkAdapter({
    profileId: "brief-scorecard",
    baseUrl,
    resolveApiKey: async () => apiKey,
    supportedModels: [model],
  });
  return {
    adapter,
    catalog: providerCatalog(adapter, "openai", "openai", model, baseUrl),
    model,
  };
}

function globals(workspace: string): GlobalOptions {
  return {
    format: "json",
    color: "never",
    quiet: false,
    verbose: false,
    nonInteractive: true,
    workspace,
    addDirs: [],
    profile: null,
    timeoutMs: 120_000,
    help: false,
    version: false,
  };
}

function usageOf(value: BriefComparisonArm["usage"] | undefined): BriefComparisonUsage | null {
  return value ?? null;
}

async function runArm(input: {
  readonly fixture: BriefResponseFixture;
  readonly policy: "brief" | "caveman";
  readonly policyMode: string;
  readonly policyDigest: string;
  readonly guidance: string;
  readonly order: 1 | 2;
  readonly match: BriefComparisonMatch;
  readonly adapter: ProviderAdapterPort;
  readonly providerCatalog: ModelCatalog;
  readonly root: string;
  readonly workspace: string;
  readonly signal: AbortSignal;
  readonly responsePolicySection?: PromptSectionInput;
}): Promise<BriefComparisonArm> {
  const runRoot = join(input.root, `${input.fixture.id}-${input.policy}-${randomUUID()}`);
  const state = join(runRoot, "state");
  const config = join(runRoot, "config");
  await mkdir(state, { recursive: true });
  await mkdir(config, { recursive: true });
  const environment = createStaticEnvironment({
    FALRYN_STATE_DIR: state,
    FALRYN_CONFIG_DIR: config,
  });
  const serviceProvider = createServiceProvider(globals(input.workspace), {
    environment,
    home: localPath(runRoot),
    platform: hostPlatform(),
    currentDirectory: localPath(input.workspace),
  });
  const streams = createRecordingCliStreams();
  const providerRequests: ModelRequest[] = [];
  const adapter: ProviderAdapterPort = {
    ...input.adapter,
    stream(request, options) {
      providerRequests.push(request);
      return input.adapter.stream(request, options);
    },
  };
  const startedAt = performance.now();
  const result = await runCoding(
    serviceProvider,
    {
      promptParts: [input.fixture.prompt],
      brief: input.fixture.briefMode,
      mode: "ask",
    },
    {
      input: streams.input,
      signal: input.signal,
      providerAdapter: adapter,
      providerCatalog: input.providerCatalog,
      maxOutputTokensOverride: DEFAULT_OUTPUT_LIMIT,
      toolExposureOverride: "none",
      identities: {
        sessionId: `brief-scorecard-${randomUUID()}`,
        turnId: `brief-scorecard-${randomUUID()}`,
        traceId: `brief-scorecard-${randomUUID()}`,
        workspaceId: "brief-scorecard",
      },
      ...(input.responsePolicySection === undefined
        ? {}
        : {
            responsePolicyOverride: {
              section: input.responsePolicySection,
              maxOutputTokens: DEFAULT_OUTPUT_LIMIT,
            },
          }),
    },
  );
  const wallTimeMs = performance.now() - startedAt;
  streams.dispose();
  const response = result.payload?.response ?? "";
  const preservedFacts = input.fixture.requiredFacts.filter((fact) =>
    responseContainsBriefFact(response, fact),
  );
  const missingFacts = input.fixture.requiredFacts.filter(
    (fact) => !responseContainsBriefFact(response, fact),
  );
  const unsupportedClaims = input.fixture.forbiddenClaims.filter((fact) =>
    responseContainsBriefFact(response, fact),
  ).length;
  const providerUsage = result.payload?.providerUsage;
  const briefReceipt = result.payload?.briefReceipt;
  const toolResults = result.payload?.toolResults ?? 0;
  const reportedProviderRequests = result.payload?.providerRequests ?? 0;
  const exposedProviderTools = providerRequests.some((request) => request.tools.length > 0);
  const terminal =
    result.outcome.kind === "cancelled"
      ? "cancelled"
      : toolResults > 0 ||
          exposedProviderTools ||
          reportedProviderRequests !== providerRequests.length
        ? "partial"
        : result.payload?.stage === "attempt-completed"
          ? "completed"
          : "provider-failure";
  return {
    policy: input.policy,
    policyMode: input.policyMode,
    delivery: input.policy === "brief" ? (briefReceipt?.delivery ?? "prompt") : "prompt",
    providerResponseDensityControl:
      input.policy === "brief" ? (briefReceipt?.providerResponseDensityControl ?? null) : null,
    policyDigest:
      input.policy === "brief"
        ? (briefReceipt?.guidanceDigest ?? input.policyDigest)
        : input.policyDigest,
    guidanceBytes:
      input.policy === "brief"
        ? (briefReceipt?.byteLength ?? utf8Bytes(input.guidance))
        : utf8Bytes(input.guidance),
    guidanceTokensEstimated:
      input.policy === "brief"
        ? Math.ceil((briefReceipt?.byteLength ?? utf8Bytes(input.guidance)) / 4)
        : estimatedTokens(input.guidance),
    match: {
      ...input.match,
      instructionDigest: commonInstructionDigest(providerRequests),
      toolHistoryDigest: digest(String(toolResults)),
    },
    order: input.order,
    terminal,
    usage: usageOf(
      providerUsage === undefined ||
        providerUsage === null ||
        providerUsage.provenance !== "provider-reported" ||
        providerUsage.inputTokens === undefined ||
        providerUsage.outputTokens === undefined
        ? undefined
        : {
            provenance: "provider-reported",
            inputTokens: providerUsage.inputTokens,
            outputTokens: providerUsage.outputTokens,
            totalTokens:
              providerUsage.totalTokens ?? providerUsage.inputTokens + providerUsage.outputTokens,
            totalProvenance:
              providerUsage.totalTokens === undefined
                ? "derived-from-provider-units"
                : "provider-reported",
            cachedInputTokens: providerUsage.cachedInputTokens ?? null,
            reasoningTokens: providerUsage.reasoningTokens ?? null,
          },
    ),
    responseBytes: utf8Bytes(response),
    responseTokens: estimatedTokens(response),
    responseTokenizer: RESPONSE_TOKENIZER,
    wallTimeMs,
    costUsd: null,
    providerRequests: providerRequests.length,
    retries: Math.max(0, (result.payload?.modelAttempts ?? 0) - 1),
    requiredFacts: input.fixture.requiredFacts,
    preservedFacts,
    missingFacts,
    unsupportedClaims,
  };
}

export function formatBriefScorecardHuman(report: ScorecardReport): string {
  const lines = [
    `Brief/Caveman scorecard | ${report.provider.model} | ${report.settings.repetitions} repetitions`,
    `baseline=${report.baseline.commit} source=${report.baseline.sourceDigest} adapter=${report.baseline.adapterVersion}`,
  ];
  for (const [index, result] of report.results.entries()) {
    const pair = report.pairs[index];
    if (pair === undefined) continue;
    lines.push(`${pair.pairId} verdict=${result.verdict} accepted=${result.accepted}`);
    lines.push(`  reason=${result.reason} invalid=${result.invalidReason ?? "none"}`);
    for (const arm of [pair.brief, pair.caveman]) {
      const usage = arm.usage;
      lines.push(
        `  ${arm.policy} mode=${arm.policyMode} delivery=${arm.delivery} native=${arm.providerResponseDensityControl ?? "none"} order=${arm.order} terminal=${arm.terminal} ` +
          `tokens(total/input/output/cache/reasoning)=${usage?.totalTokens ?? "?"}/${usage?.inputTokens ?? "?"}/${usage?.outputTokens ?? "?"}/${usage?.cachedInputTokens ?? "?"}/${usage?.reasoningTokens ?? "?"} ` +
          `totalSource=${usage?.totalProvenance ?? "?"} ` +
          `requests=${arm.providerRequests} retries=${arm.retries} latencyMs=${arm.wallTimeMs.toFixed(1)} costUsd=${arm.costUsd ?? "?"} ` +
          `guidance(bytes/estimatedTokens)=${arm.guidanceBytes}/${arm.guidanceTokensEstimated} ` +
          `response(bytes/${arm.responseTokenizer})=${arm.responseBytes}/${arm.responseTokens} ` +
          `fidelity=${((arm.policy === "brief" ? result.briefFidelity : result.cavemanFidelity) * 100).toFixed(0)}% ` +
          `missing=${arm.missingFacts.length} unsupported=${arm.unsupportedClaims}`,
      );
      lines.push(
        `    policyDigest=${arm.policyDigest} cache=${arm.match.cacheState} reasoning=${arm.match.reasoning} ` +
          `required=${JSON.stringify(arm.requiredFacts)} preserved=${JSON.stringify(arm.preservedFacts)} missingFacts=${JSON.stringify(arm.missingFacts)}`,
      );
    }
  }
  lines.push(
    `total=${report.summary.total} pass=${report.summary.passed} tie=${report.summary.tied} loss=${report.summary.lost} invalid=${report.summary.invalid} accepted=${report.summary.accepted}`,
  );
  return `${lines.join("\n")}\n`;
}

async function main(): Promise<void> {
  const options = parseOptions(Bun.argv.slice(2));
  const controller = new AbortController();
  process.once("SIGINT", () => controller.abort("SIGINT"));
  const { adapter, catalog: providerCatalog, model } = await createBriefScorecardProvider();
  const selectedFixtures = BRIEF_RESPONSE_FIXTURES.filter(
    (fixture) => options.fixture === null || fixture.id === options.fixture,
  );
  if (selectedFixtures.length === 0) {
    throw new Error(`unknown fixture: ${options.fixture}`);
  }
  const policies = new Map<
    string,
    Awaited<ReturnType<typeof loadPinnedCavemanPolicy>> & { ok: true }
  >();
  for (const fixture of selectedFixtures) {
    if (policies.has(fixture.cavemanIntensity)) continue;
    const loaded = await loadPinnedCavemanPolicy(
      gitSource(options.cavemanRoot),
      fixture.cavemanIntensity,
      controller.signal,
    );
    if (!loaded.ok)
      throw new Error(`Caveman baseline ${loaded.error.code}: ${loaded.error.detail}`);
    policies.set(fixture.cavemanIntensity, loaded);
  }

  const root = await mkdtemp(join(tmpdir(), "falryn-brief-scorecard-"));
  const workspace = join(root, "workspace");
  await mkdir(workspace, { recursive: true });
  try {
    const pairs: BriefComparisonPair[] = [];
    const attempts: BriefComparisonArm[] = [];
    let partial = false;
    fixtureLoop: for (const fixture of selectedFixtures) {
      const caveman = policies.get(fixture.cavemanIntensity)?.value;
      if (caveman === undefined) throw new Error("loaded baseline disappeared");
      for (let repetition = 0; repetition < options.repetitions; repetition += 1) {
        if (controller.signal.aborted) {
          partial = true;
          break fixtureLoop;
        }
        const briefFirst = repetition % 2 === 0;
        const pairId = `${fixture.id}-${repetition + 1}`;
        const common: BriefComparisonMatch = {
          taskDigest: digest(fixture.prompt),
          fixtureDigest: digest(JSON.stringify(fixture)),
          workspaceDigest: digest("synthetic-empty-workspace.v1"),
          instructionDigest: digest("falryn-product-and-ask-profile.v1"),
          evidenceDigest: digest("no-external-evidence.v1"),
          toolHistoryDigest: digest("0"),
          provider: String(adapter.identity.providerId),
          model,
          reasoning: "provider-default",
          outputTokenLimit: DEFAULT_OUTPUT_LIMIT,
          cacheState: "fresh-session-provider-unspecified",
          retryPolicyDigest: digest("falryn-default-retry-policy.v1"),
        };
        const briefGuidance = `Brief ${fixture.briefMode}`;
        const runBrief = () =>
          runArm({
            fixture,
            policy: "brief",
            policyMode: fixture.briefMode,
            policyDigest: digest(`${BRIEF_STRATEGY_VERSION}\0${fixture.briefMode}`),
            guidance: briefGuidance,
            order: briefFirst ? 1 : 2,
            match: common,
            adapter,
            providerCatalog,
            root,
            workspace,
            signal: controller.signal,
          });
        const runCaveman = () =>
          runArm({
            fixture,
            policy: "caveman",
            policyMode: fixture.cavemanIntensity,
            policyDigest: caveman.policyDigest,
            guidance: caveman.section.content,
            order: briefFirst ? 2 : 1,
            match: common,
            adapter,
            providerCatalog,
            root,
            workspace,
            signal: controller.signal,
            responsePolicySection: caveman.section,
          });
        const first = briefFirst ? await runBrief() : await runCaveman();
        attempts.push(first);
        if (first.terminal === "cancelled" || controller.signal.aborted) {
          partial = true;
          break fixtureLoop;
        }
        const second = briefFirst ? await runCaveman() : await runBrief();
        attempts.push(second);
        pairs.push({
          pairId,
          brief: first.policy === "brief" ? first : second,
          caveman: first.policy === "caveman" ? first : second,
        });
        if (second.terminal === "cancelled" || controller.signal.aborted) {
          partial = true;
          break fixtureLoop;
        }
      }
    }
    const results = pairs.map(compareBriefPair);
    const report: ScorecardReport = {
      schemaVersion: BRIEF_SCORECARD_SCHEMA_VERSION,
      generatedAt: new Date().toISOString(),
      baseline: {
        commit: CAVEMAN_PINNED_COMMIT,
        sourceDigest: CAVEMAN_PINNED_SKILL_DIGEST,
        adapterVersion: CAVEMAN_ADAPTER_VERSION,
      },
      provider: { id: String(adapter.identity.providerId), model },
      settings: {
        repetitions: options.repetitions,
        outputTokenLimit: DEFAULT_OUTPUT_LIMIT,
        responseTokenizer: RESPONSE_TOKENIZER,
        concurrency: 1,
        toolExposure: "none",
      },
      attempts,
      pairs,
      results,
      summary: {
        total: results.length,
        passed: results.filter((result) => result.verdict === "pass").length,
        tied: results.filter((result) => result.verdict === "tie").length,
        lost: results.filter((result) => result.verdict === "loss").length,
        invalid: results.filter((result) => result.verdict === "invalid").length,
        accepted: results.filter((result) => result.accepted).length,
        partial,
        complete:
          !partial &&
          attempts.length === pairs.length * 2 &&
          results.every((result) => result.accepted),
      },
    };
    const json = `${JSON.stringify(report, null, 2)}\n`;
    if (options.output !== null) await Bun.write(options.output, json);
    process.stdout.write(options.format === "json" ? json : formatBriefScorecardHuman(report));
    if (!report.summary.complete) process.exitCode = 1;
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  await main();
}
