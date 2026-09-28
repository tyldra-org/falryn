/**
 * The package evaluator hook adapter (#1186). It owns no provider, credential or scheduler:
 * the granted model is resolved through the session's provider connections, and the
 * evaluation is one owned child on the hook's own resource task, run by the ordinary
 * live-turn executor. A prompt evaluator makes one request with no tools; an agent
 * evaluator may read through the normal gateway with only its declared observation tools.
 *
 * The child has no workspace instructions, memory, hooks or confirmation: its input is the
 * package's instructions, Falryn's protocol text and the declared evidence document.
 * Exactly one JSON verdict is decoded, then the shared codec revalidates the decision.
 * Nothing is retried; malformed, refused or incomplete output fails the hook, which then
 * settles by its point's own posture.
 */

import type { ArtifactStorePort } from "../../domain/artifacts/artifact.ts";
import { canonicalDigest, ExtensionInputError } from "../../domain/extensions/canonical.ts";
import {
  decodeEvaluatorVerdict,
  EVALUATOR_LIMITS,
  type EvaluatorHookGrant,
  type EvaluatorHookRegistration,
  evaluatorDecisionCandidate,
  evaluatorEvidenceDocument,
  evaluatorIneligibility,
  evaluatorOutputSchema,
  evaluatorProtocol,
} from "../../domain/extensions/hook-evaluator.ts";
import {
  type HookDecision,
  type HookWireInput,
  validateHookDecision,
} from "../../domain/extensions/hook-protocol.ts";
import { scopeId, sessionId, streamId, turnId } from "../../domain/foundation/index.ts";
import type { HookHandlerFacts } from "../../domain/tools/hook-evidence.ts";
import type { ToolHookContext } from "../../domain/tools/tool-hooks.ts";
import { createToolRegistry, workspaceWritesOf } from "../../domain/tools/tool-registry.ts";
import { EMPTY_MODEL_PREFERENCES } from "../../providers/configuration/policy-schema.ts";
import { WORK_INTENTS } from "../../providers/configuration/roles.ts";
import type { ModelCatalog } from "../../providers/index.ts";
import type { ProviderAdapterPort } from "../../providers/protocol/port.ts";
import { createChildAdmission } from "../orchestration/child-admission.ts";
import type { ProductTaskResources } from "../orchestration/product-resources.ts";
import { createScopeTree } from "../orchestration/scope-tree.ts";
import {
  composeProductAgentRuntime,
  type ProductAgentRuntimePorts,
} from "../runtime/product-agent-runtime.ts";
import { createProductLiveTurnExecutor } from "../runtime/product-live-turn.ts";
import { mergeProductToolBundles, type ProductToolBundle } from "../tools/product-tools-merge.ts";
import { HookExecutionError } from "../tools/tool-hook-invocation.ts";

export type HookEvaluatorProvider = {
  readonly adapter: ProviderAdapterPort;
  readonly catalog: ModelCatalog;
};
/** What a session lends its evaluator hooks; each call revalidates the provider profile. */
export type HookEvaluatorSession = {
  provider(
    profileId: string,
    signal: AbortSignal,
  ): Promise<HookEvaluatorProvider | { readonly reason: string }>;
  readonly ports: Pick<
    ProductAgentRuntimePorts,
    "eventStore" | "clock" | "correlation" | "resources"
  >;
  readonly artifacts?: ArtifactStorePort;
  /** The session's composed tools, for agent reads; null until the session composes them. */
  tools(): ProductToolBundle | null;
};
export type HookEvaluatorPort = {
  run(input: {
    registration: EvaluatorHookRegistration;
    grant: EvaluatorHookGrant;
    instructions: string;
    wire: HookWireInput;
    context: ToolHookContext;
    /** The hook's own resource task; evaluator work subdivides it. */
    task: ProductTaskResources | undefined;
    current(): Promise<boolean>;
  }): Promise<HookDecision>;
};

type Model = Extract<HookHandlerFacts, { kind: "model" }>;

/** Natively read-only: observation, no input-dependent effect and no workspace writes. */
function readOnly(entry: Parameters<typeof workspaceWritesOf>[0]): boolean {
  return (
    entry.effect === "observation" &&
    entry.effectFor === undefined &&
    workspaceWritesOf(entry) === "none"
  );
}

