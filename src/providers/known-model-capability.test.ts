import { describe, expect, test } from "bun:test";

import {
  KNOWN_OPENAI_GPT_4O_MINI_CAPABILITY,
  knownModelCapability,
  LATEST_OPENAI_MODEL_CAPABILITIES,
  LATEST_OPENAI_MODEL_IDS,
} from "./known-model-capability.ts";

describe("known OpenAI model capabilities", () => {
  test("keeps the latest family in default-route order", () => {
    expect(LATEST_OPENAI_MODEL_IDS.map(String)).toEqual([
      "gpt-5.6-sol",
      "gpt-5.6-terra",
      "gpt-5.6-luna",
      "gpt-5.6",
    ]);
  });

  test("declares the source-verified GPT-5.6 capability contract", () => {
    for (const capability of LATEST_OPENAI_MODEL_CAPABILITIES) {
      expect(capability).toMatchObject({
        inputModalities: ["text", "image"],
        outputModalities: ["text"],
        tools: "supported",
        structuredOutput: "supported",
        streaming: "supported",
        reasoning: "supported",
        reasoningControls: ["none", "low", "medium", "high", "xhigh", "max"],
        responseDensityControls: ["low", "medium", "high"],
        contextTokens: 1_050_000,
        outputTokens: 128_000,
        completeness: "complete",
      });
    }
    expect(LATEST_OPENAI_MODEL_CAPABILITIES[0]?.pricing).toMatchObject({
      kind: "published",
      billingMode: "api",
      tiers: [
        {
          id: "standard-short",
          usdMicrosPerMillionTokens: { input: 4_000_000, output: 20_000_000 },
        },
        {
          id: "standard-long",
          usdMicrosPerMillionTokens: { input: 8_000_000, output: 30_000_000 },
        },
      ],
    });
    expect(LATEST_OPENAI_MODEL_CAPABILITIES.at(-1)?.pricing).toMatchObject({
      kind: "published",
      tiers: [
        {
          id: "standard-short",
          usdMicrosPerMillionTokens: { input: 4_000_000, output: 20_000_000 },
        },
        {
          id: "standard-long",
          usdMicrosPerMillionTokens: { input: 8_000_000, output: 30_000_000 },
        },
      ],
    });
  });

  test("limits compatibility facts to the official endpoint", () => {
    expect(
      knownModelCapability("openai", "gpt-5.6-sol", "https://api.openai.com/v1/"),
    ).toMatchObject({ modelId: "gpt-5.6-sol", reasoning: "supported" });
    expect(knownModelCapability("openai", "gpt-4o-mini", "https://api.openai.com/v1")).toBe(
      KNOWN_OPENAI_GPT_4O_MINI_CAPABILITY,
    );
    expect(KNOWN_OPENAI_GPT_4O_MINI_CAPABILITY.responseDensityControls).toEqual([]);
    expect(KNOWN_OPENAI_GPT_4O_MINI_CAPABILITY.pricing).toMatchObject({
      kind: "published",
      tiers: [
        {
          usdMicrosPerMillionTokens: {
            input: 150_000,
            cachedInput: 75_000,
            output: 600_000,
          },
        },
      ],
    });
    expect(
      knownModelCapability("openai", "gpt-5.6-sol", "https://provider.example.test/v1"),
    ).toBeNull();
    expect(
      knownModelCapability("anthropic", "gpt-5.6-sol", "https://api.openai.com/v1"),
    ).toBeNull();
    expect(
      knownModelCapability("openai", "unknown-openai-model", "https://api.openai.com/v1"),
    ).toBeNull();
  });
});

describe("known Command Code model capabilities", () => {
  test("binds published facts to the exact composite adapter destination", () => {
    expect(
      knownModelCapability(
        "commandcode",
        "claude-sonnet-5",
        "https://api.commandcode.ai/provider/v1",
        "commandcode",
      ),
    ).toMatchObject({
      displayName: "Claude Sonnet 5",
      inputModalities: ["text", "image"],
      tools: "supported",
      streaming: "supported",
      contextTokens: 1_000_000,
    });
    expect(
      knownModelCapability(
        "commandcode",
        "claude-sonnet-5",
        "https://provider.example.test/v1",
        "commandcode",
      ),
    ).toBeNull();
  });

  test("keeps provider-specific prices separate for the same model identity", () => {
    const openAi = knownModelCapability(
      "openai",
      "gpt-5.6-sol",
      "https://api.openai.com/v1",
      "openai",
    );
    const commandCode = knownModelCapability(
      "commandcode",
      "gpt-5.6-sol",
      "https://api.commandcode.ai/provider/v1",
      "commandcode",
    );
    expect(openAi?.pricing?.tiers[0]?.usdMicrosPerMillionTokens.input).toBe(4_000_000);
    expect(commandCode?.pricing?.tiers[0]?.usdMicrosPerMillionTokens.input).toBe(5_000_000);
    expect(openAi?.pricing?.billingMode).toBe("api");
    expect(commandCode?.pricing?.billingMode).toBe("provider-credit");
  });
});

describe("known official SDK model capabilities", () => {
  test("binds Anthropic facts to the SDK default destination", () => {
    expect(knownModelCapability("anthropic", "claude-sonnet-5", null, "anthropic")).toMatchObject({
      reasoningControls: ["low", "medium", "high", "xhigh", "max"],
      contextTokens: 1_000_000,
      outputTokens: 128_000,
    });
    expect(
      knownModelCapability(
        "anthropic",
        "claude-sonnet-5",
        "https://proxy.example.test",
        "anthropic",
      ),
    ).toBeNull();
  });

  test("binds Google facts to the SDK default destination", () => {
    expect(knownModelCapability("google", "gemini-3.5-flash", null, "google")).toMatchObject({
      reasoningControls: ["minimal", "low", "medium", "high"],
      structuredOutput: "supported",
      contextTokens: 1_048_576,
      outputTokens: 65_536,
    });
  });
});
