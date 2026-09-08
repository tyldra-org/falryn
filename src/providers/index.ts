/**
 * Provider ports and normalized boundary schemas.
 *
 * This source area owns provider-neutral requests, stream events, profiles,
 * authentication snapshots, capability discovery, model policy / intent routing,
 * and the adapter port. Vendor leaf adapters live in `src/integrations`; SDK
 * request and stream types must not cross this provider-neutral boundary.
 */

export type {
  ProviderAuthOutcome,
  ProviderAuthSnapshot,
  ProviderAuthState,
  ProviderRevocationReport,
} from "./authentication/auth.ts";
export {
  authStateForCredentialFailure,
  isProviderAuthState,
  PROVIDER_AUTH_STATES,
} from "./authentication/auth.ts";
export { establishProviderAuth, removeProviderCredential } from "./authentication/auth-service.ts";
export type {
  AuthorizationBrowserPort,
  AuthorizationCallback,
  AuthorizationCallbackMode,
  AuthorizationCryptoPort,
  AuthorizationInteractionPort,
  AuthorizationLoopbackPort,
  AuthorizationLoopbackSession,
  AuthorizationReceiptOutcome,
  AuthorizedLoginMethod,
  AuthorizedProviderCredential,
  AuthorizedProviderLoginDescriptor,
  AuthorizedProviderLoginHost,
  ProviderAuthorizationDenied,
  ProviderAuthorizationExchangeResult,
  ProviderAuthorizationFailure,
  ProviderAuthorizationReceipt,
  ProviderAuthorizedLoginAdapter,
  ProviderAuthorizedLoginAvailability,
  ProviderDeviceCodePollResult,
  ProviderDeviceCodeStartResult,
  ProviderPkceStartResult,
  ProviderRefreshResult,
  ProviderRemoteRevocationResult,
} from "./authentication/authorized-login.ts";
export {
  AUTHORIZATION_CALLBACK_MODES,
  AUTHORIZATION_RECEIPT_OUTCOMES,
  AUTHORIZED_LOGIN_METHODS,
  AUTHORIZED_LOGIN_SCHEMA_VERSION,
  MAX_AUTHORIZATION_CODE_LENGTH,
  MAX_AUTHORIZATION_ID_LENGTH,
  MAX_AUTHORIZATION_SCOPE_LENGTH,
  MAX_AUTHORIZATION_SCOPES,
  MAX_AUTHORIZATION_TOKEN_LENGTH,
  MAX_AUTHORIZATION_URL_LENGTH,
} from "./authentication/authorized-login.ts";
export type { AuthorizedLoginParseError } from "./authentication/authorized-login-schema.ts";
export {
  authorizedProviderCredentialSchema,
  authorizedProviderLoginDescriptorSchema,
  parseAuthorizedProviderCredential,
  parseAuthorizedProviderLoginDescriptor,
  parseProviderAuthorizationReceipt,
  providerAuthorizationReceiptSchema,
} from "./authentication/authorized-login-schema.ts";
export type {
  OfficialProviderCredentialId,
  ProviderCredentialEnvironment,
} from "./authentication/credential-environment.ts";
export {
  providerCredentialEnvironment,
  providerCredentialEnvironmentAliases,
  providerEnvironmentCredentialReference,
} from "./authentication/credential-environment.ts";
export {
  OPENAI_CODEX_AUTHORIZATION_UNAVAILABLE_CODE,
  OPENAI_CODEX_AUTHORIZATION_UNAVAILABLE_MESSAGE,
  OPENAI_CODEX_PROVIDER_ID,
  openAiCodexProfilePolicyIssue,
} from "./authentication/openai-codex-policy.ts";
export {
  BUILTIN_MODEL_CATALOGS,
  builtinModelCapability,
  builtinModelCatalog,
} from "./catalog/builtins.ts";
export type {
  ModelCatalogDocument,
  ModelCatalogId,
  ModelCatalogSource,
  ModelCatalogSourceConfidence,
  ModelCatalogSourceFact,
  ModelCatalogSourceKind,
} from "./catalog/contracts.ts";
export {
  isModelCatalogId,
  MAX_MODEL_CATALOG_FILE_BYTES,
  MAX_MODEL_CATALOG_SOURCES,
  MAX_MODEL_CATALOGS_PER_PROFILE,
  MAX_MODELS_PER_CATALOG,
  MODEL_CATALOG_DOCUMENT_SCHEMA_VERSION,
  MODEL_CATALOG_SOURCE_CONFIDENCE,
  MODEL_CATALOG_SOURCE_FACTS,
  MODEL_CATALOG_SOURCE_KINDS,
} from "./catalog/contracts.ts";
export type {
  CatalogProvenance,
  DiscoveryFailureKind,
  DiscoveryOutcome,
  ModelCapability,
  ModelCatalog,
  ModelDiscoveryPort,
  ModelModality,
  StaticDiscoveryOptions,
} from "./catalog/discovery.ts";
export {
  catalogFromAdapterModels,
  createDeterministicRemoteDiscovery,
  createStaticModelDiscovery,
  discoverModelCatalog,
  MODEL_MODALITIES,
} from "./catalog/discovery.ts";
export type { ModelCatalogParseError } from "./catalog/effective.ts";
export { parseModelCatalog } from "./catalog/effective.ts";
export {
  KNOWN_OPENAI_GPT_4O_MINI_CAPABILITY,
  KNOWN_OPENAI_MODEL_CAPABILITIES,
  knownModelCapability,
  LATEST_OPENAI_MODEL_CAPABILITIES,
  LATEST_OPENAI_MODEL_IDS,
} from "./catalog/known-model-capability.ts";
export type {
  ModelAvailability,
  ModelCapabilityCompleteness,
  ModelCapabilityDeclaration,
  ModelCapabilityProvenance,
  ModelFeatureSupport,
  ModelInputModality,
  ModelOutputModality,
  ModelPromptCacheMode,
  ModelResponseDensityControl,
} from "./catalog/model-capability.ts";
export {
  capabilityFromDeclaration,
  featureIsSupported,
  MODEL_AVAILABILITIES,
  MODEL_CAPABILITY_COMPLETENESSES,
  MODEL_CAPABILITY_PROVENANCES,
  MODEL_CAPABILITY_SCHEMA_VERSION,
  MODEL_FEATURE_SUPPORTS,
  MODEL_INPUT_MODALITIES,
  MODEL_OUTPUT_MODALITIES,
  MODEL_PROMPT_CACHE_MODES,
  MODEL_RESPONSE_DENSITY_CONTROLS,
  unknownModelCapability,
} from "./catalog/model-capability.ts";
export type {
  ModelCapabilityDeclarationParseError,
  ModelCapabilityParseError,
} from "./catalog/model-capability-schema.ts";
export {
  modelCapabilityDeclarationSchema,
  parseModelCapability,
  parseModelCapabilityDeclaration,
} from "./catalog/model-capability-schema.ts";
export type {
  ProviderModelIdentity,
  ProviderModelIdentityKeyParseResult,
} from "./catalog/model-identity.ts";
export {
  parseProviderModelIdentityKey,
  providerModelIdentityKey,
  sameProviderModelIdentity,
} from "./catalog/model-identity.ts";
export type {
  ModelBillingMode,
  ModelPricing,
  ModelPricingKind,
  ModelPricingTier,
  ModelPricingUtcWindow,
  ModelTokenPrice,
} from "./catalog/model-pricing.ts";
export {
  MODEL_BILLING_MODES,
  MODEL_PRICE_TOKEN_UNIT,
  MODEL_PRICING_KINDS,
  unknownModelPricing,
} from "./catalog/model-pricing.ts";
export type { ModelCatalogDocumentParseError } from "./catalog/schema.ts";
export { modelCatalogDocumentSchema, parseModelCatalogDocument } from "./catalog/schema.ts";
export type { DiscoveryPolicy, ProviderAdapterKind } from "./configuration/adapter-kind.ts";
export {
  DISCOVERY_POLICIES,
  isDiscoveryPolicy,
  isProviderAdapterKind,
  PROVIDER_ADAPTER_KINDS,
} from "./configuration/adapter-kind.ts";
export type {
  ProviderAccountMetadata,
  ProviderAuthMethod,
  ProviderConnection,
  ProviderConnectionState,
} from "./configuration/connection.ts";
export {
  MAX_PROVIDER_CONNECTIONS,
  PROVIDER_AUTH_METHODS,
  PROVIDER_CONNECTION_SCHEMA_VERSION,
} from "./configuration/connection.ts";
export type { ProviderConnectionStateParseError } from "./configuration/connection-schema.ts";
export {
  parseProviderConnectionState,
  providerConnectionStateSchema,
} from "./configuration/connection-schema.ts";
export type {
  ModelRequestId,
  ProviderIdentityError,
  ProviderIdentityErrorCode,
} from "./configuration/identity.ts";
export { modelRequestId } from "./configuration/identity.ts";
export type {
  AdvisorRoleRoute,
  FallbackTarget,
  IntentRoleMap,
  ModelPolicy,
  ModelRoleRoutes,
  ReasoningEffort,
  RoleBudgets,
  RoleRoute,
  VisionRoleRoute,
} from "./configuration/policy.ts";
export {
  DEFAULT_INTENT_ROLE_MAP,
  isCompleteIntentMap,
  isReasoningEffort,
  isRoleDisabled,
  REASONING_EFFORTS,
  resolveIntentRole,
  roleRouteFor,
} from "./configuration/policy.ts";
export type { ModelPolicyParseError } from "./configuration/policy-schema.ts";
export {
  assertDefaultIntentMapComplete,
  modelPolicySchema,
  parseModelPolicy,
} from "./configuration/policy-schema.ts";
export type {
  ProviderNetworkTimeouts,
  ProviderProfile,
  ProviderProfileId,
} from "./configuration/profile.ts";
export { profileCredentialConsumer } from "./configuration/profile.ts";
export type { ProviderProfileParseError } from "./configuration/profile-schema.ts";
export {
  parseProviderProfile,
  providerEndpointIsAllowed,
  providerProfileSchema,
} from "./configuration/profile-schema.ts";
export type {
  ResolveSpecializedRoleInput,
  RouteRequirement,
  SpecializedRoleOutcome,
} from "./configuration/role-support.ts";
export {
  capabilityHasImage,
  defaultRequirementsForIntent,
  intentPrefersReasoningEffort,
  intentRequiresImage,
  mergeRequirements,
  primaryCapabilityForRole,
  reasoningEffortForRoute,
  resolveSpecializedRole,
} from "./configuration/role-support.ts";
export type { ModelRole, WorkIntent } from "./configuration/roles.ts";
export { isModelRole, isWorkIntent, MODEL_ROLES, WORK_INTENTS } from "./configuration/roles.ts";
export type {
  AnthropicMessagesTransportCompatibilityDeclaration,
  CommandCodeTransportCompatibilityDeclaration,
  CustomUnavailableTransportCompatibilityDeclaration,
  DeterministicTransportCompatibilityDeclaration,
  GoogleGenerateContentTransportCompatibilityDeclaration,
  OpenAiAssistantAfterToolResultMode,
  OpenAiChatTransportCompatibilityDeclaration,
  OpenAiFinishReasonMode,
  OpenAiMaxOutputTokenField,
  OpenAiResponsesContinuationMode,
  OpenAiResponsesPromptCacheTtl,
  OpenAiResponsesReasoningSummary,
  OpenAiResponsesServiceTier,
  OpenAiResponsesTransportCompatibilityDeclaration,
  OpenAiStreamingUsageMode,
  OpenAiSystemMessageRole,
  OpenAiToolResultNameMode,
  ProviderModelTransportCompatibilityOverride,
  ProviderTransportCompatibilityDeclaration,
  ProviderTransportCompatibilityError,
  ProviderTransportCompatibilityLayer,
  ProviderTransportCompatibilityLayerReceipt,
  ProviderTransportCompatibilityLayerStatus,
  ProviderTransportCompatibilityPlan,
  ProviderTransportCompatibilityProvenance,
  ProviderTransportCompatibilityReceipt,
  ProviderTransportCompatibilityResolution,
  ProviderTransportCompatibilitySource,
  ProviderTransportCompatibilitySourceKind,
  ProviderTransportDialect,
} from "./configuration/transport-compatibility.ts";
export {
  bindProviderTransportCompatibilityToModel,
  defaultProviderTransportCompatibility,
  OPENAI_ASSISTANT_AFTER_TOOL_RESULT_MODES,
  OPENAI_CHAT_TRANSPORT_DEFAULT,
  OPENAI_FINISH_REASON_MODES,
  OPENAI_MAX_OUTPUT_TOKEN_FIELDS,
  OPENAI_RESPONSES_CONTINUATION_MODES,
  OPENAI_RESPONSES_PROMPT_CACHE_TTLS,
  OPENAI_RESPONSES_REASONING_SUMMARIES,
  OPENAI_RESPONSES_SERVICE_TIERS,
  OPENAI_RESPONSES_TRANSPORT_DEFAULT,
  OPENAI_STREAMING_USAGE_MODES,
  OPENAI_SYSTEM_MESSAGE_ROLES,
  OPENAI_TOOL_RESULT_NAME_MODES,
  PROVIDER_TRANSPORT_COMPATIBILITY_SCHEMA_VERSION,
  PROVIDER_TRANSPORT_COMPATIBILITY_SOURCE_KINDS,
  PROVIDER_TRANSPORT_DIALECTS,
  providerTransportCompatibilityMatchesAdapter,
  providerTransportCompatibilityReceiptMatchesPlan,
  resolveProviderTransportCompatibility,
} from "./configuration/transport-compatibility.ts";
export type { ProviderTransportCompatibilityDeclarationParseError } from "./configuration/transport-compatibility-schema.ts";
export {
  parseProviderTransportCompatibilityDeclaration,
  providerModelTransportCompatibilityOverrideSchema,
  providerTransportCompatibilityDeclarationSchema,
} from "./configuration/transport-compatibility-schema.ts";
export type { CommandCodeProtocol } from "./protocol/command-code.ts";
export {
  COMMAND_CODE_ANTHROPIC_BASE_URL,
  COMMAND_CODE_MODEL_MANIFESTS,
  COMMAND_CODE_MODEL_PROTOCOLS,
  COMMAND_CODE_MODEL_REASONING_CONTROLS,
  COMMAND_CODE_OPENAI_BASE_URL,
  COMMAND_CODE_PROVIDER_ID,
  commandCodeProtocolFor,
  commandCodeReasoningControlsFor,
} from "./protocol/command-code.ts";
export type {
  ProviderContinuationStateError,
  ProviderContinuationStateKey,
  ProviderContinuationStatePort,
  ProviderContinuationStateRecord,
} from "./protocol/continuation-state.ts";
export { PROVIDER_CONTINUATION_STATE_SCHEMA_VERSION } from "./protocol/continuation-state.ts";
export type { ProviderFailure, ProviderFailureKind } from "./protocol/errors.ts";
export { isProviderFailureKind, PROVIDER_FAILURE_KINDS } from "./protocol/errors.ts";
export {
  MAX_ASSEMBLED_TEXT_LENGTH,
  MAX_FINISH_REASON_LENGTH,
  MAX_IN_FLIGHT_TOOL_CALLS,
  MAX_MESSAGE_TEXT_LENGTH,
  MAX_PROVIDER_METADATA_ENTRIES,
  MAX_PROVIDER_METADATA_ENTRY_LENGTH,
  MAX_REQUEST_MESSAGES,
  MAX_REQUEST_TOOLS,
  MAX_TOOL_ARGUMENT_FRAGMENT_LENGTH,
  MAX_TOOL_NAME_LENGTH,
  PROVIDER_BOUNDARY_MINIMUM_SCHEMA_VERSION,
  PROVIDER_BOUNDARY_SCHEMA_FAMILY,
  PROVIDER_BOUNDARY_SCHEMA_VERSION,
} from "./protocol/limits.ts";
export type {
  ImageMessagePart,
  MessagePart,
  MessageRole,
  ModelAssistantToolCall,
  ModelBudgets,
  ModelMessage,
  ModelToolDefinition,
  OutputContract,
  RequestMetadata,
  TextMessagePart,
} from "./protocol/messages.ts";
export { isMessageRole, MESSAGE_ROLES } from "./protocol/messages.ts";
export type {
  ProviderAdapterIdentity,
  ProviderAdapterPort,
  ProviderStreamOptions,
} from "./protocol/port.ts";
export type { ModelRequest, PromptCachePolicy, PromptCacheSeed } from "./protocol/request.ts";
export { PROMPT_CACHE_POLICY_SCHEMA_VERSION } from "./protocol/request.ts";
export {
  isSupportedProviderSchemaVersion,
  modelRequestSchema,
  normalizedProviderEventSchema,
} from "./protocol/schemas.ts";
export type {
  OpenProviderSessionOptions,
  OpenProviderSessionResult,
  ProviderSession,
  ProviderSessionPorts,
} from "./protocol/session.ts";
export { openProviderSession, revokeProviderSessionCredential } from "./protocol/session.ts";
export type {
  NormalizedProviderEvent,
  ProviderEventKind,
  ProviderEventSpine,
  UsageUnits,
} from "./protocol/stream.ts";
export {
  isProviderEventKind,
  isTerminalProviderEvent,
  PROVIDER_EVENT_KINDS,
} from "./protocol/stream.ts";
export type {
  AssembledToolProposal,
  StreamAssemblyDiagnostic,
  StreamAssemblySnapshot,
  StreamAssemblyStep,
  StreamAssemblyTerminal,
} from "./protocol/stream-assembly.ts";
export { normalizeProviderStream, ProviderStreamAssembler } from "./protocol/stream-assembly.ts";
export type { ProviderBoundaryParseError } from "./protocol/validate.ts";
export {
  parseModelRequest,
  parseNormalizedProviderEvent,
  redactProviderDiagnosticText,
} from "./protocol/validate.ts";
export type {
  DeterministicAbortableScript,
  DeterministicFailureScript,
  DeterministicProviderOptions,
  DeterministicProviderScript,
  DeterministicTextScript,
  DeterministicToolScript,
} from "./routing/deterministic-adapter.ts";
export {
  createDeterministicProviderAdapter,
  deterministicEchoRequest,
} from "./routing/deterministic-adapter.ts";
export type {
  ExplicitModelSelection,
  ResolveRouteInput,
  RoutedCatalogEntry,
  RouteSelectionReason,
  RoutingOutcome,
  RoutingReceipt,
} from "./routing/routing.ts";
export {
  modelMatchesRequirements,
  resolveModelRoute,
  resolveNextFallback,
} from "./routing/routing.ts";
