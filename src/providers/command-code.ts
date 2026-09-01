/** Official Command Code Provider API identity and transport-routing facts. */

export const COMMAND_CODE_PROVIDER_ID = "commandcode";
export const COMMAND_CODE_OPENAI_BASE_URL = "https://api.commandcode.ai/provider/v1";
export const COMMAND_CODE_ANTHROPIC_BASE_URL = "https://api.commandcode.ai/provider";

export type CommandCodeProtocol = "openai" | "anthropic";

export type CommandCodeModelManifest = {
  readonly id: string;
  readonly name: string;
  readonly contextTokens: number;
  readonly image: boolean;
  readonly reasoning: boolean;
  readonly protocol: CommandCodeProtocol;
};

const commandCodeModel = (
  id: string,
  name: string,
  contextTokens: number,
  image: boolean,
  reasoning: boolean,
  protocol: CommandCodeProtocol = "openai",
): CommandCodeModelManifest => ({ id, name, contextTokens, image, reasoning, protocol });

/**
 * Generated from Command Code's Provider API model endpoint and official model
 * registry. Execution IDs come from the API; capability flags come from the
 * registry. Unknown facts remain unknown instead of being inferred from names.
 */
export const COMMAND_CODE_MODEL_MANIFESTS: readonly CommandCodeModelManifest[] = [
  commandCodeModel("claude-sonnet-5", "Claude Sonnet 5", 1_000_000, true, true, "anthropic"),
  commandCodeModel("claude-sonnet-4-6", "Claude Sonnet 4.6", 1_000_000, true, false, "anthropic"),
  commandCodeModel("claude-fable-5", "Claude Fable 5", 1_000_000, true, true, "anthropic"),
  commandCodeModel("claude-opus-5", "Claude Opus 5", 1_000_000, true, true, "anthropic"),
  commandCodeModel("claude-opus-4-8", "Claude Opus 4.8", 1_000_000, true, true, "anthropic"),
  commandCodeModel("claude-opus-4-7", "Claude Opus 4.7", 1_000_000, true, true, "anthropic"),
  commandCodeModel(
    "claude-haiku-4-5-20251001",
    "Claude Haiku 4.5",
    200_000,
    true,
    false,
    "anthropic",
  ),
  commandCodeModel("gpt-5.6-sol", "GPT-5.6 Sol", 1_050_000, true, true),
  commandCodeModel("gpt-5.6-terra", "GPT-5.6 Terra", 1_050_000, true, true),
  commandCodeModel("gpt-5.6-luna", "GPT-5.6 Luna", 1_050_000, true, true),
  commandCodeModel("gpt-5.5", "GPT-5.5", 400_000, true, true),
  commandCodeModel("gpt-5.4", "GPT-5.4", 400_000, true, true),
  commandCodeModel("gpt-5.3-codex", "GPT-5.3 Codex", 400_000, true, true),
  commandCodeModel("gpt-5.4-mini", "GPT-5.4 Mini", 400_000, true, true),
  commandCodeModel("deepseek/deepseek-v4-pro", "DeepSeek V4 Pro (latest)", 1_000_000, false, true),
  commandCodeModel(
    "deepseek/deepseek-v4-flash",
    "DeepSeek V4 Flash (latest)",
    1_000_000,
    false,
    true,
  ),
  commandCodeModel(
    "deepseek/deepseek-v4-flash-vision-exp",
    "DeepSeek V4 Flash Vision (exp)",
    1_000_000,
    true,
    true,
  ),
  commandCodeModel("moonshotai/Kimi-K3", "Kimi K3", 1_000_000, true, true),
  commandCodeModel("moonshotai/Kimi-K2.7-Code", "Kimi K2.7 Code", 256_000, true, true),
  commandCodeModel(
    "moonshotai/Kimi-K2.7-Code-Highspeed",
    "Kimi K2.7 Code HighSpeed",
    262_000,
    true,
    true,
  ),
  commandCodeModel("moonshotai/Kimi-K2.6", "Kimi K2.6", 256_000, true, false),
  commandCodeModel("moonshotai/Kimi-K2.5", "Kimi K2.5", 256_000, true, false),
  commandCodeModel("z-ai/glm-5.3-flash", "GLM-5.3 Flash", 1_048_576, true, true),
  commandCodeModel("zai-org/GLM-5.3", "GLM-5.3", 1_000_000, false, true),
  commandCodeModel("zai-org/GLM-5.2", "GLM-5.2", 1_000_000, false, true),
  commandCodeModel("zai-org/GLM-5.2-Fast", "GLM-5.2 Fast", 1_000_000, false, false),
  commandCodeModel("zai-org/GLM-5.1", "GLM-5.1", 200_000, false, false),
  commandCodeModel("zai-org/GLM-5", "GLM-5", 200_000, false, false),
  commandCodeModel("MiniMaxAI/MiniMax-M3", "MiniMax M3", 1_000_000, true, true),
  commandCodeModel("MiniMaxAI/MiniMax-M2.7", "MiniMax M2.7", 200_000, false, false),
  commandCodeModel("minimax/minimax-m3-free", "MiniMax M3", 1_000_000, true, true),
  commandCodeModel("minimax/minimax-m2.7-free", "MiniMax M2.7", 197_000, false, false),
  commandCodeModel("MiniMaxAI/MiniMax-M2.5", "MiniMax M2.5", 200_000, false, false),
  commandCodeModel("xiaomi/mimo-v2.5-pro", "MiMo V2.5 Pro", 1_000_000, false, false),
  commandCodeModel("xiaomi/mimo-v2.5", "MiMo V2.5", 1_000_000, true, false),
  commandCodeModel("Qwen/Qwen3.8-Max", "Qwen 3.8 Max", 1_000_000, true, true),
  commandCodeModel("Qwen/Qwen3.8-27B", "Qwen 3.8 27B", 262_144, true, true),
  commandCodeModel("Qwen/Qwen3.8-Flash", "Qwen 3.8 Flash", 1_000_000, true, true),
  commandCodeModel("Qwen/Qwen3.7-Max", "Qwen 3.7 Max", 1_000_000, false, true),
  commandCodeModel("Qwen/Qwen3.7-Plus", "Qwen 3.7 Plus", 1_000_000, true, true),
  commandCodeModel("Qwen/Qwen3.7-Flash", "Qwen 3.7 Flash", 1_000_000, true, true),
  commandCodeModel("Qwen/Qwen3.6-Max-Preview", "Qwen 3.6 Max Preview", 200_000, false, true),
  commandCodeModel("Qwen/Qwen3.6-Plus", "Qwen 3.6 Plus", 200_000, true, true),
  commandCodeModel("stepfun/Step-3.7-Flash", "Step 3.7 Flash", 256_000, true, true),
  commandCodeModel("stepfun/Step-3.5-Flash", "Step 3.5 Flash", 1_000_000, false, true),
  commandCodeModel("tencent/hy3-paid", "Tencent Hy3", 262_144, false, true),
  commandCodeModel("tencent/hy4-preview", "Tencent Hy4 Preview", 1_048_576, false, true),
  commandCodeModel("google/gemini-3.7-flash", "Gemini 3.7 Flash", 1_048_576, true, true),
  commandCodeModel("google/gemini-3.6-flash", "Gemini 3.6 Flash", 1_000_000, true, true),
  commandCodeModel("google/gemini-3.5-flash", "Gemini 3.5 Flash", 1_000_000, true, true),
  commandCodeModel("google/gemini-3.5-flash-lite", "Gemini 3.5 Flash Lite", 1_000_000, true, true),
  commandCodeModel("google/gemini-3.1-flash-lite", "Gemini 3.1 Flash Lite", 1_000_000, true, true),
  commandCodeModel("sakana/fugu-ultra", "Fugu Ultra", 1_000_000, true, true),
  commandCodeModel("nvidia/nemotron-3-ultra-550b-a55b", "Nemotron 3 Ultra", 1_000_000, false, true),
  commandCodeModel("thinkingmachines/inkling", "Inkling", 256_000, true, true),
  commandCodeModel("thinkingmachines/inkling-small", "Inkling Small", 1_000_000, true, true),
  commandCodeModel("poolside/laguna-s-2.1-free", "Laguna S 2.1", 256_000, false, true),
  commandCodeModel("meta/muse-spark-1.1", "Muse Spark 1.1", 1_048_576, true, true),
  commandCodeModel("meta/muse-spark-1.2", "Muse Spark 1.2", 1_048_576, true, true),
  commandCodeModel(
    "meta/muse-spark-1.2-contributor",
    "Muse Spark 1.2 Contributor",
    1_048_576,
    true,
    true,
  ),
  commandCodeModel("xai/grok-4.5", "Grok 4.5", 500_000, true, true),
  commandCodeModel("xai/grok-4.6", "Grok 4.6", 500_000, false, true),
];