export function createHookEvaluator(session: HookEvaluatorSession): HookEvaluatorPort {
  return {
    async run({ registration, grant, instructions, wire, context, task, current }) {
      const agent = registration.handler.kind === "agent-evaluator-v1";
      const facts: Model = {
        kind: "model",
        status: "not-started",
        response: "missing",
        requests: 0,
        reads: 0,
        inputTokens: null,
        outputTokens: null,
        requestedModel: grant.model.modelId,
        resolvedModel: null,
        actualModel: null,
        effects: "none",
      };
      const signal = context.signal;
      const stopped = () =>
        new HookExecutionError(
          Number(session.ports.clock.now()) >= context.expiresAt ? "timed-out" : "cancelled",
        );
      try {
        const ineligible = evaluatorIneligibility(wire.envelope);
        if (ineligible !== null) throw new HookExecutionError(ineligible);
        if (signal.aborted) throw stopped();
        if (task === undefined) throw new HookExecutionError("hook-resources-unavailable");
        const provider = await session.provider(grant.model.providerProfileId, signal);
        if (signal.aborted) throw stopped();
        // The granted model or nothing: no role inheritance, alias or fallback.
        const model =
          "adapter" in provider &&
          String(provider.adapter.identity.providerId) === grant.model.providerId
            ? provider.catalog.models.find(
                (entry) =>
                  String(entry.modelId) === grant.model.modelId &&
                  entry.availability !== "unavailable",
              )
            : undefined;
        if (!("adapter" in provider) || model === undefined)
          throw new HookExecutionError("hook-model-unavailable");
        if (model.structuredOutput !== "supported")
          throw new HookExecutionError("hook-model-unsupported");
        facts.resolvedModel = String(model.modelId);
        const { adapter } = provider;
        let evidence: string;
        try {
          evidence = evaluatorEvidenceDocument(registration, wire.envelope);
        } catch (error) {
          throw new HookExecutionError(
            error instanceof ExtensionInputError ? error.code : "hook-input-too-large",
          );
        }
        const generation = session.ports.correlation.configurationGeneration;
        let reads = 0;
        let bundle = mergeProductToolBundles(generation, []);
        if (registration.handler.kind === "agent-evaluator-v1") {
          const available = session.tools();
          const entries = registration.handler.readTools.map((name) =>
            available?.registry.resolveByName(name),
          );
          // A declared tool that is missing or could write refuses the evaluation outright.
          if (available === null || entries.some((entry) => !entry || !readOnly(entry.manifest)))
            throw new HookExecutionError("hook-evaluator-tool-refused");
          const registry = createToolRegistry(
            generation,
            entries.flatMap((entry) => (entry ? [entry] : [])),
          );
          if (!registry.ok) throw new HookExecutionError("hook-evaluator-tool-refused");
          bundle = mergeProductToolBundles(generation, [
            {
              registry: registry.value,
              catalog: registry.value.catalog,
              toolNames: registry.value.entries.map((entry) => entry.descriptor.name),
              runner: {
                hasBinding: (id) => available.runner.hasBinding?.(id) === true,
                async execute(request) {
                  if (reads >= EVALUATOR_LIMITS.agentReads)
                    return {
                      status: "unavailable",
                      reason: "hook-evaluator-read-limit",
                      effect: "none",
                    };
                  reads += 1;
                  facts.reads = reads;
                  return available.runner.execute(request);
                },
              },
            },
          ]);
        }
        if (!(await current()) || signal.aborted)
          throw signal.aborted ? stopped() : new HookExecutionError("hook-authority-stale");
        const requests = agent ? EVALUATOR_LIMITS.agentRequests : EVALUATOR_LIMITS.promptRequests;
        const identity = `hook-evaluator-${canonicalDigest([wire.invocationId, wire.contribution.contributionId]).slice(7, 39)}`;
        const binding = {
          providerId: grant.model.providerId,
          providerProfileId: grant.model.providerProfileId,
          providerDestinationId: adapter.identity.destinationId,
          modelId: grant.model.modelId,
          reasoning: "provider-default",
          reasoningControl: null,
        };
        const tree = createScopeTree({
          clock: session.ports.clock,
          rootScopeId: scopeId.from(identity),
        });
        const authority = {
          version: 1 as const,
          workspaceId: String(session.ports.correlation.workspaceId),
          configurationGeneration: task.generation,
          capabilityGeneration: task.generation,
          providers: [binding],
          capabilities: bundle.registry.entries.map((entry) => String(entry.manifest.capabilityId)),
          effects: ["observation" as const],
          editScope: null,
        };
        const admission = createChildAdmission({
          resources: task,
          tree,
          scope: tree.root(),
          authority,
        }).admit({
          id: identity,
          workDigest: canonicalDigest({ evidence, instructions }).slice(7),
          authority,
          limits: {
            requests,
            inputTokens: requests * EVALUATOR_LIMITS.inputTokens,
            outputTokens: requests * EVALUATOR_LIMITS.outputTokens,
          },
        });
        if (admission.kind !== "admitted") throw new HookExecutionError("hook-evaluator-limit");
        try {
          const childSession = sessionId.from(identity);
          const runtime = composeProductAgentRuntime({
            toolRegistry: bundle.registry,
            toolCatalog: bundle.catalog,
            toolRunner: bundle.runner,
            capabilityRegistry: bundle.capabilityRegistry,
            eventStore: session.ports.eventStore,
            ...(session.artifacts ? { historyArtifacts: session.artifacts } : {}),
            clock: session.ports.clock,
            providerAdapter: adapter,
            streamId: streamId.from(String(childSession)),
            correlation: { ...session.ports.correlation, sessionId: childSession },
            ...(session.ports.resources ? { resources: session.ports.resources } : {}),
          });
          if (!runtime.ok) throw new HookExecutionError("hook-evaluator-unavailable");
          const route = {
            providerProfileId: grant.model.providerProfileId,
            providerId: adapter.identity.providerId,
            modelId: model.modelId,
            reasoning: "provider-default" as const,
            fallbacks: [],
            budgets: {},
          };
          const executor = createProductLiveTurnExecutor({
            runtime: runtime.value,
            clock: session.ports.clock,
            providerCatalog: provider.catalog,
            ...(session.artifacts ? { artifacts: session.artifacts } : {}),
            initialExecutionProfile: "agent",
            initialModel: {
              providerId: route.providerId,
              providerProfileId: route.providerProfileId,
              modelId: route.modelId,
            },
            // Only the granted model: no session role, fast option or premium processing.
            modelPreferences: () => ({
              ...EMPTY_MODEL_PREFERENCES,
              roles: { ...EMPTY_MODEL_PREFERENCES.roles, default: route },
              intents: {
                ...EMPTY_MODEL_PREFERENCES.intents,
                ...Object.fromEntries(WORK_INTENTS.map((intent) => [intent, "default"])),
              },
            }),
          });
          const output = evaluatorOutputSchema(registration);
          facts.status = "failed";
          const result = await executor.run({
            childAdmission: admission.child,
            signal,
            turnId: turnId.from(identity),
            prompt: evidence,
            maxInputTokens: EVALUATOR_LIMITS.inputTokens,
            maxOutputTokens: EVALUATOR_LIMITS.outputTokens,
            output: { kind: "json-schema", name: output.name, schema: output.schema },
            otherSections: [
              {
                id: "hook-evaluator-instructions",
                role: "product-invariant",
                source: canonicalDigest({ instructions }),
                required: true,
                available: true,
                content: instructions,
              },
              {
                id: "hook-evaluator-protocol",
                role: "product-invariant",
                source: "falryn:hook-evaluator-v1",
                required: true,
                available: true,
                content: evaluatorProtocol(registration),
              },
            ],
          });
          facts.requests = result.providerRequests;
          if (result.providerUsage?.provenance === "provider-reported") {
            facts.inputTokens = result.providerUsage.inputTokens ?? null;
            facts.outputTokens = result.providerUsage.outputTokens ?? null;
          }
          // A request that left the process disclosed the evidence to the provider.
          facts.effects = result.providerRequests > 0 ? "observed" : "none";
          if (signal.aborted) {
            facts.status =
              Number(session.ports.clock.now()) >= context.expiresAt ? "timed-out" : "cancelled";
            if (result.providerRequests > 0) facts.effects = "unknown";
            throw stopped();
          }
          if (result.kind !== "completed" || result.terminalOutcome.kind !== "completed") {
            if (result.providerRequests === 0) facts.status = "not-started";
            throw new HookExecutionError(
              settlementFailure(
                result,
                new Set(bundle.registry.entries.map((entry) => entry.descriptor.name)),
                requests,
              ),
            );
          }
          facts.status = "completed";
          let verdict: ReturnType<typeof decodeEvaluatorVerdict>;
          try {
            verdict = decodeEvaluatorVerdict(result.response, registration);
          } catch {
            facts.response = "invalid";
            throw new HookExecutionError("hook-evaluator-output-invalid");
          }
          if (!(await current()) || signal.aborted) {
            facts.response = "stale";
            throw signal.aborted ? stopped() : new HookExecutionError("hook-authority-stale");
          }
          try {
            const decision = validateHookDecision(
              registration,
              wire.envelope,
              evaluatorDecisionCandidate(verdict, registration, wire.envelope),
            );
            facts.response = "valid";
            return decision;
          } catch {
            facts.response = "invalid";
            throw new HookExecutionError("invalid-hook-response");
          }
        } finally {
          admission.child.close();
        }
      } finally {
        context.report?.(facts);
      }
    },
  };
}

