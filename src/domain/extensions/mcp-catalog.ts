/**
 * MCP catalog contributions (#131).
 *
 * A server's tools, resources, resource templates and prompts become bounded,
 * server-qualified descriptors. Server text is untrusted relevance data: it is
 * validated, bounded and counted here, never executed or trusted.
 */
import { z } from "zod";
import { definitionValueSchema } from "../orchestration/definition-values.ts";
import { canonicalDigest } from "./canonical.ts";

export const MCP_CATALOG_KINDS = ["tool", "resource", "resource-template", "prompt"] as const;
export type McpCatalogKind = (typeof MCP_CATALOG_KINDS)[number];
/** Server capability families that decide which lists discovery requests. */
export const MCP_SERVER_FEATURES = ["tools", "resources", "prompts"] as const;
export type McpServerFeature = (typeof MCP_SERVER_FEATURES)[number];

export const MCP_CATALOG_ENTRIES_PER_KIND = 1024;
export const MCP_CATALOG_DESCRIPTION_CHARACTERS = 1024;
export const MCP_CATALOG_NAME_CHARACTERS = 256;
export const MCP_CATALOG_URI_CHARACTERS = 2048;
export const MCP_CATALOG_ARGUMENTS = 32;
export const MCP_ARGUMENT_VALUE_CHARACTERS = 16 * 1024;

export type McpArgument = {
  readonly name: string;
  readonly description: string | null;
  readonly required: boolean;
};
type McpEntryBase = {
  /** `mcp:<server>/<kind>/<encoded name or URI>` */
  readonly id: string;
  readonly serverId: string;
  readonly name: string;
  readonly title: string | null;
  readonly description: string | null;
  readonly descriptionTruncated: boolean;
};
export type McpCatalogEntry =
  | (McpEntryBase & {
      readonly kind: "tool";
      /** The strict normalized input schema; null when the server schema is unsupported. */
      readonly inputSchema: Readonly<Record<string, unknown>> | null;
      readonly schemaDigest: string | null;
      /** Untrusted server hints; they never lower Falryn's effect or confirmation. */
      readonly annotations: Readonly<Record<string, boolean>> | null;
    })
  | (McpEntryBase & {
      readonly kind: "resource";
      readonly uri: string;
      readonly mimeType: string | null;
    })
  | (McpEntryBase & {
      readonly kind: "resource-template";
      readonly uriTemplate: string;
      readonly mimeType: string | null;
      /** Null when the template uses syntax beyond RFC 6570 level 3. */
      readonly arguments: readonly McpArgument[] | null;
    })
  | (McpEntryBase & { readonly kind: "prompt"; readonly arguments: readonly McpArgument[] });

export type McpCatalogCounts = {
  readonly malformed: number;
  readonly duplicates: number;
  readonly omitted: number;
};
export type McpCatalogLists = {
  readonly tools?: unknown;
  readonly resources?: unknown;
  readonly resourceTemplates?: unknown;
  readonly prompts?: unknown;
};

export function mcpEntryId(serverId: string, kind: McpCatalogKind, key: string): string {
  return `mcp:${serverId}/${kind}/${encodeURIComponent(key)}`;
}

function controlFree(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (codePoint < 32 || codePoint === 127) return false;
  }
  return true;
}
const name = z.string().min(1).max(MCP_CATALOG_NAME_CHARACTERS).refine(controlFree);
const uri = z
  .string()
  .min(1)
  .max(MCP_CATALOG_URI_CHARACTERS)
  .refine((value) => controlFree(value) && /^[A-Za-z][A-Za-z0-9+.-]*:/u.test(value));
const optionalText = z.string().nullish();
const mimeType = z
  .string()
  .max(128)
  .regex(/^[!-~]+\/[!-~]+$/u)
  .nullish()
  .catch(null);
