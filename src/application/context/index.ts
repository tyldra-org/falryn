/** Public contracts for this capability. Internal modules import their exact dependencies. */

export type {
  ComposerContextRequest,
  ComposerContextResolution,
  FileAttachmentProbe,
} from "./composer-context.ts";
export {
  admitComposerContext,
  createFileAttachmentProbe,
  createTranscriptAttachment,
  digestBytes,
  refreshAttachments,
  resolveComposerAttachments,
} from "./composer-context.ts";
export type {
  ContextPlanner,
  ContextPlannerComposeInput,
  ContextPlannerComposeResult,
  ContextPlannerError,
  ContextPlannerPlan,
} from "./context-planner.ts";
export { CONTEXT_PLANNER_OWNER, createContextPlanner } from "./context-planner.ts";
export type {
  ProductContextReceipt,
  ProductContextSource,
  ProductContextSourceOptions,
  ProductPreparedContext,
} from "./product-context-source.ts";
export {
  createProductContextSource,
  createUnavailableProductContextSource,
  MAX_PRODUCT_CONTEXT_QUERIES,
  PRODUCT_CONTEXT_SOURCE_OWNER,
} from "./product-context-source.ts";
export { attemptModelInputFromPrompt } from "./product-model-input.ts";
export type {
  DigestedPromptRequest,
  PromptComposer,
  PromptComposerError,
  PromptComposerOptions,
  PromptComposerResult,
} from "./prompt-composer.ts";
export { createPromptComposer } from "./prompt-composer.ts";
export { ENHANCEMENT_MODEL_OWNER, enhancePrompt } from "./prompt-enhancement.ts";
