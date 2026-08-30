import { describe, expect, test } from "bun:test";

import {
  COMMAND_CODE_MODEL_MANIFESTS,
  COMMAND_CODE_MODEL_REASONING_CONTROLS,
} from "../command-code.ts";
import { BUILTIN_MODEL_CATALOGS } from "./builtins.ts";
import { parseModelCatalogDocument } from "./schema.ts";

describe("model catalog documents", () => {
  test("validates every catalog compiled into the application", () => {
    expect(BUILTIN_MODEL_CATALOGS.length).toBeGreaterThan(0);
    for (const catalog of BUILTIN_MODEL_CATALOGS) {
      expect(parseModelCatalogDocument(catalog)).toEqual({ ok: true, value: catalog });
      expect(
        catalog.models.every(
          (model) =>
            model.pricing !== undefined &&
            model.responseDensityControls !== undefined &&
            (model.promptCacheModes?.length ?? 0) > 0 &&
            model.pricing.tiers.every(
              (tier) => tier.usdMicrosPerMillionTokens.cachedInput !== null,
            ),
        ),
      ).toBe(true);
    }
  });

  test("bundles the current Command Code execution catalog with verified facts", () => {
    const catalog = BUILTIN_MODEL_CATALOGS.find(
      (candidate) => candidate.catalogId === "falryn.commandcode",
    );
    expect(catalog?.models).toHaveLength(62);
    expect(COMMAND_CODE_MODEL_MANIFESTS).toHaveLength(62);
    expect(COMMAND_CODE_MODEL_REASONING_CONTROLS.size).toBe(31);
    const commandCodeIds = new Set(COMMAND_CODE_MODEL_MANIFESTS.map((model) => model.id));
    for (const [id, controls] of COMMAND_CODE_MODEL_REASONING_CONTROLS) {
      expect(commandCodeIds.has(id)).toBe(true);
      expect(
        controls.every((control) => ["low", "medium", "high", "xhigh", "max"].includes(control)),
      ).toBe(true);
    }
    expect(catalog?.models.every((model) => model.pricing?.kind !== "unknown")).toBe(true);
    expect(catalog?.models.find((model) => model.modelId === "claude-sonnet-5")).toMatchObject({
      inputModalities: ["text", "image"],
      tools: "supported",
      streaming: "supported",
      reasoning: "supported",
      reasoningControls: ["low", "medium", "high", "xhigh", "max"],
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
      reasoningControls: ["high", "max"],
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
    expect(freeMiniMax?.reasoningControls).toEqual([]);

    expect(catalog?.models.find((model) => model.modelId === "zai-org/GLM-5.3")).toMatchObject({
      reasoning: "supported",
      reasoningControls: ["low", "high", "max"],
    });
    expect(catalog?.models.find((model) => model.modelId === "Qwen/Qwen3.8-Max")).toMatchObject({
      reasoningControls: ["low", "medium", "xhigh"],
    });
    expect(catalog?.models.find((model) => model.modelId === "zai-org/GLM-5.2-Fast")).toMatchObject(
      {
        reasoning: "unknown",
        reasoningControls: [],
      },
    );
  });

  test("bundles source-verified official SDK catalogs", () => {
    const openAi = BUILTIN_MODEL_CATALOGS.find(
      (candidate) => candidate.catalogId === "falryn.openai",
    );
    const anthropic = BUILTIN_MODEL_CATALOGS.find(
      (candidate) => candidate.catalogId === "falryn.anthropic",
    );
    const google = BUILTIN_MODEL_CATALOGS.find(
      (candidate) => candidate.catalogId === "falryn.google",
    );

    expect(openAi?.models).toHaveLength(10);
    expect(openAi?.models.find((model) => model.modelId === "gpt-5.4-mini")).toMatchObject({
      reasoningControls: ["none", "low", "medium", "high", "xhigh"],
      responseDensityControls: ["low", "medium", "high"],
      contextTokens: 400_000,
      outputTokens: 128_000,
    });
    expect(anthropic?.models).toHaveLength(4);
    expect(anthropic?.models.find((model) => model.modelId === "claude-opus-5")).toMatchObject({
      inputModalities: ["text", "image"],
      structuredOutput: "supported",
      reasoningControls: ["low", "medium", "high", "xhigh", "max"],
      promptCacheModes: ["anthropic-ephemeral"],
      promptCacheMinimumInputTokens: 512,
      contextTokens: 1_000_000,
      outputTokens: 128_000,
      pricing: {
        tiers: [
          {
            usdMicrosPerMillionTokens: {
              cachedInput: 500_000,
              cacheWriteInput: 6_250_000,
            },
          },
        ],
      },
    });
    expect(
      anthropic?.models.find((model) => model.modelId === "claude-haiku-4-5-20251001"),
    ).toMatchObject({
      reasoning: "supported",
      reasoningControls: [],
      contextTokens: 200_000,
      outputTokens: 64_000,
    });
    expect(google?.models).toHaveLength(5);
    expect(google?.models.find((model) => model.modelId === "gemini-3.7-flash")).toMatchObject({
      inputModalities: ["text", "image", "audio", "video", "document"],
      reasoningControls: ["low", "medium", "high"],
      contextTokens: 1_048_576,
      outputTokens: 65_536,
    });
    expect(google?.models.find((model) => model.modelId === "gemini-3.6-flash")).toMatchObject({
      reasoningControls: ["minimal", "low", "medium", "high"],
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