const common = { name, title: optionalText, description: optionalText };
const itemSchemas = {
  tool: z.looseObject({
    ...common,
    inputSchema: z.unknown().optional(),
    annotations: z.unknown().optional(),
  }),
  resource: z.looseObject({ ...common, uri, mimeType }),
  "resource-template": z.looseObject({ ...common, uriTemplate: uri, mimeType }),
  prompt: z.looseObject({
    ...common,
    arguments: z
      .array(z.looseObject({ name, description: optionalText, required: z.boolean().nullish() }))
      .max(MCP_CATALOG_ARGUMENTS)
      .nullish(),
  }),
} as const;
type RawItem = {
  readonly name: string;
  readonly inputSchema?: unknown;
  readonly annotations?: unknown;
  readonly title?: string | null | undefined;
  readonly description?: string | null | undefined;
  readonly uri?: string;
  readonly uriTemplate?: string;
  readonly mimeType?: string | null | undefined;
  readonly arguments?:
    | readonly {
        readonly name: string;
        readonly description?: string | null | undefined;
        readonly required?: boolean | null | undefined;
      }[]
    | null
    | undefined;
};
const lists = {
  tool: ["tools", "tools"],
  resource: ["resources", "resources"],
  "resource-template": ["resourceTemplates", "resourceTemplates"],
  prompt: ["prompts", "prompts"],
} as const satisfies Record<McpCatalogKind, readonly [keyof McpCatalogLists, string]>;

function bounded(value: string | null | undefined) {
  if (value === null || value === undefined || value.length === 0)
    return { text: null, truncated: false };
  const characters = [...value];
  return characters.length > MCP_CATALOG_DESCRIPTION_CHARACTERS
    ? { text: characters.slice(0, MCP_CATALOG_DESCRIPTION_CHARACTERS).join(""), truncated: true }
    : { text: value, truncated: false };
}

function entryFor(serverId: string, kind: McpCatalogKind, item: RawItem): McpCatalogEntry {
  const key = item.uri ?? item.uriTemplate ?? item.name;
  const description = bounded(item.description);
  const base = {
    id: mcpEntryId(serverId, kind, key),
    serverId,
    name: item.name,
    title: item.title ? item.title.slice(0, MCP_CATALOG_NAME_CHARACTERS) : null,
    description: description.text,
    descriptionTruncated: description.truncated,
  };
  if (kind === "tool") {
    const schema = normalizeMcpToolSchema(item.inputSchema);
    return {
      ...base,
      kind,
      inputSchema: schema?.schema ?? null,
      schemaDigest: schema?.digest ?? null,
      annotations: toolHints(item.annotations),
    };
  }
  if (kind === "resource")
    return { ...base, kind, uri: item.uri ?? "", mimeType: item.mimeType ?? null };
  if (kind === "resource-template") {
    const template = parseUriTemplate(item.uriTemplate ?? "");
    return {
      ...base,
      kind,
      uriTemplate: item.uriTemplate ?? "",
      mimeType: item.mimeType ?? null,
      arguments: template.ok ? template.value.arguments : null,
    };
  }
  const declared = new Map<string, McpArgument>();
  for (const argument of item.arguments ?? [])
    if (!declared.has(argument.name))
      declared.set(argument.name, {
        name: argument.name,
        description: bounded(argument.description).text,
        required: argument.required === true,
      });
  return { ...base, kind, arguments: [...declared.values()] };
}

/**
 * Normalize one server's list results. An absent list was not requested; a
 * present list without its item array is malformed as a whole.
 */
export function normalizeMcpCatalog(
  serverId: string,
  results: McpCatalogLists,
): { readonly entries: readonly McpCatalogEntry[]; readonly counts: McpCatalogCounts } {
  const entries: McpCatalogEntry[] = [];
  const counts = { malformed: 0, duplicates: 0, omitted: 0 };
  for (const kind of MCP_CATALOG_KINDS) {
    const [resultKey, field] = lists[kind];
    const result = results[resultKey];
    if (result === undefined) continue;
    const items =
      result && typeof result === "object" ? (result as Record<string, unknown>)[field] : undefined;
    if (!Array.isArray(items)) {
      counts.malformed++;
      continue;
    }
    const seen = new Set<string>();
    for (const item of items) {
      const parsed = itemSchemas[kind].safeParse(item);
      if (!parsed.success) {
        counts.malformed++;
        continue;
      }
      const entry = entryFor(serverId, kind, parsed.data as RawItem);
      if (seen.has(entry.id)) counts.duplicates++;
      else if (seen.size >= MCP_CATALOG_ENTRIES_PER_KIND) counts.omitted++;
      else {
        seen.add(entry.id);
        entries.push(entry);
      }
    }
  }
  return { entries, counts };
}