export const COMMAND_CODE_MODEL_PROTOCOLS: ReadonlyMap<string, CommandCodeProtocol> = new Map(
  COMMAND_CODE_MODEL_MANIFESTS.map((model) => [model.id, model.protocol]),
);

/**
 * Exact request-level effort values published by Command Code for each route.
 * Models absent from this map use provider-managed reasoning depth and must not
 * receive a guessed effort value.
 */
export const COMMAND_CODE_MODEL_REASONING_CONTROLS: ReadonlyMap<string, readonly string[]> =
  new Map([
    ["deepseek/deepseek-v4-pro", ["high", "max"]],
    ["deepseek/deepseek-v4-flash", ["high", "max"]],
    ["deepseek/deepseek-v4-flash-vision-exp", ["high", "max"]],
    ["z-ai/glm-5.3-flash", ["low", "high", "max"]],
    ["zai-org/GLM-5.3", ["low", "high", "max"]],
    ["zai-org/GLM-5.2", ["high", "max"]],
    ["Qwen/Qwen3.8-Max", ["low", "medium", "xhigh"]],
    ["Qwen/Qwen3.8-27B", ["low", "medium", "xhigh"]],
    ["Qwen/Qwen3.8-Flash", ["low", "medium", "xhigh"]],
    ["tencent/hy4-preview", ["low", "medium", "high"]],
    ["claude-sonnet-5", ["low", "medium", "high", "xhigh", "max"]],
    ["claude-sonnet-4-6", ["low", "medium", "high", "xhigh", "max"]],
    ["claude-fable-5", ["low", "medium", "high", "xhigh", "max"]],
    ["claude-opus-5", ["low", "medium", "high", "xhigh", "max"]],
    ["claude-opus-4-8", ["low", "medium", "high", "xhigh", "max"]],
    ["claude-opus-4-7", ["low", "medium", "high", "xhigh", "max"]],
    ["gpt-5.6-sol", ["low", "medium", "high", "xhigh", "max"]],
    ["gpt-5.6-terra", ["low", "medium", "high", "xhigh", "max"]],
    ["gpt-5.6-luna", ["low", "medium", "high", "xhigh", "max"]],
    ["gpt-5.5", ["low", "medium", "high", "xhigh"]],
    ["gpt-5.4", ["low", "medium", "high", "xhigh"]],
    ["gpt-5.3-codex", ["low", "medium", "high", "xhigh"]],
    ["gpt-5.4-mini", ["low", "medium", "high"]],
    ["google/gemini-3.7-flash", ["low", "medium", "high"]],
    ["google/gemini-3.6-flash", ["low", "medium", "high"]],
    ["google/gemini-3.5-flash", ["low", "medium", "high"]],
    ["google/gemini-3.5-flash-lite", ["low", "medium", "high"]],
    ["google/gemini-3.1-flash-lite", ["low", "medium", "high"]],
    ["sakana/fugu-ultra", ["high", "xhigh"]],
    ["xai/grok-4.5", ["low", "medium", "high"]],
    ["xai/grok-4.6", ["low", "medium", "high", "xhigh"]],
  ]);

for (const id of COMMAND_CODE_MODEL_REASONING_CONTROLS.keys()) {
  if (!COMMAND_CODE_MODEL_PROTOCOLS.has(id)) {
    throw new Error(`Command Code reasoning controls reference unknown model ${id}.`);
  }
}

export function commandCodeProtocolFor(model: string): CommandCodeProtocol | null {
  return COMMAND_CODE_MODEL_PROTOCOLS.get(model) ?? null;
}

export function commandCodeReasoningControlsFor(model: string): readonly string[] {
  return COMMAND_CODE_MODEL_REASONING_CONTROLS.get(model) ?? [];
}
