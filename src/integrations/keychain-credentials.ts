/**
 * The operating-system keychain store, as a supervised command.
 *
 * **No native credential module enters the lockfile.** A native binding is the
 * highest-risk dependency there is for `bun build --compile` — it has to match
 * operating system, architecture, and libc — and the usual choice for this job
 * is unmaintained. Falryn already reaches platform capabilities it cannot get
 * from Bun by running the platform's own command, and this is one more of those:
 * a narrow leaf over `/usr/bin/security` with a structured argument vector, an
 * empty environment, a bounded output, and a deadline.
 *
 * **This adapter is internal.** It is not a tool, it is registered in no
 * capability catalog, and it does not pass through the tool boundary. A
 * model-requested credential read is not a supported path.
 *
 * **macOS is the qualified target.** Linux and Windows report `unsupported`
 * with a reason rather than pretending a credential is absent; qualifying those
 * platforms is #220. The environment-reference store works everywhere, so no
 * platform is left without a credential path.
 */

import {
  type ClockPort,
  type CommandOutcome,
  type CommandRunnerPort,
  type CredentialPartOutcome,
  type CredentialReference,
  type CredentialRequestOptions,
  type CredentialResolution,
  type CredentialStoreAvailability,
  type CredentialStorePort,
  type CredentialUnresolvedStatus,
  DEFAULT_CREDENTIAL_TIMEOUT_MS,
  type DurationMs,
  healthForStatus,
  type LocalDataPlatform,
  MAX_COMMAND_OUTPUT_BYTES,
  type SecretUse,
} from "../domain/index.ts";

const STORE_KIND = "operating-system-keychain" as const;

/** The platform command. Absolute, so nothing resolves it through `PATH`. */
export const SECURITY_EXECUTABLE = "/usr/bin/security";

/**
 * `security` exits with the low byte of the `OSStatus` it received.
 *
 * That rule is what makes this table derivable rather than guessed: an
 * `errSecItemNotFound` of `-25300` has low byte `0x2C`, which is the exit code
 * `44` observed on macOS for a generic password that does not exist. Every row
 * below is the same arithmetic applied to a documented `errSec` value.
 *
 * A status this table does not name is reported `unavailable` with its exit
 * code preserved in the failure code. Mapping an unknown status onto `missing`
 * would tell a user their credential is gone because a keychain misbehaved.
 */
export const KEYCHAIN_EXIT_STATUSES: Readonly<Record<number, CredentialUnresolvedStatus>> = {
  // errSecItemNotFound (-25300). Verified against macOS during this delivery.
  44: "missing",
  // errSecInteractionRequired (-25315).
  29: "locked",
  // errSecInteractionNotAllowed (-25308) — a locked keychain in a run that
  // cannot prompt.
  36: "locked",
  // errSecAuthFailed (-25293).
  51: "denied",
  // errSecUserCanceled (-128) — the authorization dialog was dismissed.
  128: "denied",
  // errSecNoSuchKeychain (-25294).
  50: "unavailable",
  // errSecNotAvailable (-25291).
  53: "unavailable",
};

/** Statuses worth another attempt: the state that caused them can change. */
const RETRYABLE_STATUSES: ReadonlySet<CredentialUnresolvedStatus> = new Set([
  "locked",
  "denied",
  "unavailable",
  "timed-out",
  "cancelled",
]);

/**
 * A locator `security` will read as a service name and not as an option.
 *
 * A leading dash is refused because `security` would take it as a flag. Control
 * characters are refused because a name containing one cannot have been created
 * by this build and is not worth handing to a subprocess.
 */
const LEGAL_LOCATOR = /^[^\p{Cc}-][^\p{Cc}]{0,255}$/u;

export type KeychainCredentialStoreOptions = {
  readonly commands: CommandRunnerPort;
  readonly clock: ClockPort;
  readonly platform: LocalDataPlatform;
  readonly timeoutMs?: DurationMs;
};

