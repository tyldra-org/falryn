/** Strict product DAP operations and negotiated capability checks (#805). */

import { z } from "zod";

import {
  configurationGeneration,
  managedServiceId,
  serviceGeneration,
} from "../../domain/index.ts";
import type { DebugAdapterSupervisor } from "../debug-adapter.ts";
import {
  boundedProtocolObjectSchema,
  boundedStringMapSchema,
  completed,
  errorCode,
  failed,
  type ProductLanguageToolDefinition,
  parseInput,
  pathSchema,
  resultOutputSchema,
  type StrictRecordSchema,
  serviceIdSchema,
  sessionInputSchema,
  sessionSchema,
  toolDocument,
  unavailable,
} from "./contracts.ts";

const MAX_GENERIC_DAP_RESULT_BYTES = 256 * 1_024;
const stringArray = z.array(z.string().max(4_096)).max(256);
const environmentSchema = boundedStringMapSchema;
const limitsSchema = z
  .object({
    initializeTimeoutMs: z.number().int().positive().optional(),
    disconnectTimeoutMs: z.number().int().positive().optional(),
    requestTimeoutMs: z.number().int().positive().optional(),
    maxRestarts: z.number().int().nonnegative().optional(),
    restartWindowMs: z.number().int().positive().optional(),
    maxFrameBytes: z.number().int().positive().optional(),
  })
  .strict();
const startSchema = z
  .object({
    serviceId: serviceIdSchema,
    workspaceRoot: pathSchema,
    adapterName: z.string().min(1).max(64),
    configurationGeneration: z.number().int().nonnegative(),
    executable: pathSchema,
    argv: stringArray,
    environment: environmentSchema,
    cwd: pathSchema.optional(),
    initialize: z
      .object({
        clientID: z.string().min(1).max(64),
        clientName: z.string().min(1).max(64),
        adapterID: z.string().min(1).max(64),
        pathFormat: z.enum(["path", "uri"]),
        linesStartAt1: z.boolean(),
        columnsStartAt1: z.boolean(),
        supportsVariableType: z.boolean().optional(),
        supportsVariablePaging: z.boolean().optional(),
        supportsRunInTerminalRequest: z.boolean().optional(),
        locale: z.string().min(1).max(64).optional(),
      })
      .strict(),
    limits: limitsSchema.optional(),
  })
  .strict();
const targetSchema = z
  .object({
    ...sessionSchema,
    configuration: boundedProtocolObjectSchema,
  })
  .strict();
const launchSchema = targetSchema.extend({ noDebug: z.boolean().optional() }).strict();
const breakpointSchema = z
  .object({
    line: z.number().int().positive(),
    column: z.number().int().positive().optional(),
    condition: z.string().max(4_096).optional(),
    hitCondition: z.string().max(4_096).optional(),
    logMessage: z.string().max(4_096).optional(),
  })
  .strict();
const breakpointsSchema = z
  .object({
    ...sessionSchema,
    sourcePath: pathSchema,
    breakpoints: z.array(breakpointSchema).max(256),
    sourceModified: z.boolean().optional(),
  })
  .strict();
const functionBreakpointsSchema = z
  .object({
    ...sessionSchema,
    breakpoints: z
      .array(
        z
          .object({
            name: z.string().min(1).max(1_024),
            condition: z.string().max(4_096).optional(),
            hitCondition: z.string().max(4_096).optional(),
          })
          .strict(),
      )
      .max(256),
  })
  .strict();
const instructionBreakpointsSchema = z
  .object({
    ...sessionSchema,
    breakpoints: z
      .array(
        z
          .object({
            instructionReference: z.string().min(1).max(1_024),
            offset: z.number().int().optional(),
            condition: z.string().max(4_096).optional(),
            hitCondition: z.string().max(4_096).optional(),
          })
          .strict(),
      )
      .max(256),
  })
  .strict();
const exceptionBreakpointsSchema = z
  .object({
    ...sessionSchema,
    filters: z.array(z.string().min(1).max(256)).max(128),
    filterOptions: z
      .array(
        z
          .object({
            filterId: z.string().min(1).max(256),
            condition: z.string().max(4_096).optional(),
          })
          .strict(),
      )
      .max(128)
      .optional(),
  })
  .strict();
