import { describe, expect, test } from "bun:test";

import { BUILTIN_MODEL_CATALOGS } from "./builtins.ts";
import { parseModelCatalogDocument } from "./schema.ts";

describe("model catalog documents", () => {
  test("validates every catalog compiled into the application", () => {
    expect(BUILTIN_MODEL_CATALOGS.length).toBeGreaterThan(0);
    for (const catalog of BUILTIN_MODEL_CATALOGS) {
      expect(parseModelCatalogDocument(catalog)).toEqual({ ok: true, value: catalog });
    }
  });

  test("bundles the current Command Code execution catalog with verified facts", () => {
    const catalog = BUILTIN_MODEL_CATALOGS.find(
      (candidate) => candidate.catalogId === "falryn.commandcode",
    );
    expect(catalog?.models).toHaveLength(62);
    expect(catalog?.models.find((model) => model.modelId === "claude-sonnet-5")).toMatchObject({
      inputModalities: ["text", "image"],
      tools: "supported",
      streaming: "supported",
      reasoning: "supported",
      contextTokens: 1_000_000,
      outputTokens: null,
      completeness: "partial",
    });
    expect(
      catalog?.models.find((model) => model.modelId === "deepseek/deepseek-v4-pro"),
    ).toMatchObject({
      inputModalities: ["text"],
      reasoning: "supported",
      contextTokens: 1_000_000,
    });
  });

  test("rejects duplicate models and unknown fields", () => {
    const source = BUILTIN_MODEL_CATALOGS[0];
    expect(source).toBeDefined();
    if (source === undefined) {
      return;
    }
    const duplicate = parseModelCatalogDocument({
      ...source,
      models: [source.models[0], source.models[0]],
    });
    expect(duplicate.ok).toBe(false);

    const unknown = parseModelCatalogDocument({ ...source, credential: "secret" });
    expect(unknown.ok).toBe(false);
  });
});
