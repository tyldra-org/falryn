import { expect, test } from "bun:test";
import {
  expandUriTemplate,
  MCP_CATALOG_DESCRIPTION_CHARACTERS,
  MCP_CATALOG_ENTRIES_PER_KIND,
  mcpEntryId,
  normalizeMcpCatalog,
  normalizeMcpToolSchema,
  parseUriTemplate,
  validateMcpArguments,
} from "./mcp-catalog.ts";

test("normalizes server lists into bounded, server-qualified entries", () => {
  const long = "d".repeat(MCP_CATALOG_DESCRIPTION_CHARACTERS + 5);
  const { entries, counts } = normalizeMcpCatalog("docs", {
    tools: { tools: [{ name: "search", description: "Search" }, { name: "search" }] },
    resources: {
      resources: [
        { uri: "file:///a b", name: "a", mimeType: "text/plain", description: long },
        { uri: "relative/path", name: "no-scheme" },
        { name: "missing-uri" },
      ],
    },
    resourceTemplates: {
      resourceTemplates: [
        { uriTemplate: "docs://{id}", name: "doc" },
        { uriTemplate: "docs://{id*}", name: "exploded" },
      ],
    },
    prompts: {
      prompts: [
        {
          name: "review",
          arguments: [
            { name: "topic", required: true },
            { name: "topic", required: false },
            { name: "tone" },
          ],
        },
      ],
    },
  });
  expect(counts).toEqual({ malformed: 2, duplicates: 1, omitted: 0 });
  expect(entries.map((entry) => entry.id)).toEqual([
    "mcp:docs/tool/search",
    mcpEntryId("docs", "resource", "file:///a b"),
    "mcp:docs/resource-template/docs%3A%2F%2F%7Bid%7D",
    "mcp:docs/resource-template/docs%3A%2F%2F%7Bid*%7D",
    "mcp:docs/prompt/review",
  ]);
  const resource = entries[1];
  expect(resource?.kind === "resource" && resource.description?.length).toBe(
    MCP_CATALOG_DESCRIPTION_CHARACTERS,
  );
  expect(resource?.descriptionTruncated).toBe(true);
  const [supported, exploded] = entries.filter((entry) => entry.kind === "resource-template");
  expect(supported?.kind === "resource-template" && supported.arguments).toEqual([
    { name: "id", description: null, required: true },
  ]);
  expect(exploded?.kind === "resource-template" && exploded.arguments).toBeNull();
  const prompt = entries[4];
  expect(prompt?.kind === "prompt" && prompt.arguments).toEqual([
    { name: "topic", description: null, required: true },
    { name: "tone", description: null, required: false },
  ]);
});

test("a list without its item array is malformed and excess entries are counted", () => {
  const many = Array.from({ length: MCP_CATALOG_ENTRIES_PER_KIND + 3 }, (_, index) => ({
    name: "tool-" + index,
  }));
  const { entries, counts } = normalizeMcpCatalog("s", { tools: { tools: many }, prompts: {} });
  expect(entries).toHaveLength(MCP_CATALOG_ENTRIES_PER_KIND);
  expect(counts).toEqual({ malformed: 1, duplicates: 0, omitted: 3 });
  expect(normalizeMcpCatalog("s", {}).entries).toEqual([]);
});

test("arguments reject unknown, missing and control-character values", () => {
  const declared = [
    { name: "topic", description: null, required: true },
    { name: "tone", description: null, required: false },
  ];
  expect(validateMcpArguments(declared, { topic: "x" })).toBeNull();
  expect(validateMcpArguments(declared, { tone: "x" })).toEqual({
    code: "mcp-argument-missing",
    name: "topic",
  });
  expect(validateMcpArguments(declared, { topic: "x", other: "y" })).toEqual({
    code: "mcp-argument-unknown",
    name: "other",
  });
  expect(validateMcpArguments(declared, { topic: "a\u0000b" })?.code).toBe("mcp-argument-invalid");
});

test("URI templates expand RFC 6570 level 1-3 and refuse other syntax", () => {
  const expand = (template: string, values: Record<string, string>) => {
    const parsed = parseUriTemplate(template);
    if (!parsed.ok) throw new Error("unsupported " + template);
    return expandUriTemplate(parsed.value, values);
  };
  expect(expand("docs://{name}", { name: "a b/c" })).toBe("docs://a%20b%2Fc");
  expect(expand("file://{+path}", { path: "/src/a b.ts" })).toBe("file:///src/a%20b.ts");
  expect(expand("x://h{/a,b}", { a: "1", b: "2" })).toBe("x://h/1/2");
  expect(expand("x://h{.ext}", { ext: "json" })).toBe("x://h.json");
  expect(expand("x://h{#frag}", { frag: "a/b" })).toBe("x://h#a/b");
  expect(expand("x://h{;p}", { p: "" })).toBe("x://h;p");
  expect(expand("x://h{?q,lang}", { q: "caf\u00e9" })).toBe("x://h?q=caf%C3%A9");
  expect(expand("x://h/{a}{&b}", { a: "1", b: "" })).toBe("x://h/1&b=");
  const parsed = parseUriTemplate("x://{a}{?b}");
  expect(parsed.ok && parsed.value.arguments.map((argument) => argument.required)).toEqual([
    true,
    false,
  ]);
  for (const template of ["x://{a:3}", "x://{a*}", "x://{a", "x://a}", "x://{}", "x://{=a}"])
    expect(parseUriTemplate(template).ok).toBe(false);
});

test("tool schemas normalize into the strict subset or become unsupported", () => {
  const normalized = normalizeMcpToolSchema({
    $schema: "https://json-schema.org/draft/2020-12/schema",
    title: "Search",
    type: "object",
    properties: {
      title: { type: "string", title: "Title", default: "x", format: "uri" },
      tags: { type: "array", items: { type: "object", properties: { name: { type: "string" } } } },
    },
    required: ["title"],
  });
  expect(normalized?.schema).toEqual({
    type: "object",
    properties: {
      title: { type: "string" },
      tags: {
        type: "array",
        items: {
          type: "object",
          properties: { name: { type: "string" } },
          additionalProperties: false,
        },
      },
    },
    required: ["title"],
    additionalProperties: false,
  });
  expect(normalized?.digest).toMatch(/^sha256:/u);
  expect(normalizeMcpToolSchema({ type: "object" })?.schema).toEqual({
    type: "object",
    properties: {},
    additionalProperties: false,
  });
  for (const unsupported of [
    undefined,
    { type: "string" },
    { type: "object", additionalProperties: true },
    { type: "object", properties: { v: { anyOf: [{ type: "string" }] } } },
    { type: "object", properties: { v: { $ref: "#/defs/v" } } },
  ])
    expect(normalizeMcpToolSchema(unsupported)).toBeNull();
  const { entries } = normalizeMcpCatalog("s", {
    tools: {
      tools: [
        { name: "a", annotations: { readOnlyHint: true, title: "ignored", destructiveHint: "no" } },
      ],
    },
  });
  expect(entries[0]).toMatchObject({
    kind: "tool",
    inputSchema: null,
    schemaDigest: null,
    annotations: { readOnlyHint: true },
  });
});