export function createKeychainCredentialStore(
  options: KeychainCredentialStoreOptions,
): CredentialStorePort {
  const { commands, clock, platform } = options;
  const timeoutMs = options.timeoutMs ?? DEFAULT_CREDENTIAL_TIMEOUT_MS;

  const availability: CredentialStoreAvailability =
    platform === "darwin"
      ? { kind: "available" }
      : {
          kind: "unsupported",
          platform,
          reason:
            "Falryn qualifies the operating-system keychain on macOS only. Use an environment credential reference on this platform.",
        };

  const unresolved = (
    status: CredentialUnresolvedStatus,
    code: string,
    consumer: string,
  ): CredentialResolution<never> => ({
    kind: "unresolved",
    failure: {
      status,
      code,
      retryable: RETRYABLE_STATUSES.has(status),
      storeKind: STORE_KIND,
      consumer,
      health: healthForStatus(status, STORE_KIND, clock.now()),
    },
  });

  const argumentsFor = (
    subcommand: "find-generic-password" | "delete-generic-password",
    reference: CredentialReference,
  ): readonly string[] => {
    const argv = [subcommand, "-s", reference.locator];
    if (reference.accountLabel !== null) {
      argv.push("-a", reference.accountLabel);
    }
    if (subcommand === "find-generic-password") {
      // `-w` prints the password alone. Without it `security` prints the whole
      // item's attributes, which is more of the keychain than was asked for.
      argv.push("-w");
    }
    return argv;
  };

  const run = (
    argv: readonly string[],
    requestOptions?: CredentialRequestOptions,
  ): Promise<CommandOutcome> =>
    commands.run({
      executable: SECURITY_EXECUTABLE,
      argv,
      // Empty rather than inherited: a child that inherits this process's
      // environment inherits every credential already in it.
      environment: {},
      timeoutMs: requestOptions?.timeoutMs ?? timeoutMs,
      maxOutputBytes: MAX_COMMAND_OUTPUT_BYTES,
      signal: requestOptions?.signal,
    });

  return {
    storeKind: STORE_KIND,

    availability: (): CredentialStoreAvailability => availability,

    async read<Value>(
      reference: CredentialReference,
      use: SecretUse<Value>,
      requestOptions?: CredentialRequestOptions,
    ): Promise<CredentialResolution<Value>> {
      if (availability.kind === "unsupported") {
        return unresolved("unsupported", `platform-${platform}`, reference.consumer);
      }
      if (requestOptions?.signal?.aborted === true) {
        return unresolved("cancelled", "aborted-before-spawn", reference.consumer);
      }
      if (!LEGAL_LOCATOR.test(reference.locator)) {
        return unresolved("malformed", "illegal-locator", reference.consumer);
      }

      const outcome = await run(argumentsFor("find-generic-password", reference), requestOptions);
      if (outcome.kind !== "exited") {
        return unresolved(
          nonExitStatus(outcome.kind),
          `spawn-${outcome.kind === "spawn-failed" ? outcome.code : outcome.kind}`,
          reference.consumer,
        );
      }
      if (outcome.exitCode !== 0) {
        const status = KEYCHAIN_EXIT_STATUSES[outcome.exitCode] ?? "unavailable";
        return unresolved(status, `keychain-exit-${outcome.exitCode}`, reference.consumer);
      }

      // `security -w` terminates the password with one newline. Only that one is
      // removed: trimming further would silently alter a secret whose own last
      // character is whitespace.
      const secret = outcome.stdout.endsWith("\n") ? outcome.stdout.slice(0, -1) : outcome.stdout;
      if (secret.length === 0) {
        return unresolved("empty", "empty-entry", reference.consumer);
      }

      return {
        kind: "resolved",
        value: await use(secret),
        health: { state: "present", storeKind: STORE_KIND, observedAt: clock.now() },
      };
    },

    async removeSecret(
      reference: CredentialReference,
      requestOptions?: CredentialRequestOptions,
    ): Promise<CredentialPartOutcome> {
      if (availability.kind === "unsupported") {
        return { result: "unsupported", code: `platform-${platform}` };
      }
      if (!LEGAL_LOCATOR.test(reference.locator)) {
        return { result: "failed", code: "illegal-locator" };
      }
      const outcome = await run(argumentsFor("delete-generic-password", reference), requestOptions);
      if (outcome.kind !== "exited") {
        return { result: "failed", code: `spawn-${outcome.kind}` };
      }
      if (outcome.exitCode === 0) {
        return { result: "removed", code: null };
      }
      return KEYCHAIN_EXIT_STATUSES[outcome.exitCode] === "missing"
        ? { result: "not-present", code: null }
        : { result: "failed", code: `keychain-exit-${outcome.exitCode}` };
    },
  };
}

function nonExitStatus(
  kind: "timed-out" | "cancelled" | "spawn-failed" | "output-exceeded",
): CredentialUnresolvedStatus {
  switch (kind) {
    case "timed-out":
      return "timed-out";
    case "cancelled":
      return "cancelled";
    case "spawn-failed":
      return "unavailable";
    case "output-exceeded":
      // The command wrote more than a credential can be, so whatever it wrote
      // is not one. A prefix of it is not a shorter secret.
      return "malformed";
  }
}
