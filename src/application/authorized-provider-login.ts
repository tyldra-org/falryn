/** Shared PKCE, device-code, refresh, and revocation orchestration. */

import {
  addDuration,
  type ClockPort,
  type CredentialReference,
  duration,
  type Instant,
} from "../domain/index.ts";
import {
  AUTHORIZED_LOGIN_SCHEMA_VERSION,
  type AuthorizedLoginMethod,
  type AuthorizedProviderCredential,
  type AuthorizedProviderLoginHost,
  MAX_AUTHORIZATION_CODE_LENGTH,
  MAX_AUTHORIZATION_URL_LENGTH,
  type ProviderAccountMetadata,
  type ProviderAuthorizationExchangeResult,
  type ProviderAuthorizationReceipt,
  type ProviderAuthorizedLoginAdapter,
  type ProviderConnection,
  type ProviderDeviceCodePollResult,
  type ProviderProfile,
  type ProviderRefreshResult,
  type ProviderRemoteRevocationResult,
  parseAuthorizedProviderCredential,
  profileCredentialConsumer,
} from "../providers/index.ts";
import type { AuthorizedLoginAdapterRegistry } from "./authorized-login-registry.ts";
import type {
  ProductAuthorizedCredentialResolution,
  ProductCredentialBundle,
} from "./product-credentials.ts";
import type {
  AuthorizedProviderLoginPort,
  AuthorizedProviderLoginResult,
  AuthorizedProviderRefreshResult,
  AuthorizedProviderRevocationResult,
} from "./provider-connections/contracts.ts";

const MAX_ACTIVE_AUTHORIZATIONS = 8;
const MAX_AUTHORIZATION_LIFETIME_MS = duration(10 * 60_000);
const MAX_CALLBACK_HEADERS_BYTES = 16 * 1_024;
const MAX_CALLBACK_BODY_BYTES = 4 * 1_024;
const MAX_CALLBACK_REQUESTS = 4;
const PKCE_VERIFIER_BYTES = 48;
const STATE_BYTES = 32;
const ATTEMPT_ID_BYTES = 18;
const MAX_DEVICE_POLL_INTERVAL_MS = duration(60_000);

export type AuthorizedProviderLoginOptions = {
  readonly registry: AuthorizedLoginAdapterRegistry;
  readonly credentials: ProductCredentialBundle;
  readonly clock: ClockPort;
  readonly host: AuthorizedProviderLoginHost;
  readonly maxActiveAttempts?: number;
};

export function createAuthorizedProviderLogin(
  options: AuthorizedProviderLoginOptions,
): AuthorizedProviderLoginPort {
  const activeProfiles = new Set<string>();
  const maxActiveAttempts = Math.max(
    1,
    Math.min(options.maxActiveAttempts ?? MAX_ACTIVE_AUTHORIZATIONS, MAX_ACTIVE_AUTHORIZATIONS),
  );

  return {
    methods: (profile) => options.registry.methods(profile),
    async authorize(profile, method, signal) {
      if (activeProfiles.has(profile.profileId) || activeProfiles.size >= maxActiveAttempts) {
        return {
          kind: "failed",
          code: "authorization-already-active",
          retryable: true,
          receipt: null,
        };
      }
      const resolved = options.registry.resolve(profile, method);
      if (resolved.kind === "unavailable") {
        return { kind: "failed", code: resolved.code, retryable: false, receipt: null };
      }

      const attempt = createAttempt(
        options,
        profile,
        method,
        resolved.binding.generation,
        resolved.binding.adapter,
      );
      activeProfiles.add(profile.profileId);
      try {
        return await runAttempt(attempt, signal);
      } finally {
        activeProfiles.delete(profile.profileId);
      }
    },
    async refresh(connection, signal) {
      return refreshConnection(options, connection, signal);
    },
    async revoke(connection, signal) {
      return revokeConnection(options, connection, signal);
    },
  };
}

type Attempt = {
  readonly options: AuthorizedProviderLoginOptions;
  readonly profile: ProviderProfile;
  readonly method: AuthorizedLoginMethod;
  readonly adapterGeneration: number;
  readonly adapter: ProviderAuthorizedLoginAdapter;
  readonly attemptId: string;
  readonly startedAt: Instant;
  readonly deadline: Instant;
};

