/**
 * The model route to registered slash actions (#948).
 *
 * One narrow tool lists the actions whose declared contract admits a model
 * caller and invokes one by canonical ID with its argument, or by literal slash
 * text. Both resolve through the command registry and run through the shared
 * dispatcher, so a model call reaches the same owner as slash text, the palette
 * and a headless run, once. Effect classification comes from the resolved
 * entry, so the gateway applies that action's policy and confirmation.
 */
import { z } from "zod";

import type { ConfigurationGeneration } from "../../domain/foundation/index.ts";
import {
  createToolRegistry,
  createToolRegistryEntry,
  defaultConcurrencyContract,
  defaultProjectionContract,
  defaultToolLimits,
  type ToolInvocationOutcome,
} from "../../domain/tools/index.ts";
import {
  COMMAND_ACTION_LIMITS,
  type CommandActionDispatcher,
  type CommandActionOutcome,
  type CommandActionTarget,
} from "../commands/index.ts";
import type { ProductToolSourceBundle } from "./product-tools-merge.ts";

export const COMMAND_ACTION_TOOL_NAME = "command_action";

const input = z
  .object({
    operation: z.enum(["list", "invoke"]),
    query: z.string().max(COMMAND_ACTION_LIMITS.queryCharacters).optional(),
    action: z.string().min(1).max(128).optional(),
    argument: z.string().max(65_536).nullable().optional(),
    slash: z.string().min(1).max(COMMAND_ACTION_LIMITS.slashBytes).optional(),
    generation: z.string().min(1).max(128).optional(),
  })
  .strict() as z.ZodType<Readonly<Record<string, unknown>>>;

const DESCRIPTION =
  "List or run a registered Falryn action, the same one a user reaches with a slash command such as /skills. operation list returns the actions you may call, with their slash forms, argument and effect, and the registry generation. operation invoke runs one: give action (its id, for example skills.list) and argument, or slash (the literal text, for example /skills pdf). Slash text is parsed by Falryn's command registry; it is never a shell command and is never typed into the user's composer. Actions that need the interactive shell, or that change state mid-turn, are refused with a typed reason";

function target(request: Readonly<Record<string, unknown>>): CommandActionTarget | null {
  if (typeof request.slash === "string")
    return request.action === undefined ? { kind: "slash", text: request.slash } : null;
  if (typeof request.action === "string")
    return {
      kind: "action",
      id: request.action,
      argument: typeof request.argument === "string" ? request.argument : null,
    };
  return null;
}

function result(outcome: CommandActionOutcome): ToolInvocationOutcome {
  switch (outcome.kind) {
    case "completed":
      return {
        status: "completed",
        effect: "completed",
        output: {
          status: "completed",
          action: outcome.invocation.commandId,
          form: outcome.invocation.form,
          argument: outcome.invocation.argument,
          generation: outcome.invocation.generation,
          lines: [...outcome.lines],
        },
      };
    case "unavailable":
      return {
        status: "completed",
        effect: "completed",
        output: {
          status: "unavailable",
          action: outcome.invocation.commandId,
          form: outcome.invocation.form,
          argument: outcome.invocation.argument,
          generation: outcome.invocation.generation,
          message: outcome.message,
        },
      };
    // A refusal ran nothing; it is reported as data so the model can correct course.
    case "refused":
      return {
        status: "completed",
        effect: "completed",
        output: {
          status: "refused",
          code: outcome.code,
          action: outcome.commandId,
          message: outcome.message,
        },
      };
    case "cancelled":
      return { status: "cancelled", effect: "none" };
    case "failed":
      return {
        status: "failed",
        reason: outcome.message,
        effect: outcome.invocation.effect === "observation" ? "none" : "uncertain",
      };
  }
}

/**
 * The registered model route over one session's dispatcher. The dispatcher is
 * read at call time, so a recomposed session's registry generation is the one
 * that answers.
 */
export function composeCommandActionTool(
  generation: ConfigurationGeneration,
  dispatcher: () => CommandActionDispatcher | null,
): ProductToolSourceBundle {
  const entry = createToolRegistryEntry(
    {
      namespace: "commands",
      name: COMMAND_ACTION_TOOL_NAME,
      version: 1,
      source: "builtin",
      title: "Run a registered action",
      description: DESCRIPTION,
      effect: "observation",
      capabilityKind: "other",
      platforms: [],
      limits: defaultToolLimits({ maxInputBytes: 70_000, maxOutputBytes: 131_072 }),
      concurrency: defaultConcurrencyContract({ maxPerWorkspace: 4 }),
      resultProjection: defaultProjectionContract({ modelMaxBytes: 131_072 }),
    },
    {
      inputSchema: input,
      outputSchema: z.record(z.string(), z.unknown()),
      // The resolved action's declared effect decides policy and confirmation.
      effectFor: (request) => {
        if (request.operation !== "invoke") return "observation";
        const resolved = target(request);
        return (
          (resolved === null ? null : dispatcher()?.effect(resolved, "model", true)) ??
          "observation"
        );
      },
    },
  );
  if (!entry.ok) throw new Error(`command-action-tool-${entry.error.code}`);
  const registry = createToolRegistry(generation, [entry.value]);
  if (!registry.ok) throw new Error(`command-action-registry-${registry.error.code}`);
  const id = entry.value.manifest.capabilityId;
  return {
    registry: registry.value,
    catalog: registry.value.catalog,
    toolNames: [COMMAND_ACTION_TOOL_NAME],
    // Actions are reached through discovery or an explicit `$` mention; the route
    // never takes an eager slot from the tools ordinary work selects.
    explicitOnly: new Set([id]),
    runner: {
      hasBinding: (candidate) => candidate === id,
      async execute(request) {
        if (request.signal.aborted) return { status: "cancelled", effect: "none" };
        const actions = dispatcher();
        if (actions === null)
          return { status: "unavailable", reason: "command-actions-unavailable", effect: "none" };
        if (request.input.operation === "list") {
          const query = typeof request.input.query === "string" ? request.input.query : "";
          return {
            status: "completed",
            effect: "completed",
            output: {
              status: "listed",
              generation: actions.generation,
              actions: actions.cards("model", query),
            },
          };
        }
        const resolved = target(request.input);
        if (resolved === null)
          return {
            status: "completed",
            effect: "completed",
            output: {
              status: "refused",
              code: "invalid-request",
              action: null,
              message: "invoke needs either action (with an optional argument) or slash, not both.",
            },
          };
        return result(
          await actions.invoke({
            caller: "model",
            target: resolved,
            // A model calls from inside its own turn.
            turnActive: true,
            ...(typeof request.input.generation === "string"
              ? { generation: request.input.generation }
              : {}),
            signal: request.signal,
          }),
        );
      },
    },
  };
}
