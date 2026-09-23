/** Public contracts for this capability. Internal modules import their exact dependencies. */

export type {
  GenerationActivity,
  GenerationActivityEntry,
  GenerationLiveUpdate,
  GenerationTimingRecorder,
  GenerationTimingSink,
} from "./generation-timing.ts";
export {
  createGenerationActivity,
  createGenerationTimingRecorder,
  timeProviderStream,
} from "./generation-timing.ts";
export type {
  UserModelCatalogLoadError,
  UserModelCatalogLoaderOptions,
} from "./model-catalogs.ts";
export {
  createUserCatalogModelDiscovery,
  loadUserModelCatalogs,
} from "./model-catalogs.ts";
export type {
  AuthorizedProviderLoginPort,
  AuthorizedProviderLoginResult,
  ProviderConnectionAction,
  ProviderConnectionActionResult,
  ProviderConnectionDiscoveryView,
  ProviderConnectionHandoffResult,
  ProviderConnectionIssueCode,
  ProviderConnectionService,
  ProviderConnectionServicePorts,
  ProviderConnectionStorePort,
  ProviderConnectionStoreSnapshot,
  ProviderConnectionStoreWriteResult,
  ProviderConnectionView,
} from "./provider-connections.ts";
export { createProviderConnectionService } from "./provider-connections.ts";
export type {
  ConsumeProviderStreamInput,
  ProviderStreamConsumeOutcome,
  ProviderStreamConsumer,
  ProviderStreamConsumerOptions,
} from "./provider-stream-consumer.ts";
export {
  createProviderStreamConsumer,
  DEFAULT_PROVIDER_STREAM_QUEUE_LIMITS,
} from "./provider-stream-consumer.ts";