function createAttempt(
  options: AuthorizedProviderLoginOptions,
  profile: ProviderProfile,
  method: AuthorizedLoginMethod,
  adapterGeneration: number,
  adapter: ProviderAuthorizedLoginAdapter,
): Attempt {
  const startedAt = options.clock.now();
  const lifetime = duration(Math.min(profile.timeouts.requestMs, MAX_AUTHORIZATION_LIFETIME_MS));
  return {
    options,
    profile,
    method,
    adapterGeneration,
    adapter,
    attemptId: `auth-${options.host.crypto.randomBase64Url(ATTEMPT_ID_BYTES)}`,
    startedAt,
    deadline: addDuration(startedAt, lifetime),
  };
}

async function runAttempt(
  attempt: Attempt,
  parentSignal?: AbortSignal,
): Promise<AuthorizedProviderLoginResult> {
  const control = deadlineSignal(attempt.options.clock, attempt.deadline, parentSignal);
  try {
    const exchange =
      attempt.method === "oauth-pkce"
        ? await runPkce(attempt, control.signal)
        : await runDeviceCode(attempt, control.signal);
    if (control.timedOut()) {
      return timedOut(attempt, "authorization-deadline-exceeded");
    }
    if (parentSignal?.aborted === true || exchange.kind === "cancelled") {
      return cancelled(attempt);
    }
    if (exchange.kind === "denied") {
      return denied(attempt, exchange.code);
    }
    if (exchange.kind === "failed") {
      return failed(attempt, exchange.code, exchange.retryable);
    }
    const authorized = await finalizeAuthorization(attempt, exchange, control.signal);
    return authorized;
  } catch {
    return control.timedOut()
      ? timedOut(attempt, "authorization-deadline-exceeded")
      : parentSignal?.aborted === true
        ? cancelled(attempt)
        : failed(attempt, "authorization-adapter-threw", true);
  } finally {
    control.dispose();
  }
}

type CoordinatedExchange = ProviderAuthorizationExchangeResult | { readonly kind: "cancelled" };

