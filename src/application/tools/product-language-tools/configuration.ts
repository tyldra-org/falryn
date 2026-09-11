/** User-owned startup and target options. Models receive only bound references. */
import { createHash } from "node:crypto";
import { z } from "zod";
import { boundedProtocolObjectSchema } from "./contracts.ts";
import { startSchema as dapStartSchema } from "./dap-schemas.ts";
import { startSchema as lspStartSchema } from "./lsp-schemas.ts";

export const LANGUAGE_SERVICES_KEY = "tools.languageServices";
const targetSchema = z
  .object({
    id: z.string().min(1).max(256),
    kind: z.enum(["launch", "attach"]),
    configuration: boundedProtocolObjectSchema,
    noDebug: z.boolean().optional(),
  })
  .strict();

export const languageServicesSchema = z
  .object({
    languageServers: z.array(lspStartSchema.omit({ configurationGeneration: true })).max(256),
    debugAdapters: z
      .array(
        dapStartSchema
          .omit({ configurationGeneration: true })
          .extend({
            targets: z.array(targetSchema).max(256),
          })
          .strict(),
      )
      .max(256),
  })
  .strict()
  .superRefine((value, context) => {
    const ids = [...value.languageServers, ...value.debugAdapters].map((item) => item.serviceId);
    if (
      new Set(ids).size !== ids.length ||
      value.debugAdapters.some(
        (adapter) =>
          new Set(adapter.targets.map((target) => target.id)).size !== adapter.targets.length,
      )
    ) {
      context.addIssue({ code: "custom", message: "duplicate service or target identity" });
    }
    if (new TextEncoder().encode(JSON.stringify(value)).byteLength > 256 * 1024) {
      context.addIssue({
        code: "custom",
        message: "service configuration exceeds protocol byte limit",
      });
    }
  });

export const EMPTY_LANGUAGE_SERVICES = { languageServers: [], debugAdapters: [] } as const;
export type LanguageServices = z.infer<typeof languageServicesSchema>;
export type LanguageServiceConfiguration = {
  readonly generation: number;
  readonly services: LanguageServices;
};

export function languageConfigurationDigest(value: unknown): string {
  return `sha-256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
}

export const configurationReferenceSchema = z
  .object({
    serviceId: z.string().min(1).max(256),
    configurationDigest: z.string().regex(/^sha-256:[a-f0-9]{64}$/u),
  })
  .strict();
