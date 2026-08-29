import { z } from "zod";

import {
  boundedProtocolObjectSchema,
  boundedStringMapSchema,
  pathSchema,
  serviceIdSchema,
  sessionSchema,
} from "./contracts.ts";

const stringArray = z.array(z.string().max(4_096)).max(256);
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

export const startSchema = z
  .object({
    serviceId: serviceIdSchema,
    workspaceRoot: pathSchema,
    adapterName: z.string().min(1).max(64),
    configurationGeneration: z.number().int().nonnegative(),
    executable: pathSchema,
    argv: stringArray,
    environment: boundedStringMapSchema,
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
export const targetSchema = z
  .object({
    ...sessionSchema,
    configuration: boundedProtocolObjectSchema,
  })
  .strict();
export const launchSchema = targetSchema.extend({ noDebug: z.boolean().optional() }).strict();
const breakpointSchema = z
  .object({
    line: z.number().int().positive(),
    column: z.number().int().positive().optional(),
    condition: z.string().max(4_096).optional(),
    hitCondition: z.string().max(4_096).optional(),
    logMessage: z.string().max(4_096).optional(),
  })
  .strict();
export const breakpointsSchema = z
  .object({
    ...sessionSchema,
    sourcePath: pathSchema,
    breakpoints: z.array(breakpointSchema).max(256),
    sourceModified: z.boolean().optional(),
  })
  .strict();
export const functionBreakpointsSchema = z
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
export const instructionBreakpointsSchema = z
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
export const exceptionBreakpointsSchema = z
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
export const threadSchema = z
  .object({ ...sessionSchema, threadId: z.number().int().positive() })
  .strict();
export const stoppedThreadSchema = threadSchema
  .extend({ stoppedGeneration: z.number().int().positive() })
  .strict();
export const stackSchema = stoppedThreadSchema
  .extend({
    startFrame: z.number().int().nonnegative().optional(),
    levels: z.number().int().positive().max(512).optional(),
  })
  .strict();
export const frameSchema = z
  .object({
    ...sessionSchema,
    frameId: z.number().int().nonnegative(),
    stoppedGeneration: z.number().int().positive(),
  })
  .strict();
export const variablesSchema = z
  .object({
    ...sessionSchema,
    variablesReference: z.number().int().positive(),
    stoppedGeneration: z.number().int().positive(),
  })
  .strict();
export const evaluateSchema = z
  .object({
    ...sessionSchema,
    expression: z.string().min(1).max(4_096),
    stoppedGeneration: z.number().int().positive(),
    frameId: z.number().int().nonnegative().optional(),
    context: z.enum(["watch", "repl", "hover", "clipboard"]).optional(),
  })
  .strict();
export const setVariableSchema = z
  .object({
    ...sessionSchema,
    variablesReference: z.number().int().positive(),
    name: z.string().min(1).max(256),
    value: z.string().max(4_096),
    stoppedGeneration: z.number().int().positive(),
  })
  .strict();
export const setExpressionSchema = z
  .object({
    ...sessionSchema,
    expression: z.string().min(1).max(4_096),
    value: z.string().max(4_096),
    frameId: z.number().int().nonnegative().optional(),
    stoppedGeneration: z.number().int().positive(),
  })
  .strict();
export const disconnectSchema = z
  .object({
    ...sessionSchema,
    restart: z.boolean().optional(),
    terminateDebuggee: z.boolean().optional(),
  })
  .strict();
export const terminateSchema = z
  .object({ ...sessionSchema, restart: z.boolean().optional() })
  .strict();
export const cancelSchema = z
  .object({
    ...sessionSchema,
    requestId: z.number().int().positive().optional(),
    progressId: z.string().min(1).max(256).optional(),
  })
  .strict()
  .refine((value) => value.requestId !== undefined || value.progressId !== undefined, {
    message: "requestId or progressId is required",
  });
export const sourceSchema = z
  .object({
    ...sessionSchema,
    sourceReference: z.number().int().positive(),
    sourcePath: pathSchema.optional(),
  })
  .strict();
export const modulesSchema = z
  .object({
    ...sessionSchema,
    startModule: z.number().int().nonnegative().optional(),
    moduleCount: z.number().int().positive().max(512).optional(),
  })
  .strict();