async function runPkce(attempt: Attempt, signal: AbortSignal): Promise<CoordinatedExchange> {
  if (signal.aborted) {
    return { kind: "cancelled" };
  }
  const begin = attempt.adapter.beginPkce;
  const exchange = attempt.adapter.exchangePkce;
  if (begin === undefined || exchange === undefined) {
    return { kind: "failed", code: "pkce-adapter-incomplete", retryable: false };
  }
  const state = attempt.options.host.crypto.randomBase64Url(STATE_BYTES);
  const verifier = attempt.options.host.crypto.randomBase64Url(PKCE_VERIFIER_BYTES);
  const challenge = attempt.options.host.crypto.sha256Base64Url(verifier);
  const callbackModes = attempt.adapter.descriptor.callbackModes;

  if (callbackModes.includes("loopback")) {
    const opened = await attempt.options.host.loopback.listen({
      attemptId: attempt.attemptId,
      deadline: attempt.deadline,
      fixedRedirectUri: attempt.adapter.descriptor.loopbackRedirectUri,
      maxHeaderBytes: MAX_CALLBACK_HEADERS_BYTES,
      maxBodyBytes: MAX_CALLBACK_BODY_BYTES,
      maxRequests: MAX_CALLBACK_REQUESTS,
    });
    if (opened.kind === "listening") {
      const session = opened.session;
      try {
        const started = await begin(
          attempt.profile,
          {
            attemptId: attempt.attemptId,
            state,
            codeChallenge: challenge,
            redirectUri: session.redirectUri,
            scopes: attempt.adapter.descriptor.scopes,
          },
          signal,
        );
        if (started.kind !== "ready") {
          return started;
        }
        if (!validAuthorizationUrl(started.authorizationUrl)) {
          return { kind: "failed", code: "authorization-url-invalid", retryable: false };
        }
        const localLaunchUri = session.prepareBrowserLaunch(started.authorizationUrl);
        if (localLaunchUri === null) {
          return { kind: "failed", code: "browser-launch-unavailable", retryable: true };
        }
        const browser = await attempt.options.host.browser.launch(localLaunchUri, signal);
        if (browser.kind !== "opened") {
          const presented = await attempt.options.host.interaction.presentLocalLaunchUri({
            providerId: String(attempt.profile.providerId),
            localLaunchUri,
          });
          if (presented.kind !== "presented") {
            return { kind: "failed", code: browser.code, retryable: true };
          }
        }
        const callback = await session.receive(signal);
        if (callback.kind === "cancelled") {
          return callback;
        }
        if (callback.kind === "invalid") {
          return { kind: "failed", code: callback.code, retryable: false };
        }
        if (callback.state === null || !attempt.options.host.crypto.equal(callback.state, state)) {
          return { kind: "failed", code: "authorization-state-mismatch", retryable: false };
        }
        if (callback.kind === "denied") {
          return { kind: "denied", code: safeCode(callback.code) };
        }
        if (!validCode(callback.code)) {
          return { kind: "failed", code: "authorization-code-invalid", retryable: false };
        }
        return exchange(
          attempt.profile,
          {
            attemptId: attempt.attemptId,
            code: callback.code,
            codeVerifier: verifier,
            redirectUri: session.redirectUri,
          },
          signal,
        );
      } finally {
        await session.close();
      }
    }
  }

  if (!callbackModes.includes("manual-code")) {
    return { kind: "failed", code: "authorization-loopback-unavailable", retryable: true };
  }
  const redirectUri = attempt.adapter.descriptor.manualRedirectUri;
  if (redirectUri === null) {
    return { kind: "failed", code: "manual-redirect-unavailable", retryable: false };
  }
  const started = await begin(
    attempt.profile,
    {
      attemptId: attempt.attemptId,
      state,
      codeChallenge: challenge,
      redirectUri,
      scopes: attempt.adapter.descriptor.scopes,
    },
    signal,
  );
  if (started.kind !== "ready") {
    return started;
  }
  if (!validAuthorizationUrl(started.authorizationUrl)) {
    return { kind: "failed", code: "authorization-url-invalid", retryable: false };
  }
  const submitted = await attempt.options.host.interaction.requestAuthorizationCode({
    providerId: String(attempt.profile.providerId),
    authorizationUrl: started.authorizationUrl,
    signal,
  });
  if (submitted.kind === "cancelled") {
    return submitted;
  }
  if (submitted.kind === "unavailable" || !validCode(submitted.code)) {
    return { kind: "failed", code: "manual-authorization-unavailable", retryable: false };
  }
  return exchange(
    attempt.profile,
    {
      attemptId: attempt.attemptId,
      code: submitted.code,
      codeVerifier: verifier,
      redirectUri,
    },
    signal,
  );
}

async function runDeviceCode(attempt: Attempt, signal: AbortSignal): Promise<CoordinatedExchange> {
  if (signal.aborted) {
    return { kind: "cancelled" };
  }
  const begin = attempt.adapter.beginDeviceCode;
  const poll = attempt.adapter.pollDeviceCode;
  if (begin === undefined || poll === undefined) {
    return { kind: "failed", code: "device-code-adapter-incomplete", retryable: false };
  }
  const started = await begin(
    attempt.profile,
    { attemptId: attempt.attemptId, scopes: attempt.adapter.descriptor.scopes },
    signal,
  );
  if (started.kind !== "ready") {
    return started;
  }
  if (
    !validAuthorizationUrl(started.verificationUri) ||
    (started.verificationUriComplete !== null &&
      !validAuthorizationUrl(started.verificationUriComplete)) ||
    !validCode(started.deviceCode) ||
    !validCode(started.userCode)
  ) {
    return { kind: "failed", code: "device-code-response-invalid", retryable: false };
  }
  const initialInterval = pollInterval(started.pollIntervalMs);
  if (initialInterval === null || started.expiresAt <= attempt.options.clock.now()) {
    return { kind: "failed", code: "device-code-response-invalid", retryable: false };
  }
  const presented = await attempt.options.host.interaction.presentDeviceCode({
    providerId: String(attempt.profile.providerId),
    verificationUri: started.verificationUri,
    verificationUriComplete: started.verificationUriComplete,
    userCode: started.userCode,
  });
  if (presented.kind !== "presented") {
    return { kind: "failed", code: "device-code-interaction-unavailable", retryable: false };
  }

  let interval = initialInterval;
  while (!signal.aborted) {
    const expiresAt = Math.min(started.expiresAt, attempt.deadline) as Instant;
    if (attempt.options.clock.now() >= expiresAt) {
      return { kind: "failed", code: "device-code-expired", retryable: false };
    }
    const wake = addDuration(attempt.options.clock.now(), interval);
    const waited = await attempt.options.clock.waitUntil(
      Math.min(wake, expiresAt) as Instant,
      signal,
    );
    if (waited === "aborted") {
      return { kind: "cancelled" };
    }
    if (attempt.options.clock.now() >= expiresAt) {
      return { kind: "failed", code: "device-code-expired", retryable: false };
    }
    const outcome: ProviderDeviceCodePollResult = await poll(
      attempt.profile,
      { attemptId: attempt.attemptId, deviceCode: started.deviceCode },
      signal,
    );
    if (outcome.kind === "pending") {
      if (outcome.retryAfterMs !== null) {
        const retryAfter = pollInterval(outcome.retryAfterMs);
        if (retryAfter === null) {
          return { kind: "failed", code: "device-code-poll-invalid", retryable: false };
        }
        interval = retryAfter;
      }
      continue;
    }
    if (outcome.kind === "slow-down") {
      const retryAfter = pollInterval(outcome.retryAfterMs);
      if (retryAfter === null) {
        return { kind: "failed", code: "device-code-poll-invalid", retryable: false };
      }
      interval = retryAfter;
      continue;
    }
    return outcome;
  }
  return { kind: "cancelled" };
}

