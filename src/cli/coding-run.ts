/**
 * Headless `falryn run` coding command (#708).
 *
 * Declares a coding entry that hosts a session/turn through the product agent
 * runtime producer (same path as composer submission #707), projects through
 * the four CLI output contracts, and never prompts. Missing prompt text fails
 * closed. Without a live provider adapter (#709), the turn is hosted then the
 * command fails closed with a typed provider error rather than hanging.
 */

import {
  adoptForeignError,
  composeProductAgentRuntime,
  composeProductCredentials,
  composeProductProcessTools,
  composeProductWorkspaceTools,
  DEFAULT_OPENAI_CREDENTIAL_REFERENCE,
  fromUnknown,
  mergeProductToolBundles,
  resolveProviderApiKey,
} from "../application/index.ts";
import {
  type CredentialReference,
  configurationGeneration,
  type FalrynError,
  type InputStreamPort,
  primaryWorkspaceRoot,
  sessionId as sessionIdCodec,
  streamId,
  type TerminalOutcome,
  traceId as traceIdCodec,
  turnId as turnIdCodec,
  workspaceId as workspaceIdCodec,
} from "../domain/index.ts";
import {
  createHostCommandRunner,
  createHostProcessCapturePort,
  hostPlatform,
} from "../integrations/index.ts";
import { createOpenAiCompatibleAdapter } from "../providers/openai-compatible-adapter.ts";
import type { ProviderAdapterPort } from "../providers/port.ts";
import {
  COMMAND_RESULT_SCHEMA_FAMILY,
  COMMAND_RESULT_SCHEMA_VERSION,
  type CommandEffect,
  type CommandResultOf,
  READ_ONLY_EFFECT,
} from "./result.ts";
import { CLI_EVENT_STREAM, type ServiceProvider } from "./services.ts";
import { describeWorkspaceResolveError } from "./workspace-resolution.ts";

export const CODING_RUN_COMMAND = "run" as const;
export const CODING_RUN_OWNER = "#708";

export { DEFAULT_OPENAI_CREDENTIAL_REFERENCE };
/** Parsed prompt fragments after `falryn run` (may be empty when stdin supplies text). */
export type CodingRunArguments = {
  readonly promptParts: readonly string[];
};

export type CodingRunPayload = {
  readonly prompt: string;
  readonly sessionId: string;
  readonly turnId: string | null;
  readonly workspaceId: string;
  /** How far the product graph progressed before the result was formed. */
  readonly stage:
    | "prompt-missing"
    | "workspace-refused"
    | "compose-failed"
    | "hosted"
    | "provider-required";
  readonly eventCount: number;
};

export type CodingRunResult = CommandResultOf<typeof CODING_RUN_COMMAND, CodingRunPayload>;

export type CodingRunOptions = {
  readonly input: InputStreamPort;
  readonly signal?: AbortSignal;
  /**
   * Stable identities for tests. Production derives session/turn/trace from
   * the clock so each invocation is distinct without depending on crypto.
   */
  readonly identities?: {
    readonly sessionId: string;
    readonly turnId: string;
    readonly traceId: string;
    readonly workspaceId?: string;
  };
  /**
   * Optional live or deterministic adapter. When omitted, the product credential
   * resolver attempts `FALRYN_OPENAI_API_KEY` and attaches an OpenAI-compatible
   * adapter when present (#710). Absent credentials fail closed after hosting.
   */
  readonly providerAdapter?: ProviderAdapterPort | null;
  /** Override the default OpenAI environment credential reference. */
  readonly credentialReference?: CredentialReference;
  /** OpenAI-compatible base URL when composing from credentials. */
  readonly openaiBaseUrl?: string;
};

/**
 * Resolve the task text from argv fragments and/or stdin.
 * Never waits on an interactive handle: not-connected stdin is empty input.
 */
export async function resolveCodingPrompt(
  promptParts: readonly string[],
  input: InputStreamPort,
): Promise<
  | { readonly ok: true; readonly prompt: string; readonly source: "argv" | "stdin" }
  | { readonly ok: false; readonly reason: string }
> {
  const fromArgs = promptParts.join(" ").trim();
  if (fromArgs.length > 0) {
    return { ok: true, prompt: fromArgs, source: "argv" };
  }

  const read = await input.read();
  if (!read.ok) {
    return {
      ok: false,
      reason:
        read.error.code === "too-large"
          ? `stdin exceeds the declared byte limit (${read.error.maxBytes})`
          : read.error.code === "invalid-encoding"
            ? "stdin is not valid UTF-8"
            : `stdin could not be read (${read.error.code})`,
    };
  }

  if (read.value.kind === "not-connected") {
    return {
      ok: false,
      reason: "a prompt is required as arguments or on stdin; this run never prompts",
    };
  }

  if (read.value.kind === "empty") {
    return {
      ok: false,
      reason: "a prompt is required as arguments or on stdin; empty input is refused",
    };
  }

  const fromStdin = read.value.text.trim();
  if (fromStdin.length === 0) {
    return {
      ok: false,
      reason: "a prompt is required as arguments or on stdin; empty input is refused",
    };
  }

  return { ok: true, prompt: fromStdin, source: "stdin" };
}

