/**
 * Provider ports and normalized boundary schemas.
 *
 * This source area owns provider-neutral requests, stream events, profiles,
 * authentication snapshots, capability discovery, and the adapter port. Vendor
 * SDKs stay in leaf adapters (none shipped yet). Domain, application, CLI, and
 * OpenTUI must not import SDK types through this surface.
 */

export type { DiscoveryPolicy, ProviderAdapterKind } from "./adapter-kind.ts";
export {
  DISCOVERY_POLICIES,
  isDiscoveryPolicy,
  isProviderAdapterKind,
  PROVIDER_ADAPTER_KINDS,
} from "./adapter-kind.ts";
export type {
  ProviderAuthOutcome,
  ProviderAuthSnapshot,
  ProviderAuthState,
  ProviderRevocationReport,
} from "./auth.ts";
export {
  authStateForCredentialFailure,
  isProviderAuthState,
  PROVIDER_AUTH_STATES,
} from "./auth.ts";
export { establishProviderAuth, removeProviderCredential } from "./auth-service.ts";
export type {
  DeterministicProviderOptions,
  DeterministicProviderScript,
} from "./deterministic-adapter.ts";
export {
  createDeterministicProviderAdapter,
  deterministicEchoRequest,
} from "./deterministic-adapter.ts";
export type {
  CatalogProvenance,
  DiscoveryFailureKind,
  DiscoveryOutcome,
  ModelCapability,
  ModelCatalog,
  ModelDiscoveryPort,
  ModelModality,
  StaticDiscoveryOptions,
} from "./discovery.ts";
export {
  createDeterministicRemoteDiscovery,
  createStaticModelDiscovery,
  discoverModelCatalog,
  MODEL_MODALITIES,
} from "./discovery.ts";
export type { ProviderFailure, ProviderFailureKind } from "./errors.ts";
export { isProviderFailureKind, PROVIDER_FAILURE_KINDS } from "./errors.ts";
export type {
  ModelRequestId,
  ProviderIdentityError,
  ProviderIdentityErrorCode,
} from "./identity.ts";
export { modelRequestId } from "./identity.ts";
export {
  MAX_FINISH_REASON_LENGTH,
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
} from "./limits.ts";
export type {
  ImageMessagePart,
  MessagePart,
  MessageRole,
  ModelBudgets,
  ModelMessage,
  ModelToolDefinition,
  OutputContract,
  RequestMetadata,
  TextMessagePart,
} from "./messages.ts";
export { isMessageRole, MESSAGE_ROLES } from "./messages.ts";
export type {
  ProviderAdapterIdentity,
  ProviderAdapterPort,
  ProviderStreamOptions,
} from "./port.ts";
export type {
  ProviderNetworkTimeouts,
  ProviderProfile,
  ProviderProfileId,
} from "./profile.ts";
export { profileCredentialConsumer } from "./profile.ts";
export type { ProviderProfileParseError } from "./profile-schema.ts";
export { parseProviderProfile, providerProfileSchema } from "./profile-schema.ts";
export type { ModelRequest } from "./request.ts";
export type { ModelRole, WorkIntent } from "./roles.ts";
export { isModelRole, isWorkIntent, MODEL_ROLES, WORK_INTENTS } from "./roles.ts";
export {
  isSupportedProviderSchemaVersion,
  modelRequestSchema,
  normalizedProviderEventSchema,
} from "./schemas.ts";
export type {
  OpenProviderSessionOptions,
  OpenProviderSessionResult,
  ProviderSession,
  ProviderSessionPorts,
} from "./session.ts";
export { openProviderSession, revokeProviderSessionCredential } from "./session.ts";
export type {
  NormalizedProviderEvent,
  ProviderEventKind,
  ProviderEventSpine,
  UsageUnits,
} from "./stream.ts";
export {
  isProviderEventKind,
  isTerminalProviderEvent,
  PROVIDER_EVENT_KINDS,
} from "./stream.ts";
export type { ProviderBoundaryParseError } from "./validate.ts";
export {
  parseModelRequest,
  parseNormalizedProviderEvent,
  redactProviderDiagnosticText,
} from "./validate.ts";
