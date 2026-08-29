import { z } from "zod";

import {
  boundedProtocolObjectSchema,
  boundedStringMapSchema,
  boundedTextSchema,
  pathSchema,
  positionInputSchema,
  rangeSchema,
  serviceIdSchema,
  sessionSchema,
  uriSchema,
} from "./contracts.ts";

const stringArray = z.array(z.string().max(4_096)).max(256);
const workspaceFolderSchema = z
  .object({ uri: uriSchema, name: z.string().min(1).max(256) })
  .strict();
const limitsSchema = z
  .object({
    initializeTimeoutMs: z.number().int().positive().optional(),
    shutdownTimeoutMs: z.number().int().positive().optional(),
    requestTimeoutMs: z.number().int().positive().optional(),
    maxRestarts: z.number().int().nonnegative().optional(),
    restartWindowMs: z.number().int().positive().optional(),
    maxFrameBytes: z.number().int().positive().optional(),
  })
  .strict();

const startFields = {
  serviceId: serviceIdSchema,
  workspaceRoot: pathSchema,
  serverName: z.string().min(1).max(64),
  configurationGeneration: z.number().int().nonnegative(),
  executable: pathSchema,
  argv: stringArray,
  environment: boundedStringMapSchema,
  cwd: pathSchema.optional(),
  initialize: z
    .object({
      processId: z.number().int().nonnegative().nullable(),
      rootUri: uriSchema.nullable(),
      workspaceFolders: z.array(workspaceFolderSchema).max(64).nullable(),
      capabilities: boundedProtocolObjectSchema,
      clientInfo: z
        .object({ name: z.string().min(1).max(64), version: z.string().max(64) })
        .strict(),
      locale: z.string().min(1).max(64).optional(),
    })
    .strict(),
  limits: limitsSchema.optional(),
} as const;

export const startSchema = z.object(startFields).strict();
export const restartSchema = z
  .object({ ...startFields, generation: z.number().int().nonnegative() })
  .strict();
export const documentSchema = z.object({ ...sessionSchema, uri: uriSchema }).strict();
export const openSchema = z
  .object({
    ...sessionSchema,
    uri: uriSchema,
    languageId: z.string().min(1).max(64),
    text: boundedTextSchema,
    version: z.number().int().positive().optional(),
  })
  .strict();
const contentChangeSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("full"), text: boundedTextSchema }).strict(),
  z
    .object({ kind: z.literal("incremental"), text: boundedTextSchema, range: rangeSchema })
    .strict(),
]);
export const changeSchema = z
  .object({
    ...sessionSchema,
    uri: uriSchema,
    version: z.number().int().positive(),
    contentChanges: z.array(contentChangeSchema).min(1).max(1_024),
  })
  .strict();
export const saveSchema = z
  .object({ ...sessionSchema, uri: uriSchema, text: boundedTextSchema.optional() })
  .strict();
export const workspaceFoldersSchema = z
  .object({
    ...sessionSchema,
    added: z.array(workspaceFolderSchema).max(64),
    removed: z.array(workspaceFolderSchema).max(64),
  })
  .strict();
export const referencesSchema = positionInputSchema
  .extend({ includeDeclaration: z.boolean().default(true) })
  .strict();
export const workspaceSymbolsSchema = z
  .object({ ...sessionSchema, query: z.string().max(4_096) })
  .strict();
export const formatSchema = z
  .object({
    ...sessionSchema,
    uri: uriSchema,
    tabSize: z.number().int().positive().max(32).optional(),
    insertSpaces: z.boolean().optional(),
  })
  .strict();
export const rangeFormatSchema = formatSchema.extend({ range: rangeSchema }).strict();
export const renameSchema = positionInputSchema
  .extend({ newName: z.string().min(1).max(1_024) })
  .strict();
export const codeActionSchema = z
  .object({
    ...sessionSchema,
    uri: uriSchema,
    range: rangeSchema,
    only: z.array(z.string().min(1).max(256)).max(64).optional(),
  })
  .strict();
export const hierarchyItemSchema = z
  .object({
    ...sessionSchema,
    item: boundedProtocolObjectSchema,
  })
  .strict();

export { positionInputSchema };
