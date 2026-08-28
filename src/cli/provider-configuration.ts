/** Product-owned provider profile declaration for the configuration registry. */

import { type ConfigurationKeyDeclaration, objectKey } from "../config/index.ts";
import { instant } from "../domain/clock.ts";
import { providerId } from "../domain/identity.ts";
import {
  PROVIDER_CONNECTION_SCHEMA_VERSION,
  type ProviderConnectionState,
} from "../providers/connection.ts";
import { providerConnectionStateSchema } from "../providers/connection-schema.ts";
import { LATEST_OPENAI_MODEL_IDS } from "../providers/known-model-capability.ts";

export const PROVIDER_CONNECTIONS_CONFIGURATION_KEY = "providers.connections";

/** Default environment-backed OpenAI profile, routed through the shared connection path. */
export const DEFAULT_PROVIDER_CONNECTION_STATE: ProviderConnectionState = {
  schemaVersion: PROVIDER_CONNECTION_SCHEMA_VERSION,
  revision: 0,
  selectedProfileId: "openai",
  connections: [
    {
      profile: {
        profileId: "openai",
        providerId: providerId.from("openai"),
        adapterKind: "openai",
        displayName: "OpenAI",
        endpoint: "https://api.openai.com/v1",
        credential: {
          storeKind: "environment",
          locator: "FALRYN_OPENAI_API_KEY",
          consumer: "provider:openai",
          accountLabel: null,
        },
        organization: null,
        project: null,
        enabledModels: LATEST_OPENAI_MODEL_IDS,
        catalogs: [],
        modelCapabilities: [],
        discovery: "static",
        timeouts: { connectMs: 15_000, requestMs: 120_000 },
      },
      account: null,
      updatedAt: instant(0),
    },
  ],
};

export const PROVIDER_CONNECTION_KEYS: readonly ConfigurationKeyDeclaration[] = [
  objectKey({
    path: PROVIDER_CONNECTIONS_CONFIGURATION_KEY,
    summary: "Provider profiles, safe account metadata, and the selected profile.",
    objectSchema: providerConnectionStateSchema,
    defaultValue: DEFAULT_PROVIDER_CONNECTION_STATE,
    scopes: ["user", "profile"],
    applicationClass: "next-operation",
    sensitivity: "public",
  }),
];