/**
 * Host one headless coding turn through the product producer and fail closed
 * when a live provider adapter is not attached.
 */
export async function runCoding(
  services: ServiceProvider,
  arguments_: CodingRunArguments,
  options: CodingRunOptions,
): Promise<CodingRunResult> {
  const resolved = await resolveCodingPrompt(arguments_.promptParts, options.input);
  if (!resolved.ok) {
    return codingResult(
      {
        prompt: "",
        sessionId: "",
        turnId: null,
        workspaceId: "",
        stage: "prompt-missing",
        eventCount: 0,
      },
      [
        adoptForeignError(
          {
            code: "cli.prompt-required",
            category: "configuration",
            message: resolved.reason,
          },
          { operation: "resolve coding prompt" },
        ),
      ],
    );
  }

  const graph = services();
  const workspace = await graph.ensureWorkspaceSet(options.signal);
  if (!workspace.ok) {
    return codingResult(
      {
        prompt: resolved.prompt,
        sessionId: "",
        turnId: null,
        workspaceId: "",
        stage: "workspace-refused",
        eventCount: 0,
      },
      [
        adoptForeignError(
          {
            code: "cli.workspace-refused",
            category: "workspace",
            message: describeWorkspaceResolveError(workspace.error),
          },
          { operation: "resolve workspace for coding run" },
        ),
      ],
    );
  }

  const now = graph.clock.now();
  const ids = options.identities ?? {
    sessionId: `session-run-${now}`,
    turnId: `turn-run-${now}`,
    traceId: `trace-run-${now}`,
  };
  const workspaceId = workspaceIdCodec.from(
    ids.workspaceId ?? primaryWorkspaceRoot(workspace.value.set).rootId,
  );
  const sessionId = sessionIdCodec.from(ids.sessionId);
  const turnId = turnIdCodec.from(ids.turnId);
  const traceId = traceIdCodec.from(ids.traceId);
  const generation = configurationGeneration.from(0);

  let providerAdapter = options.providerAdapter;
  if (providerAdapter === undefined) {
    const credentials = composeProductCredentials({
      clock: graph.clock,
      commands: createHostCommandRunner(),
      platform: hostPlatform(),
      environment: graph.environment,
    });
    const reference = options.credentialReference ?? DEFAULT_OPENAI_CREDENTIAL_REFERENCE;
    const apiKey = await resolveProviderApiKey(credentials.resolver, reference, options.signal);
    if (apiKey !== null) {
      const baseUrl = options.openaiBaseUrl ?? "https://api.openai.com/v1";
      providerAdapter = createOpenAiCompatibleAdapter({
        profileId: "openai",
        baseUrl,
        resolveApiKey: async () => apiKey,
      });
    }
  }

  const workspaceTools = composeProductWorkspaceTools({
    generation,
    fileSystem: graph.fileSystem,
    commands: createHostCommandRunner(),
    workspaceRoot: primaryWorkspaceRoot(workspace.value.set).path,
  });
  const processTools = composeProductProcessTools({
    generation,
    capture: createHostProcessCapturePort({ clock: graph.clock }),
    workspaceCwd: String(primaryWorkspaceRoot(workspace.value.set).path),
  });
  const productTools = mergeProductToolBundles(generation, [workspaceTools, processTools]);

  const composed = composeProductAgentRuntime({
    eventStore: graph.eventStore,
    clock: graph.clock,
    streamId: streamId.from(CLI_EVENT_STREAM),
    correlation: {
      workspaceId,
      sessionId,
      traceId,
      configurationGeneration: generation,
    },
    ...(providerAdapter !== undefined && providerAdapter !== null ? { providerAdapter } : {}),
    toolCatalog: productTools.catalog,
    toolRunner: productTools.runner,
  });
  if (!composed.ok) {
    return codingResult(
      {
        prompt: resolved.prompt,
        sessionId: ids.sessionId,
        turnId: null,
        workspaceId: String(workspaceId),
        stage: "compose-failed",
        eventCount: 0,
      },
      [
        adoptForeignError(
          {
            code: `runtime.${composed.error.code}`,
            category: "internal",
            message: `product agent runtime could not compose (${composed.error.code})`,
          },
          { operation: "compose product agent runtime" },
        ),
      ],
    );
  }

  const producer = composed.value.attachments.turnProducer;
  const startedSession = await producer.startSession({
    sessionId,
    workspaceId,
    configurationGeneration: generation,
  });
  if (!startedSession.ok) {
    return codingResult(
      {
        prompt: resolved.prompt,
        sessionId: ids.sessionId,
        turnId: null,
        workspaceId: String(workspaceId),
        stage: "compose-failed",
        eventCount: producer.events().length,
      },
      [
        adoptForeignError(
          {
            code: `producer.${startedSession.error.code}`,
            category: "internal",
            message: `session could not start (${startedSession.error.code})`,
          },
          { operation: "start coding session" },
        ),
      ],
    );
  }

  const startedTurn = await producer.startTurn({
    turnId,
    sessionId,
    workspaceId,
    traceId,
    configurationGeneration: generation,
  });
  if (!startedTurn.ok) {
    return codingResult(
      {
        prompt: resolved.prompt,
        sessionId: ids.sessionId,
        turnId: null,
        workspaceId: String(workspaceId),
        stage: "compose-failed",
        eventCount: producer.events().length,
      },
      [
        adoptForeignError(
          {
            code: `producer.${startedTurn.error.code}`,
            category: "internal",
            message: `turn could not start (${startedTurn.error.code})`,
          },
          { operation: "start coding turn" },
        ),
      ],
    );
  }

  const provider = composed.value.requireProviderAdapter();
  if (!provider.ok) {
    const outcome: TerminalOutcome = { kind: "failed", effect: "none" };
    const completed = await producer.completeTurn({
      turnId,
      sessionId,
      workspaceId,
      traceId,
      configurationGeneration: generation,
      outcome,
    });
    if (!completed.ok) {
      return codingResult(
        {
          prompt: resolved.prompt,
          sessionId: ids.sessionId,
          turnId: ids.turnId,
          workspaceId: String(workspaceId),
          stage: "provider-required",
          eventCount: producer.events().length,
        },
        [
          adoptForeignError(
            {
              code: "provider.adapter-required",
              category: "provider",
              message: `No live provider adapter is attached (${CODING_RUN_OWNER}; wire vendors in #709). Turn completion also failed (${completed.error.code}).`,
            },
            { operation: "require provider for coding run" },
          ),
        ],
        outcome,
      );
    }

    return codingResult(
      {
        prompt: resolved.prompt,
        sessionId: ids.sessionId,
        turnId: ids.turnId,
        workspaceId: String(workspaceId),
        stage: "provider-required",
        eventCount: producer.events().length,
      },
      [
        adoptForeignError(
          {
            code: "provider.adapter-required",
            category: "provider",
            message: `No live provider adapter is attached (${CODING_RUN_OWNER}; wire vendors in #709).`,
          },
          { operation: "require provider for coding run" },
        ),
      ],
      outcome,
    );
  }

  // A provider is present (tests / future #709). Hosting succeeded; model
  // streaming remains outside this slice until attempt runners and credentials
  // are composed. Report hosted with a completed turn and no model attempt.
  const hostedOutcome: TerminalOutcome = { kind: "completed" };
  const completed = await producer.completeTurn({
    turnId,
    sessionId,
    workspaceId,
    traceId,
    configurationGeneration: generation,
    outcome: hostedOutcome,
  });
  if (!completed.ok) {
    return codingResult(
      {
        prompt: resolved.prompt,
        sessionId: ids.sessionId,
        turnId: ids.turnId,
        workspaceId: String(workspaceId),
        stage: "hosted",
        eventCount: producer.events().length,
      },
      [
        fromUnknown(new Error(`turn could not complete (${completed.error.code})`), {
          operation: "complete coding turn",
        }),
      ],
    );
  }

  return codingResult(
    {
      prompt: resolved.prompt,
      sessionId: ids.sessionId,
      turnId: ids.turnId,
      workspaceId: String(workspaceId),
      stage: "hosted",
      eventCount: producer.events().length,
    },
    [],
    hostedOutcome,
  );
}

function codingResult(
  payload: CodingRunPayload,
  errors: readonly FalrynError[],
  outcome?: TerminalOutcome,
  effect: CommandEffect = READ_ONLY_EFFECT,
): CodingRunResult {
  return {
    schemaFamily: COMMAND_RESULT_SCHEMA_FAMILY,
    schemaVersion: COMMAND_RESULT_SCHEMA_VERSION,
    command: CODING_RUN_COMMAND,
    outcome:
      outcome ?? (errors.length === 0 ? { kind: "completed" } : { kind: "failed", effect: "none" }),
    effect,
    payload,
    errors,
    warnings: [],
    omissions: [],
    truncation: [],
    artifacts: [],
    correlation: {
      workspaceId: payload.workspaceId === "" ? null : workspaceIdCodec.from(payload.workspaceId),
      sessionId: payload.sessionId === "" ? null : sessionIdCodec.from(payload.sessionId),
      turnId: payload.turnId === null ? null : turnIdCodec.from(payload.turnId),
      traceId: null,
      scopeId: null,
      invocationId: null,
      capabilityId: null,
      eventId: null,
    },
  };
}