const threadSchema = z.object({ ...sessionSchema, threadId: z.number().int().positive() }).strict();
const stoppedThreadSchema = threadSchema
  .extend({ stoppedGeneration: z.number().int().positive() })
  .strict();
const stackSchema = stoppedThreadSchema
  .extend({
    startFrame: z.number().int().nonnegative().optional(),
    levels: z.number().int().positive().max(512).optional(),
  })
  .strict();
const frameSchema = z
  .object({
    ...sessionSchema,
    frameId: z.number().int().nonnegative(),
    stoppedGeneration: z.number().int().positive(),
  })
  .strict();
const variablesSchema = z
  .object({
    ...sessionSchema,
    variablesReference: z.number().int().positive(),
    stoppedGeneration: z.number().int().positive(),
  })
  .strict();
const evaluateSchema = z
  .object({
    ...sessionSchema,
    expression: z.string().min(1).max(4_096),
    stoppedGeneration: z.number().int().positive(),
    frameId: z.number().int().nonnegative().optional(),
    context: z.enum(["watch", "repl", "hover", "clipboard"]).optional(),
  })
  .strict();
const setVariableSchema = z
  .object({
    ...sessionSchema,
    variablesReference: z.number().int().positive(),
    name: z.string().min(1).max(256),
    value: z.string().max(4_096),
    stoppedGeneration: z.number().int().positive(),
  })
  .strict();
const setExpressionSchema = z
  .object({
    ...sessionSchema,
    expression: z.string().min(1).max(4_096),
    value: z.string().max(4_096),
    frameId: z.number().int().nonnegative().optional(),
    stoppedGeneration: z.number().int().positive(),
  })
  .strict();
const disconnectSchema = z
  .object({
    ...sessionSchema,
    restart: z.boolean().optional(),
    terminateDebuggee: z.boolean().optional(),
  })
  .strict();
const terminateSchema = z.object({ ...sessionSchema, restart: z.boolean().optional() }).strict();
const cancelSchema = z
  .object({
    ...sessionSchema,
    requestId: z.number().int().positive().optional(),
    progressId: z.string().min(1).max(256).optional(),
  })
  .strict()
  .refine((value) => value.requestId !== undefined || value.progressId !== undefined, {
    message: "requestId or progressId is required",
  });
const sourceSchema = z
  .object({
    ...sessionSchema,
    sourceReference: z.number().int().positive(),
    sourcePath: pathSchema.optional(),
  })
  .strict();
const modulesSchema = z
  .object({
    ...sessionSchema,
    startModule: z.number().int().nonnegative().optional(),
    moduleCount: z.number().int().positive().max(512).optional(),
  })
  .strict();

type Session = { readonly serviceId: string; readonly generation: number };

function ids(input: Session) {
  return {
    serviceId: managedServiceId.from(input.serviceId),
    generation: serviceGeneration.from(input.generation),
  };
}

function definition(options: {
  readonly name: string;
  readonly title: string;
  readonly description: string;
  readonly effect: "observation" | "mutation" | "external" | "interactive";
  readonly inputSchema: StrictRecordSchema;
  readonly effectFor?: ProductLanguageToolDefinition["effectFor"];
  readonly execute: ProductLanguageToolDefinition["execute"];
}): ProductLanguageToolDefinition {
  return {
    document: toolDocument({
      name: options.name,
      title: options.title,
      description: options.description,
      effect: options.effect,
      capabilityKind: "dap",
    }),
    inputSchema: options.inputSchema,
    outputSchema: resultOutputSchema,
    ...(options.effectFor === undefined ? {} : { effectFor: options.effectFor }),
    execute: options.execute,
  };
}

function ready(dap: DebugAdapterSupervisor, input: Session): true | string {
  const session = ids(input);
  const snapshot = dap.snapshot(session.serviceId);
  if (snapshot === null) return "debug-adapter-not-found";
  if (snapshot.generation !== session.generation) return "stale-debug-adapter-generation";
  if (snapshot.state !== "ready" && snapshot.state !== "degraded") {
    return `debug-adapter-${snapshot.state}`;
  }
  return true;
}

function capability(
  dap: DebugAdapterSupervisor,
  input: Session,
  capabilityName: string,
): true | string {
  const state = ready(dap, input);
  if (state !== true) return state;
  const snapshot = dap.snapshot(ids(input).serviceId);
  const value = snapshot?.capabilities?.[capabilityName];
  return value === true ? true : `unsupported-capability:${capabilityName}`;
}

