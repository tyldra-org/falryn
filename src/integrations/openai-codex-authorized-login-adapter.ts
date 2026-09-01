/** Policy-only authorized-login adapter for the distinct OpenAI Codex identity. */

import { providerId } from "../domain/index.ts";
import {
  AUTHORIZED_LOGIN_SCHEMA_VERSION,
  OPENAI_CODEX_AUTHORIZATION_UNAVAILABLE_CODE,
  OPENAI_CODEX_PROVIDER_ID,
  type ProviderAuthorizedLoginAdapter,
} from "../providers/index.ts";

const unavailable = async () => ({
  kind: "failed" as const,
  code: OPENAI_CODEX_AUTHORIZATION_UNAVAILABLE_CODE,
  retryable: false,
});

/**
 * Advertise the user-selectable methods while failing closed before any
 * browser, device, token, or provider transport operation can begin.
 */
export function createOpenAiCodexAuthorizedLoginAdapter(): ProviderAuthorizedLoginAdapter {
  return {
    descriptor: {
      schemaVersion: AUTHORIZED_LOGIN_SCHEMA_VERSION,
      adapterId: "openai-codex-policy",
      providerId: providerId.from(OPENAI_CODEX_PROVIDER_ID),
      adapterKind: "openai-codex",
      methods: ["oauth-pkce", "device-code"],
      scopes: [],
      callbackModes: ["loopback"],
      loopbackRedirectUri: null,
      manualRedirectUri: null,
      refresh: false,
      revoke: false,
      accountLookup: false,
      revision: "official-policy-2026-08-31",
    },
    availability: () => ({
      kind: "unavailable",
      code: OPENAI_CODEX_AUTHORIZATION_UNAVAILABLE_CODE,
    }),
    beginPkce: unavailable,
    exchangePkce: unavailable,
    beginDeviceCode: unavailable,
    pollDeviceCode: unavailable,
  };
}
