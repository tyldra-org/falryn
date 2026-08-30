import { describe, expect, test } from "bun:test";

import { BUILTIN_MODEL_CATALOGS } from "./builtins.ts";
import { parseModelCatalogDocument } from "./schema.ts";

describe("model catalog documents", () => {
  test("validates every catalog compiled into the application", () => {
    expect(BUILTIN_MODEL_CATALOGS.length).toBeGreaterThan(0);
    for (const catalog of BUILTIN_MODEL_CATALOGS) {
      expect(parseModelCatalogDocument(catalog)).toEqual({ ok: true, value: catalog });
      expect(
        catalog.models.every(
          (model) => model.pricing !== undefined && model.responseDensityControls !== undefined,
        ),
      ).toBe(true);
    }
  });

  test("bundles the current Command Code execution catalog with verified facts", () => {
    const catalog = BUILTIN_MODEL_CATALOGS.find(
      (candidate) => candidate.catalogId === "falryn.commandcode",
    );
    expect(catalog?.models).toHaveLength(62);
    expect(catalog?.models.every((model) => model.pricing?.kind !== "unknown")).toBe(true);
    expect(catalog?.models.find((model) => model.modelId === "claude-sonnet-5")).toMatchObject({
      inputModalities: ["text", "image"],
      tools: "supported",
      streaming: "supported",
      reasoning: "supported",
      responseDensityControls: [],
      contextTokens: 1_000_000,
      outputTokens: null,
      completeness: "partial",
      pricing: {
        kind: "published-estimate",
        billingMode: "provider-credit",
      },
    });
    const deepSeek = catalog?.models.find((model) => model.modelId === "deepseek/deepseek-v4-pro");
    expect(deepSeek).toMatchObject({
      inputModalities: ["text"],
      reasoning: "supported",
      contextTokens: 1_000_000,
    });
    expect(deepSeek?.pricing?.tiers.map((tier) => tier.id)).toEqual(["off-peak", "peak"]);
    expect(deepSeek?.pricing?.tiers[0]?.utcWindows[0]?.startMinuteInclusive).toBe(0);
    expect(deepSeek?.pricing?.tiers[1]?.utcWindows[0]?.startMinuteInclusive).toBe(60);
    const freeMiniMax = catalog?.models.find(
      (model) => model.modelId === "minimax/minimax-m3-free",
    );
    expect(freeMiniMax?.pricing?.kind).toBe("free");
    expect(freeMiniMax?.pricing?.tiers[0]?.effectiveUntil).toBe("2026-09-06T00:00:00Z");
    expect(freeMiniMax?.pricing?.tiers[0]?.usdMicrosPerMillionTokens).toMatchObject({
      input: 0,
      output: 0,
      cachedInput: 0,
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
