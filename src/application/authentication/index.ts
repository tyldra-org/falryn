/** Public contracts for this capability. Internal modules import their exact dependencies. */

export type {
  AuthorizedLoginAdapterBinding,
  AuthorizedLoginAdapterRegistry,
  AuthorizedLoginAdapterResolution,
  AuthorizedLoginRegistrySnapshot,
} from "./authorized-login-registry.ts";
export { createAuthorizedLoginAdapterRegistry } from "./authorized-login-registry.ts";
export type { AuthorizedProviderLoginOptions } from "./authorized-provider-login.ts";
export { createAuthorizedProviderLogin } from "./authorized-provider-login.ts";
export type { SecretResolverOptions } from "./credential-resolver.ts";
export { createSecretResolver } from "./credential-resolver.ts";
export type { ProductCredentialBundle } from "./product-credentials.ts";
export {
  DEFAULT_OPENAI_CREDENTIAL_REFERENCE,
  resolveProviderApiKey,
} from "./product-credentials.ts";
