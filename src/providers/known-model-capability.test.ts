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
        contextTokens: 1_050_000,
        outputTokens: 128_000,
        completeness: "complete",
      });
    }
  });

  test("limits compatibility facts to the official endpoint", () => {
    expect(
      knownModelCapability("openai", "gpt-5.6-sol", "https://api.openai.com/v1/"),
    ).toMatchObject({ modelId: "gpt-5.6-sol", reasoning: "supported" });
    expect(knownModelCapability("openai", "gpt-4o-mini", "https://api.openai.com/v1")).toBe(
      KNOWN_OPENAI_GPT_4O_MINI_CAPABILITY,
    );
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
});
