/** Retain bounded server-returned hierarchy items with their document generation. */
import { z } from "zod";
import { managedServiceId } from "../../../domain/foundation/index.ts";
import type { LanguageServerSupervisor } from "../../language/language-server.ts";
import { languageConfigurationDigest } from "./configuration.ts";
import {
  boundedProtocolObjectSchema,
  failed,
  type ProductLanguageToolDefinition,
  sessionSchema,
  unavailable,
} from "./contracts.ts";

const itemReferenceSchema = z
  .object({ ...sessionSchema, itemRef: z.string().regex(/^sha-256:[a-f0-9]{64}$/u) })
  .strict();
type RetainedItem = {
  readonly kind: "call" | "type";
  readonly serviceId: string;
  readonly generation: number;
  readonly uri: string;
  readonly version: number;
  readonly item: Readonly<Record<string, unknown>>;
  readonly bytes: number;
};

export function bindHierarchyReferences(
  definitions: readonly ProductLanguageToolDefinition[],
  lsp: LanguageServerSupervisor,
) {
  const items = new Map<string, RetainedItem>();
  let bytes = 0;
  const retain = (
    value: unknown,
    serviceId: string,
    generation: number,
    kind: "call" | "type",
    depth = 0,
  ): unknown => {
    if (depth > 8) return null;
    if (Array.isArray(value))
      return value.map((item) => retain(item, serviceId, generation, kind, depth + 1));
    if (typeof value !== "object" || value === null) return value;
    const item = value as Readonly<Record<string, unknown>>;
    if (
      typeof item.uri !== "string" ||
      typeof item.name !== "string" ||
      item.range === undefined ||
      item.selectionRange === undefined
    ) {
      return Object.fromEntries(
        Object.entries(item).map(([key, child]) => [
          key,
          retain(child, serviceId, generation, kind, depth + 1),
        ]),
      );
    }
    const parsed = boundedProtocolObjectSchema.safeParse(item);
    const document = lsp.document(managedServiceId.from(serviceId), item.uri);
    if (!parsed.success || document === null) return item;
    const binding = {
      kind,
      serviceId,
      generation,
      uri: item.uri,
      version: document.version,
      item: parsed.data,
    };
    const itemRef = languageConfigurationDigest(binding);
    const size = new TextEncoder().encode(JSON.stringify(binding)).byteLength;
    if (size > 256 * 1024) return item;
    if (!items.has(itemRef)) {
      while (items.size >= 512 || bytes + size > 256 * 1024) {
        const first = items.entries().next().value;
        if (first === undefined) break;
        items.delete(first[0]);
        bytes -= first[1].bytes;
      }
      items.set(itemRef, { ...binding, bytes: size });
      bytes += size;
    }
    const { data: _data, ...display } = item;
    return { ...display, itemRef };
  };
  return definitions.map((definition): ProductLanguageToolDefinition => {
    if (!definition.document.name.includes("_hierarchy_")) return definition;
    const prepare = definition.document.name.endsWith("_prepare");
    const kind = definition.document.name.startsWith("lsp_call_") ? "call" : "type";
    return {
      ...definition,
      inputSchema: prepare ? definition.inputSchema : itemReferenceSchema,
      document: {
        ...definition.document,
        description: `${definition.document.description}. Traversal requires a retained itemRef from this service and document generation.`,
      },
      async execute(request) {
        const { serviceId, generation } = request.input;
        if (typeof serviceId !== "string" || typeof generation !== "number")
          return failed("malformed-input");
        let input = request.input;
        if (!prepare) {
          const retained = typeof input.itemRef === "string" ? items.get(input.itemRef) : undefined;
          if (
            retained === undefined ||
            retained.kind !== kind ||
            retained.serviceId !== serviceId ||
            retained.generation !== generation
          )
            return unavailable("hierarchy-item-not-found");
          if (
            lsp.document(managedServiceId.from(serviceId), retained.uri)?.version !==
            retained.version
          )
            return unavailable("stale-hierarchy-item");
          input = { serviceId, generation, item: retained.item };
        }
        const before = lsp.snapshot(managedServiceId.from(serviceId));
        const outcome = await definition.execute({ ...request, input });
        if (outcome.status !== "completed") return outcome;
        const after = lsp.snapshot(managedServiceId.from(serviceId));
        if (
          before === null ||
          after === null ||
          before.generation !== after.generation ||
          JSON.stringify(before.openDocuments) !== JSON.stringify(after.openDocuments)
        )
          return unavailable("stale-hierarchy-item");
        return {
          ...outcome,
          output: {
            ...outcome.output,
            result: retain(outcome.output.result, serviceId, generation, kind),
          },
        };
      },
    };
  });
}