async function finalizeAuthorization(
  attempt: Attempt,
  exchange: Extract<ProviderAuthorizationExchangeResult, { readonly kind: "authorized" }>,
  signal: AbortSignal,
): Promise<AuthorizedProviderLoginResult> {
  const normalized = await normalizeAuthorized(attempt, exchange, signal);
  if (normalized.kind !== "authorized") {
    return failed(attempt, normalized.code, normalized.retryable);
  }
  const reference = credentialReference(attempt.profile, attempt.attemptId);
  const written = await attempt.options.credentials.placeAuthorizedCredential({
    reference,
    credential: normalized.credential,
    signal,
  });
  if (written.kind !== "written") {
    return failed(attempt, "authorized-credential-write-failed", written.kind === "failed");
  }
  return {
    kind: "authorized",
    reference,
    account: normalized.account,
    receipt: receipt(attempt, "authorized", null),
  };
}

async function normalizeAuthorized(
  attempt: Attempt,
  exchange: Extract<ProviderAuthorizationExchangeResult, { readonly kind: "authorized" }>,
  signal: AbortSignal,
): Promise<
  | {
      readonly kind: "authorized";
      readonly credential: AuthorizedProviderCredential;
      readonly account: ProviderAccountMetadata;
    }
  | { readonly kind: "failed"; readonly code: string; readonly retryable: boolean }
> {
  const now = attempt.options.clock.now();
  const parsedCredential = parseAuthorizedProviderCredential(exchange.credential);
  if (
    !parsedCredential.ok ||
    (parsedCredential.value.expiresAt !== null && parsedCredential.value.expiresAt <= now) ||
    exchange.account.authMethod !== attempt.method
  ) {
    return { kind: "failed", code: "authorized-credential-invalid", retryable: false };
  }
  const credential = parsedCredential.value;
  let account = exchange.account;
  if (
    account.accountId === null &&
    account.displayName === null &&
    attempt.adapter.descriptor.accountLookup
  ) {
    const lookup = attempt.adapter.lookupAccount;
    if (lookup === undefined) {
      return { kind: "failed", code: "account-lookup-unavailable", retryable: false };
    }
    const lookedUp:
      | ProviderAccountMetadata
      | { readonly kind: "failed"; readonly code: string; readonly retryable: boolean } =
      await lookup(attempt.profile, credential, attempt.method, signal);
    if ("kind" in lookedUp) {
      return { kind: "failed", code: safeCode(lookedUp.code), retryable: lookedUp.retryable };
    }
    account = lookedUp;
  }
  return {
    kind: "authorized",
    credential,
    account: {
      ...account,
      authMethod: attempt.method,
      authorizedAt: now,
      expiresAt: credential.expiresAt,
    },
  };
}