/** Keys that describe a schema without constraining values; dropped before validation. */
const SCHEMA_ANNOTATIONS = new Set([
  "$schema",
  "$id",
  "$comment",
  "title",
  "default",
  "examples",
  "format",
  "readOnly",
  "writeOnly",
  "deprecated",
]);
const TOOL_HINTS = ["readOnlyHint", "destructiveHint", "idempotentHint", "openWorldHint"] as const;

function withoutAnnotations(value: unknown, depth: number): unknown {
  if (depth > 16 || value === null || typeof value !== "object" || Array.isArray(value))
    return value;
  const result: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    if (SCHEMA_ANNOTATIONS.has(key)) continue;
    if (
      key === "properties" &&
      child !== null &&
      typeof child === "object" &&
      !Array.isArray(child)
    )
      result[key] = Object.fromEntries(
        Object.entries(child).map(([name, schema]) => [
          name,
          withoutAnnotations(schema, depth + 1),
        ]),
      );
    else if (key === "items") result[key] = withoutAnnotations(child, depth + 1);
    else result[key] = child;
  }
  // An object that does not declare extra properties is closed for the model boundary.
  if (result.type === "object") {
    result.properties ??= {};
    result.additionalProperties ??= false;
  }
  return result;
}

/**
 * Normalize an untrusted tool input schema into the bounded definition subset. Anything
 * still outside it (unions, references, open objects) is unsupported rather than guessed.
 */
export function normalizeMcpToolSchema(
  schema: unknown,
): { readonly schema: Readonly<Record<string, unknown>>; readonly digest: string } | null {
  const parsed = definitionValueSchema.safeParse(withoutAnnotations(schema, 0));
  if (!parsed.success || parsed.data.type !== "object") return null;
  return { schema: parsed.data, digest: canonicalDigest(parsed.data) };
}

function toolHints(value: unknown): Readonly<Record<string, boolean>> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const hints = Object.fromEntries(
    TOOL_HINTS.flatMap((key) => {
      const hint = (value as Record<string, unknown>)[key];
      return typeof hint === "boolean" ? [[key, hint]] : [];
    }),
  );
  return Object.keys(hints).length > 0 ? hints : null;
}

export type McpArgumentError = {
  readonly code: "mcp-argument-unknown" | "mcp-argument-missing" | "mcp-argument-invalid";
  readonly name: string;
};

/** Validate caller values against declared arguments: no unknown or missing names. */
export function validateMcpArguments(
  declared: readonly McpArgument[],
  values: Readonly<Record<string, string>>,
): McpArgumentError | null {
  const names = new Set(declared.map((argument) => argument.name));
  for (const [key, value] of Object.entries(values)) {
    if (!names.has(key)) return { code: "mcp-argument-unknown", name: key };
    if (value.length > MCP_ARGUMENT_VALUE_CHARACTERS || !controlFree(value))
      return { code: "mcp-argument-invalid", name: key };
  }
  for (const argument of declared)
    if (argument.required && !Object.hasOwn(values, argument.name))
      return { code: "mcp-argument-missing", name: argument.name };
  return null;
}

