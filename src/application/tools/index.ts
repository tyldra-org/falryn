/** Public contracts for this capability. Internal modules import their exact dependencies. */

export type {
  CapabilityDisclosureReceipt,
  CapabilityFamilyAvailability,
  DisclosedProductTool,
  ModelCapabilityFamily,
  ProductToolDisclosure,
} from "./product-tool-disclosure.ts";
export {
  discloseProductTools,
  MAX_DISCLOSED_PRODUCT_TOOLS,
  MODEL_CAPABILITY_FAMILIES,
  PRODUCT_TOOL_DISCLOSURE_SCHEMA_VERSION,
} from "./product-tool-disclosure.ts";
export type {
  ProductToolConfirmationPort,
  ProductToolConfirmationResult,
  ProductToolEffectLedger,
  ProductToolGatewayOptions,
} from "./product-tool-gateway.ts";
export { createProductToolGateway } from "./product-tool-gateway.ts";
export {
  isClosedProductToolSchema,
  measureProductToolSchema,
} from "./product-tool-schema.ts";
export type {
  ProductGitToolPorts,
  ProductGitTools,
} from "./product-tools-git.ts";
export {
  composeProductGitTools,
  PRODUCT_GIT_TOOLS_OWNER,
} from "./product-tools-git.ts";
export type {
  ProductLanguageToolPorts,
  ProductLanguageTools,
} from "./product-tools-language.ts";
export {
  composeProductLanguageTools,
  PRODUCT_LANGUAGE_TOOLS_OWNER,
} from "./product-tools-language.ts";
export type {
  ProductMemoryToolPorts,
  ProductMemoryTools,
} from "./product-tools-memory.ts";
export {
  composeProductMemoryTools,
  PRODUCT_MEMORY_TOOLS_OWNER,
} from "./product-tools-memory.ts";
export type { ProductToolBundle, ProductToolSourceBundle } from "./product-tools-merge.ts";
export { mergeProductToolBundles } from "./product-tools-merge.ts";
export type {
  ProductProcessToolPorts,
  ProductProcessTools,
} from "./product-tools-process.ts";
export {
  composeProductProcessTools,
  PRODUCT_PROCESS_TOOLS_OWNER,
} from "./product-tools-process.ts";
export type { ProductScratchToolPorts, ProductScratchTools } from "./product-tools-scratch.ts";
export {
  composeProductScratchTools,
  PRODUCT_SCRATCH_TOOLS_OWNER,
} from "./product-tools-scratch.ts";
export type {
  ProductWorkspaceToolPorts,
  ProductWorkspaceTools,
} from "./product-tools-workspace.ts";
export {
  composeProductWorkspaceTools,
  PRODUCT_WORKSPACE_TOOLS_OWNER,
} from "./product-tools-workspace.ts";
export type {
  PostHookRunResult,
  PreHookRunResult,
  RunToolHooksInput,
  ToolHookRunner,
  ToolHookRunnerOptions,
} from "./tool-hook-runner.ts";
export { createToolHookRunner } from "./tool-hook-runner.ts";
export type { EnvelopeToolResultInput, ToolResultEnvelope } from "./tool-result-envelope.ts";
export { envelopeToolResult } from "./tool-result-envelope.ts";
export type {
  RunToolWorkInput,
  ToolWorkBatchOutcome,
  ToolWorkScheduler,
  ToolWorkSchedulerLimits,
  ToolWorkSchedulerOptions,
} from "./tool-work-scheduler.ts";
export {
  createToolWorkScheduler,
  DEFAULT_TOOL_WORK_SCHEDULER_LIMITS,
} from "./tool-work-scheduler.ts";