async function refreshConnection(
  options: AuthorizedProviderLoginOptions,
  connection: ProviderConnection,
  signal?: AbortSignal,
): Promise<AuthorizedProviderRefreshResult> {
  const method = connection.account?.authMethod;
  const reference = connection.profile.credential;
  if (method === undefined || method === "api-key" || reference === null) {
    return { kind: "unavailable", code: "authorized-refresh-unavailable", retryable: false };
  }
  if (signal?.aborted === true) {
    return { kind: "cancelled", code: "authorization-cancelled", retryable: false };
  }
  const resolved = options.registry.resolve(connection.profile, method);
  if (resolved.kind === "unavailable" || !resolved.binding.adapter.descriptor.refresh) {
    return { kind: "unavailable", code: "authorized-refresh-unavailable", retryable: false };
  }
  const adapter = resolved.binding.adapter;
  const refresh = adapter.refresh;
  if (refresh === undefined) {
    return { kind: "unavailable", code: "authorized-refresh-unavailable", retryable: false };
  }
  let refreshed: ProductAuthorizedCredentialResolution<ProviderRefreshResult>;
  try {
    refreshed = await options.credentials.withAuthorizedCredential(
      reference,
      (credential) =>
        refresh(connection.profile, credential, signal ?? new AbortController().signal),
      signal,
    );
  } catch {
    return { kind: "failed", code: "authorization-refresh-threw", retryable: true };
  }
  if (refreshed.kind === "invalid") {
    return { kind: "reauthorization-required", code: refreshed.code, retryable: false };
  }
  if (refreshed.kind === "unresolved") {
    return {
      kind: "failed",
      code: refreshed.failure.code,
      retryable: refreshed.failure.retryable,
    };
  }
  const outcome = refreshed.value;
  if (outcome.kind === "reauthorization-required") {
    return { kind: "reauthorization-required", code: safeCode(outcome.code), retryable: false };
  }
  if (outcome.kind === "failed") {
    return { kind: "failed", code: safeCode(outcome.code), retryable: outcome.retryable };
  }
  const now = options.clock.now();
  const parsedCredential = parseAuthorizedProviderCredential(outcome.credential);
  if (
    !parsedCredential.ok ||
    (parsedCredential.value.expiresAt !== null && parsedCredential.value.expiresAt <= now)
  ) {
    return { kind: "failed", code: "refreshed-credential-invalid", retryable: false };
  }
  const credential = parsedCredential.value;
  const attemptId = `refresh-${options.host.crypto.randomBase64Url(ATTEMPT_ID_BYTES)}`;
  const nextReference = credentialReference(connection.profile, attemptId);
  const written = await options.credentials.placeAuthorizedCredential({
    reference: nextReference,
    credential,
    ...(signal === undefined ? {} : { signal }),
  });
  if (written.kind !== "written") {
    return { kind: "failed", code: "refresh-credential-write-failed", retryable: true };
  }
  return {
    kind: "refreshed",
    reference: nextReference,
    account: {
      ...outcome.account,
      authMethod: method,
      authorizedAt: now,
      expiresAt: credential.expiresAt,
    },
  };
}

async function revokeConnection(
  options: AuthorizedProviderLoginOptions,
  connection: ProviderConnection,
  signal?: AbortSignal,
): Promise<AuthorizedProviderRevocationResult> {
  if (signal?.aborted === true) {
    return { remote: "not-attempted", code: "authorization-cancelled" };
  }
  const method = connection.account?.authMethod;
  const reference = connection.profile.credential;
  if (method === undefined || method === "api-key" || reference === null) {
    return { remote: "not-attempted", code: null };
  }
  const resolved = options.registry.resolve(connection.profile, method);
  if (resolved.kind === "unavailable" || !resolved.binding.adapter.descriptor.revoke) {
    return { remote: "unsupported", code: "authorized-revoke-unavailable" };
  }
  const revoke = resolved.binding.adapter.revoke;
  if (revoke === undefined) {
    return { remote: "unsupported", code: "authorized-revoke-unavailable" };
  }
  let revoked: ProductAuthorizedCredentialResolution<ProviderRemoteRevocationResult>;
  try {
    revoked = await options.credentials.withAuthorizedCredential(
      reference,
      (credential) =>
        revoke(connection.profile, credential, signal ?? new AbortController().signal),
      signal,
    );
  } catch {
    return { remote: "failed", code: "authorization-revoke-threw" };
  }
  if (revoked.kind === "invalid") {
    return { remote: "failed", code: revoked.code };
  }
  if (revoked.kind === "unresolved") {
    return { remote: "failed", code: revoked.failure.code };
  }
  switch (revoked.value.kind) {
    case "revoked":
      return { remote: "revoked", code: null };
    case "unsupported":
      return { remote: "unsupported", code: null };
    case "failed":
      return { remote: "failed", code: safeCode(revoked.value.code) };
  }
}