function exceptionFiltersSupported(
  dap: DebugAdapterSupervisor,
  input: Session,
  requested: readonly string[],
): true | string {
  const state = ready(dap, input);
  if (state !== true) return state;
  const advertised = dap.snapshot(ids(input).serviceId)?.capabilities?.exceptionBreakpointFilters;
  if (!Array.isArray(advertised)) {
    return "unsupported-capability:exceptionBreakpointFilters";
  }
  const supported = new Set(
    advertised.flatMap((candidate) => {
      if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate))
        return [];
      const filter = (candidate as Readonly<Record<string, unknown>>).filter;
      return typeof filter === "string" && filter.length > 0 ? [filter] : [];
    }),
  );
  return requested.every((filter) => supported.has(filter)) ? true : "unsupported-exception-filter";
}

function stopped(
  dap: DebugAdapterSupervisor,
  input: Session & { readonly stoppedGeneration: number },
): true | string {
  const state = ready(dap, input);
  if (state !== true) return state;
  const snapshot = dap.snapshot(ids(input).serviceId);
  if (snapshot?.session.targetState !== "stopped" || snapshot.session.stopped === null) {
    return "debug-target-not-stopped";
  }
  return snapshot.session.stopped.generation === input.stoppedGeneration
    ? true
    : "stale-debug-stop-generation";
}

function bounded(value: unknown): unknown | null {
  const encoded = JSON.stringify(value);
  if (
    encoded === undefined ||
    new TextEncoder().encode(encoded).byteLength > MAX_GENERIC_DAP_RESULT_BYTES
  ) {
    return null;
  }
  if (Array.isArray(value) && value.length > 512) return null;
  return value;
}

async function fixedRequest(
  dap: DebugAdapterSupervisor,
  input: Session,
  command: string,
  args: unknown,
  signal: AbortSignal,
) {
  const result = await dap.request(
    ids(input).serviceId,
    ids(input).generation,
    command,
    args,
    signal,
  );
  if (!result.ok) return failed(errorCode(result.error));
  const projected = bounded(result.value);
  return projected === null ? failed("result-too-large") : completed(projected);
}

function negotiatedRequestDefinition<
  T extends z.ZodType<Readonly<Record<string, unknown>> & Session>,
>(
  dap: DebugAdapterSupervisor,
  options: {
    readonly name: string;
    readonly title: string;
    readonly description: string;
    readonly schema: T;
    readonly capabilityName: string;
    readonly command: string;
    readonly args: (input: z.infer<T>) => unknown;
  },
): ProductLanguageToolDefinition {
  return definition({
    name: options.name,
    title: options.title,
    description: options.description,
    effect: "mutation",
    inputSchema: options.schema,
    execute: async (request) => {
      const input = parseInput(options.schema, request);
      if (input === null) return failed("malformed-input");
      const support = capability(dap, input, options.capabilityName);
      if (support !== true) return unavailable(support);
      return fixedRequest(dap, input, options.command, options.args(input), request.signal);
    },
  });
}

