/** Source-verified boundary for direct ChatGPT/Codex subscription access. */

export const OPENAI_CODEX_PROVIDER_ID = "openai-codex" as const;

export const OPENAI_CODEX_AUTHORIZATION_UNAVAILABLE_CODE =
  "openai-codex-third-party-authorization-unavailable" as const;

/**
 * Official Codex documentation describes authentication owned by Codex and an
 * experimental app-server delegation boundary. It does not document an OAuth
 * client registration or subscription-backed HTTP contract for Falryn.
 *
 * Sources verified 2026-08-31:
 * - https://developers.openai.com/codex/auth/
 * - https://developers.openai.com/codex/cli/reference/
 * - https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md
 */
export const OPENAI_CODEX_AUTHORIZATION_UNAVAILABLE_MESSAGE =
  "OpenAI does not document a third-party ChatGPT/Codex OAuth client or subscription backend for Falryn; no first-party credentials or API-key billing fallback will be used.";

type OpenAiCodexProfilePolicyInput = {
  readonly providerId: string;
  readonly adapterKind: string;
  readonly endpoint: string | null;
  readonly credential: unknown | null;
  readonly discovery: string;
};

type OpenAiCodexProfilePolicyIssue = {
  readonly path: "providerId" | "adapterKind" | "endpoint" | "credential" | "discovery";
  readonly message: string;
};

/** Keep the reserved subscription identity fail-closed at every profile boundary. */
export function openAiCodexProfilePolicyIssue(
  profile: OpenAiCodexProfilePolicyInput,
): OpenAiCodexProfilePolicyIssue | null {
  const reservedProvider = profile.providerId === OPENAI_CODEX_PROVIDER_ID;
  const reservedAdapter = profile.adapterKind === OPENAI_CODEX_PROVIDER_ID;
  if (reservedProvider !== reservedAdapter) {
    return {
      path: reservedProvider ? "adapterKind" : "providerId",
      message: "the openai-codex provider identity and adapter must be used together",
    };
  }
  if (!reservedProvider) {
    return null;
  }
  if (profile.endpoint !== null) {
    return { path: "endpoint", message: "openai-codex has no direct provider endpoint" };
  }
  if (profile.credential !== null) {
    return { path: "credential", message: "openai-codex cannot reference an API credential" };
  }
  if (profile.discovery !== "static") {
    return {
      path: "discovery",
      message: "openai-codex cannot perform direct provider model discovery",
    };
  }
  return null;
}