/**
 * Why an unsettled child produced no verdict, from its own journal: partial output, a
 * proposal outside the declared tools, or its whole request allowance used; otherwise the
 * provider or runtime failure its code names.
 */
function settlementFailure(
  result: Awaited<ReturnType<ReturnType<typeof createProductLiveTurnExecutor>["run"]>>,
  allowed: ReadonlySet<string>,
  requests: number,
): string {
  if (result.code === "runtime.attempt-partial") return "hook-evaluator-incomplete";
  const proposed = result.events.flatMap((event) => {
    const payload =
      event.kind === "history.recorded" ? (event.payload as Record<string, unknown>) : null;
    return payload?.type === "proposal" && typeof payload.name === "string" ? [payload.name] : [];
  });
  if (proposed.some((name) => !allowed.has(name))) return "hook-evaluator-tool-refused";
  if (result.providerRequests >= requests) return "hook-evaluator-limit";
  return failureCode(result.code);
}

/** A provider or runtime settlement code, reduced to the hook failure it means. */
function failureCode(code: string): string {
  if (/limit|budget|quota|exhaust/u.test(code)) return "hook-evaluator-limit";
  if (/incomplete|length|truncat|max.?output/u.test(code)) return "hook-evaluator-incomplete";
  if (/refus/u.test(code)) return "hook-evaluator-output-invalid";
  if (/tool/u.test(code)) return "hook-evaluator-tool-refused";
  return "hook-evaluator-unavailable";
}