export function dapToolDefinitions(
  dap: DebugAdapterSupervisor,
): readonly ProductLanguageToolDefinition[] {
  const definitions: ProductLanguageToolDefinition[] = [
    definition({
      name: "dap_start",
      title: "Start debug adapter",
      description: "Start and initialize one managed debug adapter",
      effect: "external",
      inputSchema: startSchema,
      execute: async (request) => {
        const input = parseInput(startSchema, request);
        if (input === null) return failed("malformed-input");
        const result = await dap.start(
          {
            serviceId: managedServiceId.from(input.serviceId),
            key: {
              workspaceRoot: input.workspaceRoot,
              adapterName: input.adapterName,
              configurationGeneration: configurationGeneration.from(input.configurationGeneration),
            },
            executable: input.executable,
            argv: input.argv,
            environment: input.environment,
            ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
            initialize: input.initialize,
            ...(input.limits === undefined ? {} : { limits: input.limits }),
          },
          request.signal,
        );
        return result.ok ? completed(result.value) : failed(errorCode(result.error));
      },
    }),
    definition({
      name: "dap_status",
      title: "Debug adapter status",
      description:
        "Inspect adapter lifecycle, negotiated capabilities, target state, and recent output",
      effect: "observation",
      inputSchema: sessionInputSchema,
      execute: async (request) => {
        const input = parseInput(sessionInputSchema, request);
        if (input === null) return failed("malformed-input");
        const state = ready(dap, input);
        if (state !== true) return unavailable(state);
        return completed(dap.snapshot(ids(input).serviceId));
      },
    }),
    definition({
      name: "dap_launch",
      title: "Launch debug target",
      description: "Launch one explicit debug configuration through the managed adapter",
      effect: "external",
      inputSchema: launchSchema,
      execute: async (request) => {
        const input = parseInput(launchSchema, request);
        if (input === null) return failed("malformed-input");
        const result = await dap.launch(
          ids(input).serviceId,
          ids(input).generation,
          {
            configuration: input.configuration,
            ...(input.noDebug === undefined ? {} : { noDebug: input.noDebug }),
          },
          request.signal,
        );
        return result.ok ? completed(result.value) : failed(errorCode(result.error));
      },
    }),
    definition({
      name: "dap_attach",
      title: "Attach debug target",
      description: "Attach one explicit target configuration through the managed adapter",
      effect: "external",
      inputSchema: targetSchema,
      execute: async (request) => {
        const input = parseInput(targetSchema, request);
        if (input === null) return failed("malformed-input");
        const result = await dap.attachTarget(
          ids(input).serviceId,
          ids(input).generation,
          { configuration: input.configuration },
          request.signal,
        );
        return result.ok ? completed(result.value) : failed(errorCode(result.error));
      },
    }),
    definition({
      name: "dap_configuration_done",
      title: "Finish debug configuration",
      description:
        "Notify a supporting adapter that breakpoints and launch configuration are complete",
      effect: "mutation",
      inputSchema: sessionInputSchema,
      execute: async (request) => {
        const input = parseInput(sessionInputSchema, request);
        if (input === null) return failed("malformed-input");
        const support = capability(dap, input, "supportsConfigurationDoneRequest");
        if (support !== true) return unavailable(support);
        const result = await dap.configurationDone(
          ids(input).serviceId,
          ids(input).generation,
          request.signal,
        );
        return result.ok ? completed(result.value) : failed(errorCode(result.error));
      },
    }),
    definition({
      name: "dap_set_breakpoints",
      title: "Set source breakpoints",
      description: "Replace the bounded source-breakpoint set for one file",
      effect: "mutation",
      inputSchema: breakpointsSchema,
      execute: async (request) => {
        const input = parseInput(breakpointsSchema, request);
        if (input === null) return failed("malformed-input");
        const result = await dap.setBreakpoints(
          ids(input).serviceId,
          ids(input).generation,
          {
            sourcePath: input.sourcePath,
            breakpoints: input.breakpoints,
            ...(input.sourceModified === undefined ? {} : { sourceModified: input.sourceModified }),
          },
          request.signal,
        );
        return result.ok ? completed(result.value) : failed(errorCode(result.error));
      },
    }),
  ];

  definitions.push(
    negotiatedRequestDefinition(dap, {
      name: "dap_set_function_breakpoints",
      title: "Set function breakpoints",
      description: "Replace the bounded function-breakpoint set",
      schema: functionBreakpointsSchema,
      capabilityName: "supportsFunctionBreakpoints",
      command: "setFunctionBreakpoints",
      args: (input: z.infer<typeof functionBreakpointsSchema>) => ({
        breakpoints: input.breakpoints,
      }),
    }),
    negotiatedRequestDefinition(dap, {
      name: "dap_set_instruction_breakpoints",
      title: "Set instruction breakpoints",
      description: "Replace the bounded instruction-breakpoint set",
      schema: instructionBreakpointsSchema,
      capabilityName: "supportsInstructionBreakpoints",
      command: "setInstructionBreakpoints",
      args: (input: z.infer<typeof instructionBreakpointsSchema>) => ({
        breakpoints: input.breakpoints,
      }),
    }),
    definition({
      name: "dap_set_exception_breakpoints",
      title: "Set exception breakpoints",
      description: "Replace exception filters negotiated by the adapter",
      effect: "mutation",
      inputSchema: exceptionBreakpointsSchema,
      execute: async (request) => {
        const input = parseInput(exceptionBreakpointsSchema, request);
        if (input === null) return failed("malformed-input");
        const filterIds = [
          ...input.filters,
          ...(input.filterOptions?.map((option) => option.filterId) ?? []),
        ];
        const support = exceptionFiltersSupported(dap, input, filterIds);
        if (support !== true) return unavailable(support);
        return fixedRequest(
          dap,
          input,
          "setExceptionBreakpoints",
          {
            filters: input.filters,
            ...(input.filterOptions === undefined ? {} : { filterOptions: input.filterOptions }),
          },
          request.signal,
        );
      },
    }),
  );

  definitions.push(
    definition({
      name: "dap_threads",
      title: "List debug threads",
      description: "Read the bounded thread list for the active target",
      effect: "observation",
      inputSchema: sessionInputSchema,
      execute: async (request) => {
        const input = parseInput(sessionInputSchema, request);
        if (input === null) return failed("malformed-input");
        const result = await dap.threads(
          ids(input).serviceId,
          ids(input).generation,
          request.signal,
        );
        return result.ok ? completed(result.value) : failed(errorCode(result.error));
      },
    }),
    definition({
      name: "dap_stack_trace",
      title: "Read debug stack",
      description: "Read bounded stack frames for one stopped thread generation",
      effect: "observation",
      inputSchema: stackSchema,
      execute: async (request) => {
        const input = parseInput(stackSchema, request);
        if (input === null) return failed("malformed-input");
        const result = await dap.stackTrace(
          ids(input).serviceId,
          ids(input).generation,
          {
            threadId: input.threadId,
            stoppedGeneration: input.stoppedGeneration,
            ...(input.startFrame === undefined ? {} : { startFrame: input.startFrame }),
            ...(input.levels === undefined ? {} : { levels: input.levels }),
          },
          request.signal,
        );
        return result.ok ? completed(result.value) : failed(errorCode(result.error));
      },
    }),
    definition({
      name: "dap_scopes",
      title: "Read debug scopes",
      description: "Read bounded scopes for one frame in a stopped generation",
      effect: "observation",
      inputSchema: frameSchema,
      execute: async (request) => {
        const input = parseInput(frameSchema, request);
        if (input === null) return failed("malformed-input");
        const result = await dap.scopes(
          ids(input).serviceId,
          ids(input).generation,
          { frameId: input.frameId, stoppedGeneration: input.stoppedGeneration },
          request.signal,
        );
        return result.ok ? completed(result.value) : failed(errorCode(result.error));
      },
    }),
    definition({
      name: "dap_variables",
      title: "Read debug variables",
      description: "Read bounded, redacted variables for one stopped generation",
      effect: "observation",
      inputSchema: variablesSchema,
      execute: async (request) => {
        const input = parseInput(variablesSchema, request);
        if (input === null) return failed("malformed-input");
        const result = await dap.variables(
          ids(input).serviceId,
          ids(input).generation,
          {
            variablesReference: input.variablesReference,
            stoppedGeneration: input.stoppedGeneration,
          },
          request.signal,
        );
        return result.ok ? completed(result.value) : failed(errorCode(result.error));
      },
    }),
    definition({
      name: "dap_evaluate",
      title: "Evaluate debug expression",
      description: "Evaluate one bounded expression; REPL context is classified as interactive",
      effect: "interactive",
      effectFor: (input) => (input.context === "repl" ? "interactive" : "observation"),
      inputSchema: evaluateSchema,
      execute: async (request) => {
        const input = parseInput(evaluateSchema, request);
        if (input === null) return failed("malformed-input");
        const result = await dap.evaluate(
          ids(input).serviceId,
          ids(input).generation,
          {
            expression: input.expression,
            stoppedGeneration: input.stoppedGeneration,
            ...(input.frameId === undefined ? {} : { frameId: input.frameId }),
            ...(input.context === undefined ? {} : { context: input.context }),
          },
          request.signal,
        );
        return result.ok ? completed(result.value) : failed(errorCode(result.error));
      },
    }),
    definition({
      name: "dap_set_variable",
      title: "Set debug variable",
      description: "Set one variable in a stopped generation without echoing the supplied value",
      effect: "interactive",
      inputSchema: setVariableSchema,
      execute: async (request) => {
        const input = parseInput(setVariableSchema, request);
        if (input === null) return failed("malformed-input");
        const state = stopped(dap, input);
        if (state !== true) return unavailable(state);
        const support = capability(dap, input, "supportsSetVariable");
        if (support !== true) return unavailable(support);
        const result = await dap.request(
          ids(input).serviceId,
          ids(input).generation,
          "setVariable",
          {
            variablesReference: input.variablesReference,
            name: input.name,
            value: input.value,
          },
          request.signal,
        );
        return result.ok ? completed({ updated: true }) : failed(errorCode(result.error));
      },
    }),
    definition({
      name: "dap_set_expression",
      title: "Set debug expression",
      description: "Set one expression in a stopped generation without echoing the supplied value",
      effect: "interactive",
      inputSchema: setExpressionSchema,
      execute: async (request) => {
        const input = parseInput(setExpressionSchema, request);
        if (input === null) return failed("malformed-input");
        const state = stopped(dap, input);
        if (state !== true) return unavailable(state);
        const support = capability(dap, input, "supportsSetExpression");
        if (support !== true) return unavailable(support);
        const result = await dap.request(
          ids(input).serviceId,
          ids(input).generation,
          "setExpression",
          {
            expression: input.expression,
            value: input.value,
            ...(input.frameId === undefined ? {} : { frameId: input.frameId }),
          },
          request.signal,
        );
        return result.ok ? completed({ updated: true }) : failed(errorCode(result.error));
      },
    }),
  );

  for (const item of [
    {
      name: "dap_continue",
      title: "Continue debug target",
      description: "Continue one stopped thread",
      command: "continue",
    },
    {
      name: "dap_next",
      title: "Step over",
      description: "Step over in one stopped thread",
      command: "next",
    },
    {
      name: "dap_step_in",
      title: "Step in",
      description: "Step into one stopped thread",
      command: "stepIn",
    },
    {
      name: "dap_step_out",
      title: "Step out",
      description: "Step out of one stopped thread",
      command: "stepOut",
    },
  ] as const) {
    definitions.push(
      definition({
        name: item.name,
        title: item.title,
        description: item.description,
        effect: "interactive",
        inputSchema: stoppedThreadSchema,
        execute: async (request) => {
          const input = parseInput(stoppedThreadSchema, request);
          if (input === null) return failed("malformed-input");
          if (item.command === "continue") {
            const result = await dap.continueExecution(
              ids(input).serviceId,
              ids(input).generation,
              { threadId: input.threadId, stoppedGeneration: input.stoppedGeneration },
              request.signal,
            );
            return result.ok ? completed(result.value) : failed(errorCode(result.error));
          }
          const state = stopped(dap, input);
          if (state !== true) return unavailable(state);
          return fixedRequest(
            dap,
            input,
            item.command,
            { threadId: input.threadId },
            request.signal,
          );
        },
      }),
    );
  }

  definitions.push(
    definition({
      name: "dap_pause",
      title: "Pause debug target",
      description: "Pause one running debug thread",
      effect: "interactive",
      inputSchema: threadSchema,
      execute: async (request) => {
        const input = parseInput(threadSchema, request);
        if (input === null) return failed("malformed-input");
        const state = ready(dap, input);
        if (state !== true) return unavailable(state);
        return fixedRequest(dap, input, "pause", { threadId: input.threadId }, request.signal);
      },
    }),
    definition({
      name: "dap_source",
      title: "Read debug source",
      description: "Read bounded source content by adapter source reference",
      effect: "observation",
      inputSchema: sourceSchema,
      execute: async (request) => {
        const input = parseInput(sourceSchema, request);
        if (input === null) return failed("malformed-input");
        return fixedRequest(
          dap,
          input,
          "source",
          {
            sourceReference: input.sourceReference,
            ...(input.sourcePath === undefined ? {} : { source: { path: input.sourcePath } }),
          },
          request.signal,
        );
      },
    }),
    definition({
      name: "dap_modules",
      title: "List debug modules",
      description: "Read a bounded page of modules when the adapter supports it",
      effect: "observation",
      inputSchema: modulesSchema,
      execute: async (request) => {
        const input = parseInput(modulesSchema, request);
        if (input === null) return failed("malformed-input");
        const support = capability(dap, input, "supportsModulesRequest");
        if (support !== true) return unavailable(support);
        return fixedRequest(
          dap,
          input,
          "modules",
          {
            ...(input.startModule === undefined ? {} : { startModule: input.startModule }),
            ...(input.moduleCount === undefined ? {} : { moduleCount: input.moduleCount }),
          },
          request.signal,
        );
      },
    }),
    definition({
      name: "dap_loaded_sources",
      title: "List loaded debug sources",
      description: "Read bounded loaded-source metadata when the adapter supports it",
      effect: "observation",
      inputSchema: sessionInputSchema,
      execute: async (request) => {
        const input = parseInput(sessionInputSchema, request);
        if (input === null) return failed("malformed-input");
        const support = capability(dap, input, "supportsLoadedSourcesRequest");
        if (support !== true) return unavailable(support);
        return fixedRequest(dap, input, "loadedSources", {}, request.signal);
      },
    }),
    definition({
      name: "dap_restart",
      title: "Restart debug target",
      description: "Restart the active target when the adapter negotiated restart support",
      effect: "external",
      inputSchema: sessionInputSchema,
      execute: async (request) => {
        const input = parseInput(sessionInputSchema, request);
        if (input === null) return failed("malformed-input");
        const support = capability(dap, input, "supportsRestartRequest");
        if (support !== true) return unavailable(support);
        return fixedRequest(dap, input, "restart", {}, request.signal);
      },
    }),
    definition({
      name: "dap_terminate",
      title: "Terminate debug target",
      description: "Terminate the active target with focused gateway authorization",
      effect: "external",
      inputSchema: terminateSchema,
      execute: async (request) => {
        const input = parseInput(terminateSchema, request);
        if (input === null) return failed("malformed-input");
        const support = capability(dap, input, "supportsTerminateRequest");
        if (support !== true) return unavailable(support);
        const result = await dap.terminate(
          ids(input).serviceId,
          ids(input).generation,
          { ...(input.restart === undefined ? {} : { restart: input.restart }) },
          request.signal,
        );
        return result.ok ? completed(result.value) : failed(errorCode(result.error));
      },
    }),
    definition({
      name: "dap_disconnect",
      title: "Disconnect debug session",
      description: "Disconnect the adapter and optionally terminate the debuggee",
      effect: "external",
      inputSchema: disconnectSchema,
      execute: async (request) => {
        const input = parseInput(disconnectSchema, request);
        if (input === null) return failed("malformed-input");
        const result = await dap.disconnect(ids(input).serviceId, ids(input).generation, {
          ...(input.restart === undefined ? {} : { restart: input.restart }),
          ...(input.terminateDebuggee === undefined
            ? {}
            : { terminateDebuggee: input.terminateDebuggee }),
          signal: request.signal,
        });
        return result.ok ? completed(result.value) : failed(errorCode(result.error));
      },
    }),
    definition({
      name: "dap_cancel",
      title: "Cancel debug request",
      description: "Cancel one adapter request or progress operation when negotiated",
      effect: "mutation",
      inputSchema: cancelSchema,
      execute: async (request) => {
        const input = parseInput(cancelSchema, request);
        if (input === null) return failed("malformed-input");
        const support = capability(dap, input, "supportsCancelRequest");
        if (support !== true) return unavailable(support);
        const result = await dap.cancel(
          ids(input).serviceId,
          ids(input).generation,
          {
            ...(input.requestId === undefined ? {} : { requestId: input.requestId }),
            ...(input.progressId === undefined ? {} : { progressId: input.progressId }),
          },
          request.signal,
        );
        return result.ok ? completed(result.value) : failed(errorCode(result.error));
      },
    }),
    definition({
      name: "dap_capture_session",
      title: "Capture debug session artifact",
      description: "Persist a bounded redacted exact debug-session artifact for recovery",
      effect: "observation",
      inputSchema: sessionInputSchema,
      execute: async (request) => {
        const input = parseInput(sessionInputSchema, request);
        if (input === null) return failed("malformed-input");
        const result = await dap.captureSessionArtifact(
          ids(input).serviceId,
          ids(input).generation,
          request.signal,
        );
        return result.ok ? completed(result.value) : failed(errorCode(result.error));
      },
    }),
  );

  return definitions;
}