type Operator = {
  readonly first: string;
  readonly separator: string;
  readonly named: boolean;
  readonly ifEmpty: string;
  readonly reserved: boolean;
};
// RFC 6570 section 3.2 operators, limited to level 3 (no prefix or explode modifiers).
const OPERATORS: ReadonlyMap<string, Operator> = new Map([
  ["", { first: "", separator: ",", named: false, ifEmpty: "", reserved: false }],
  ["+", { first: "", separator: ",", named: false, ifEmpty: "", reserved: true }],
  ["#", { first: "#", separator: ",", named: false, ifEmpty: "", reserved: true }],
  [".", { first: ".", separator: ".", named: false, ifEmpty: "", reserved: false }],
  ["/", { first: "/", separator: "/", named: false, ifEmpty: "", reserved: false }],
  [";", { first: ";", separator: ";", named: true, ifEmpty: "", reserved: false }],
  ["?", { first: "?", separator: "&", named: true, ifEmpty: "=", reserved: false }],
  ["&", { first: "&", separator: "&", named: true, ifEmpty: "=", reserved: false }],
]);
/** Query-style expressions may be omitted; path-forming variables are required. */
const OPTIONAL_OPERATORS = new Set([";", "?", "&"]);
const VARIABLE = /^(?:[A-Za-z0-9_]|%[0-9A-Fa-f]{2})(?:\.?(?:[A-Za-z0-9_]|%[0-9A-Fa-f]{2}))*$/u;
type TemplatePart =
  | { readonly literal: string }
  | { readonly operator: Operator; readonly variables: readonly string[] };
export type McpUriTemplate = {
  readonly parts: readonly TemplatePart[];
  readonly arguments: readonly McpArgument[];
};

export function parseUriTemplate(
  template: string,
): { ok: true; value: McpUriTemplate } | { ok: false } {
  const parts: TemplatePart[] = [];
  const declared = new Map<string, McpArgument>();
  for (const token of template.split(/(\{[^{}]*\})/u)) {
    if (token.length === 0) continue;
    if (!token.startsWith("{")) {
      if (/[{}]/u.test(token)) return { ok: false };
      parts.push({ literal: token });
      continue;
    }
    const expression = token.slice(1, -1);
    const key = OPERATORS.has(expression.slice(0, 1)) ? expression.slice(0, 1) : "";
    const operator = OPERATORS.get(key);
    const variables = expression.slice(key.length).split(",");
    if (!operator || !variables.every((variable) => VARIABLE.test(variable))) return { ok: false };
    for (const variable of variables)
      if (!declared.has(variable))
        declared.set(variable, {
          name: variable,
          description: null,
          required: !OPTIONAL_OPERATORS.has(key),
        });
    parts.push({ operator, variables });
  }
  if (declared.size > MCP_CATALOG_ARGUMENTS) return { ok: false };
  return { ok: true, value: { parts, arguments: [...declared.values()] } };
}

const UNRESERVED = /^[A-Za-z0-9\-._~]$/u;
const RESERVED = /^[:/?#[\]@!$&'()*+,;=]$/u;
const encoder = new TextEncoder();
function encode(value: string, reserved: boolean): string {
  let output = "";
  const characters = [...value];
  for (const [index, character] of characters.entries()) {
    const triplet = characters.slice(index, index + 3).join("");
    if ((reserved && /^%[0-9A-Fa-f]{2}$/u.test(triplet)) || UNRESERVED.test(character))
      output += character;
    else if (reserved && RESERVED.test(character)) output += character;
    else
      for (const byte of encoder.encode(character))
        output += `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
  }
  return output;
}

/** Expand a parsed template with validated values (RFC 6570 section 3.2). */
export function expandUriTemplate(
  template: McpUriTemplate,
  values: Readonly<Record<string, string>>,
): string {
  let output = "";
  for (const part of template.parts) {
    if ("literal" in part) {
      output += encode(part.literal, true);
      continue;
    }
    const expanded: string[] = [];
    for (const variable of part.variables) {
      const value = values[variable];
      if (value === undefined) continue;
      const encoded = encode(value, part.operator.reserved);
      expanded.push(
        !part.operator.named
          ? encoded
          : value.length === 0
            ? variable + part.operator.ifEmpty
            : variable + "=" + encoded,
      );
    }
    if (expanded.length > 0) output += part.operator.first + expanded.join(part.operator.separator);
  }
  return output;
}
