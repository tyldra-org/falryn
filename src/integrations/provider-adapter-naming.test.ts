import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";

const INTEGRATIONS_ROOT = dirname(import.meta.path);

const SDK_LEAF_ADAPTERS = {
  "anthropic-sdk-adapter.ts": 'from "@anthropic-ai/sdk"',
  "google-genai-sdk-adapter.ts": 'from "@google/genai"',
  "openai-responses-sdk-adapter.ts": 'from "openai"',
  "openai-sdk-adapter.ts": 'from "openai"',
} as const;

async function source(file: string): Promise<string> {
  return readFile(join(INTEGRATIONS_ROOT, file), "utf8");
}

describe("provider adapter naming", () => {
  test("reserves the SDK adapter suffix for direct vendor SDK leaves", async () => {
    const sdkAdapters: string[] = [];
    const glob = new Bun.Glob("*-sdk-adapter.ts");
    for await (const file of glob.scan({ cwd: INTEGRATIONS_ROOT })) {
      sdkAdapters.push(file);
    }

    expect(sdkAdapters.sort()).toEqual(Object.keys(SDK_LEAF_ADAPTERS).sort());
    for (const [file, vendorImport] of Object.entries(SDK_LEAF_ADAPTERS)) {
      expect(await source(file)).toContain(vendorImport);
    }
  });

  test("names Command Code as a composite provider adapter", async () => {
    const commandCode = await source("command-code-provider-adapter.ts");

    expect(commandCode).toContain("createOpenAiSdkAdapter");
    expect(commandCode).toContain("createAnthropicSdkAdapter");
    expect(commandCode).not.toMatch(/from ["'](?:openai|@anthropic-ai\/sdk)["']/u);
    expect(commandCode).not.toContain("CommandCodeSdkAdapter");
    expect(commandCode).not.toContain("createCommandCodeSdkAdapter");
  });

  test("names OpenAI as a provider above its SDK transport leaves", async () => {
    const openAi = await source("openai-provider-adapter.ts");

    expect(openAi).toContain("createOpenAiSdkAdapter");
    expect(openAi).toContain("createOpenAiResponsesSdkAdapter");
    expect(openAi).not.toMatch(/from ["']openai["']/u);
  });
});
