/** Provider command projection over the application-owned connection service. */

import {
  adoptForeignError,
  type ProviderConnectionAction,
  type ProviderConnectionActionResult,
} from "../../application/index.ts";
import type { InputStreamPort } from "../../domain/index.ts";
import type { ProviderCommandArguments } from "../command-tree.ts";
import type { GlobalOptions } from "../options.ts";
import { composeProductProviderConnections } from "../product-provider-connections.ts";
import type { CommandEffect, CommandResultOf } from "../result.ts";
import type { ServiceProvider } from "../services.ts";
import { resultFor } from "./shared.ts";

const MAX_API_KEY_BYTES = 16_384;

export type ProviderCommandPayload = ProviderConnectionActionResult;

export async function runProvider(
  services: ServiceProvider,
  arguments_: ProviderCommandArguments,
  globals: GlobalOptions,
  input: InputStreamPort,
  signal?: AbortSignal,
  onMutationStart?: () => void,
): Promise<CommandResultOf<"provider", ProviderCommandPayload>> {
  const action = await actionFor(arguments_, input);
  if (typeof action === "string") {
    return providerFailure(arguments_.action, action);
  }
  if (isMutation(action)) {
    onMutationStart?.();
  }
  const service = composeProductProviderConnections(services(), globals).service;
  const payload = await service.execute(action, signal);
  if (payload.kind === "completed") {
    return resultFor("provider", payload, [], undefined, effectFor(action, "completed"));
  }
  const uncertain =
    payload.issue.code === "credential-rollback-failed" ||
    payload.issue.code === "credential-state-diverged";
  return resultFor(
    "provider",
    payload,
    [
      providerError(
        {
          code: `provider.connection.${payload.issue.code}`,
          category: "provider",
          message: messageFor(payload.issue.code),
          retryable: payload.issue.retryable,
          effect: uncertain ? "uncertain" : "none",
        },
        { operation: `provider ${arguments_.action}` },
      ),
    ],
    uncertain ? { kind: "uncertain", effect: "uncertain" } : undefined,
    effectFor(action, uncertain ? "uncertain" : "none"),
  );
}

function providerError(
  input: {
    readonly code: string;
    readonly category: string;
    readonly message: string;
    readonly retryable: boolean;
    readonly effect: CommandEffect["observed"];
  },
  context: { readonly operation: string },
): ReturnType<typeof adoptForeignError> {
  return {
    ...adoptForeignError(input, context),
    retryable: input.retryable,
    effect: input.effect,
  };
}

async function actionFor(
  arguments_: ProviderCommandArguments,
  input: InputStreamPort,
): Promise<ProviderConnectionAction | string> {
  switch (arguments_.action) {
    case "list":
      return { kind: "list" };
    case "add":
      return { kind: "add", profile: arguments_.profile };
    case "configure":
      return { kind: "configure", profile: arguments_.profile, preserveCredential: true };
    case "use":
    case "test":
    case "logout":
    case "remove":
      return { kind: arguments_.action, profileId: arguments_.profileId };
    case "login":
      if (arguments_.method !== "api-key") {
        return {
          kind: "login-authorized",
          profileId: arguments_.profileId,
          method: arguments_.method,
        };
      }
      return apiKeyAction(arguments_.profileId, arguments_.accountLabel, input);
  }
}

async function apiKeyAction(
  profileId: string,
  accountLabel: string | null,
  input: InputStreamPort,
): Promise<ProviderConnectionAction | string> {
  const read = await input.read();
  if (!read.ok) {
    return read.error.code === "too-large"
      ? "The API key exceeds the bounded stdin limit."
      : "The API key could not be read as UTF-8 from stdin.";
  }
  if (read.value.kind === "not-connected" || read.value.kind === "empty") {
    return "Provider login requires a non-empty API key on stdin and never prompts.";
  }
  const secret = read.value.text.trim();
  if (secret.length === 0 || new TextEncoder().encode(secret).byteLength > MAX_API_KEY_BYTES) {
    return "Provider login requires a non-empty API key within the bounded stdin limit.";
  }
  return { kind: "login-api-key", profileId, secret, accountLabel };
}

function providerFailure(
  action: ProviderCommandArguments["action"],
  message: string,
): CommandResultOf<"provider", ProviderCommandPayload> {
  return resultFor("provider", null, [
    adoptForeignError(
      {
        code: "provider.connection.input",
        category: "configuration",
        message,
      },
      { operation: `provider ${action}` },
    ),
  ]);
}

function isMutation(action: ProviderConnectionAction): boolean {
  return action.kind !== "list" && action.kind !== "test";
}

function effectFor(
  action: ProviderConnectionAction,
  observed: CommandEffect["observed"],
): CommandEffect {
  return { intent: isMutation(action) ? "mutate" : "none", observed };
}

function messageFor(code: string): string {
  switch (code) {
    case "profile-missing":
      return "The provider profile does not exist.";
    case "selected-profile-required":
      return "No provider profile is selected.";
    case "credential-already-configured":
      return "The profile already has a credential reference; log out before replacing it.";
    case "credential-state-diverged":
      return "The local credential changed but the provider profile could not be updated; retry logout or removal to repair the reference.";
    case "credential-expired":
      return "The provider credential has expired; authenticate the profile again.";
    case "provider-not-ready":
      return "The provider profile is not ready; inspect its authentication and catalog state.";
    case "authorized-login-unavailable":
      return "This provider has no official authorized login adapter in this build.";
    case "selected-profile-remove-refused":
      return "Select another provider before removing the active profile.";
    case "state-stale":
      return "Provider configuration changed concurrently; reload it before retrying.";
    default:
      return `The provider action failed (${code}).`;
  }
}