function credentialReference(profile: ProviderProfile, attemptId: string): CredentialReference {
  return {
    storeKind: "operating-system-keychain",
    locator: `falryn.provider-authorized.v1.${profile.profileId}.${attemptId}`,
    consumer: profileCredentialConsumer(profile),
    accountLabel: profile.profileId,
  };
}

function receipt(
  attempt: Attempt,
  outcome: ProviderAuthorizationReceipt["outcome"],
  code: string | null,
): ProviderAuthorizationReceipt {
  return {
    schemaVersion: AUTHORIZED_LOGIN_SCHEMA_VERSION,
    attemptId: attempt.attemptId,
    adapterId: attempt.adapter.descriptor.adapterId,
    adapterGeneration: attempt.adapterGeneration,
    providerId: String(attempt.profile.providerId),
    profileId: attempt.profile.profileId,
    method: attempt.method,
    startedAt: attempt.startedAt,
    finishedAt: attempt.options.clock.now(),
    outcome,
    code,
  };
}

function cancelled(attempt: Attempt): AuthorizedProviderLoginResult {
  return { kind: "cancelled", receipt: receipt(attempt, "cancelled", "authorization-cancelled") };
}

function denied(attempt: Attempt, code: string): AuthorizedProviderLoginResult {
  const normalized = safeCode(code);
  return { kind: "denied", code: normalized, receipt: receipt(attempt, "denied", normalized) };
}

function timedOut(attempt: Attempt, code: string): AuthorizedProviderLoginResult {
  return { kind: "timed-out", code, receipt: receipt(attempt, "timed-out", code) };
}

function failed(attempt: Attempt, code: string, retryable: boolean): AuthorizedProviderLoginResult {
  const normalized = safeCode(code);
  return {
    kind: "failed",
    code: normalized,
    retryable,
    receipt: receipt(attempt, "failed", normalized),
  };
}

function safeCode(code: string): string {
  return /^[a-z0-9][a-z0-9.-]{0,127}$/u.test(code) ? code : "authorization-adapter-failure";
}

function validCode(value: string): boolean {
  return value.length > 0 && value.length <= MAX_AUTHORIZATION_CODE_LENGTH && !value.includes("\0");
}

function validAuthorizationUrl(value: string): boolean {
  if (value.length === 0 || value.length > MAX_AUTHORIZATION_URL_LENGTH) {
    return false;
  }
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

function pollInterval(value: number): ReturnType<typeof duration> | null {
  if (!Number.isSafeInteger(value) || value < 0 || value > MAX_DEVICE_POLL_INTERVAL_MS) {
    return null;
  }
  return duration(Math.max(1, value));
}

function deadlineSignal(
  clock: ClockPort,
  deadline: Instant,
  parent?: AbortSignal,
): {
  readonly signal: AbortSignal;
  timedOut(): boolean;
  dispose(): void;
} {
  const controller = new AbortController();
  let timedOut = false;
  let disposed = false;
  const onParentAbort = (): void => controller.abort();
  parent?.addEventListener("abort", onParentAbort, { once: true });
  void clock.waitUntil(deadline, controller.signal).then((outcome) => {
    if (outcome === "reached" && !disposed) {
      timedOut = true;
      controller.abort();
    }
  });
  if (parent?.aborted === true) {
    controller.abort();
  }
  return {
    signal: controller.signal,
    timedOut: () => timedOut,
    dispose() {
      disposed = true;
      parent?.removeEventListener("abort", onParentAbort);
      controller.abort();
    },
  };
}
