/**
 * Exact-name lookup for environment values published after Falryn started.
 *
 * macOS exposes one variable at a time through `launchctl getenv`. Windows has
 * no equivalent live process-environment API, but user and machine variables
 * are queryable by exact name through the platform runtime. Linux has no
 * standard single-name session API, so this adapter deliberately returns no
 * port there instead of dumping a user manager's complete environment.
 */

import {
  type CommandOutcome,
  type CommandRunnerPort,
  type CredentialRequestOptions,
  DEFAULT_CREDENTIAL_TIMEOUT_MS,
  type DurationMs,
  type EnvironmentPort,
  isAbsoluteCommandPath,
  type LocalDataPlatform,
  MAX_CREDENTIAL_SECRET_BYTES,
} from "../domain/index.ts";

export const LAUNCHCTL_EXECUTABLE = "/bin/launchctl";
const DEFAULT_WINDOWS_ROOT = "C:\\Windows";
const WINDOWS_VARIABLE_ARGUMENT = "FALRYN_CREDENTIAL_VARIABLE";
const WINDOWS_POWERSHELL_SCRIPT =
  `$value=[Environment]::GetEnvironmentVariable($env:${WINDOWS_VARIABLE_ARGUMENT},'User');` +
  `if($null -eq $value){$value=[Environment]::GetEnvironmentVariable($env:${WINDOWS_VARIABLE_ARGUMENT},'Machine')};` +
  "if($null -ne $value){[Console]::Out.Write($value)}";

export type SessionEnvironmentLookupOutcome =
  | { readonly kind: "found"; readonly value: string }
  | { readonly kind: "missing" }
  | {
      readonly kind: "cancelled" | "timed-out" | "unavailable" | "malformed";
      readonly code: string;
    };

export type SessionEnvironmentCredentialLookupPort = {
  read(
    variable: string,
    options?: CredentialRequestOptions,
  ): Promise<SessionEnvironmentLookupOutcome>;
};

export type SessionEnvironmentCredentialLookupOptions = {
  readonly commands: CommandRunnerPort;
  readonly environment: EnvironmentPort;
  readonly platform: LocalDataPlatform;
  readonly timeoutMs?: DurationMs;
};

function windowsPowerShell(environment: EnvironmentPort): string {
  const root =
    environment.get("SystemRoot") ?? environment.get("SYSTEMROOT") ?? DEFAULT_WINDOWS_ROOT;
  const candidate = `${root.replace(/[\\/]+$/u, "")}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`;
  return isAbsoluteCommandPath(candidate)
    ? candidate
    : `${DEFAULT_WINDOWS_ROOT}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`;
}

function outcomeFor(
  outcome: CommandOutcome,
  platform: Exclude<LocalDataPlatform, "linux">,
): SessionEnvironmentLookupOutcome {
  if (outcome.kind !== "exited") {
    switch (outcome.kind) {
      case "cancelled":
        return { kind: "cancelled", code: "session-environment-cancelled" };
      case "timed-out":
        return { kind: "timed-out", code: "session-environment-timed-out" };
      case "output-exceeded":
        return { kind: "malformed", code: "session-environment-too-large" };
      case "spawn-failed":
        return { kind: "unavailable", code: "session-environment-command-unavailable" };
    }
  }
  if (outcome.exitCode !== 0) {
    return { kind: "unavailable", code: `session-environment-exit-${outcome.exitCode}` };
  }
  const value =
    platform === "darwin" && outcome.stdout.endsWith("\n")
      ? outcome.stdout.slice(0, -1).replace(/\r$/u, "")
      : outcome.stdout;
  if (value.length === 0) {
    return { kind: "missing" };
  }
  if (Buffer.byteLength(value, "utf8") > MAX_CREDENTIAL_SECRET_BYTES) {
    return { kind: "malformed", code: "session-environment-too-large" };
  }
  return { kind: "found", value };
}

/**
 * Create a lookup only where the platform has a safe exact-name mechanism.
 * Linux callers continue to use inherited environment variables and the
 * operating-system secret store.
 */
export function createSessionEnvironmentCredentialLookup(
  options: SessionEnvironmentCredentialLookupOptions,
): SessionEnvironmentCredentialLookupPort | null {
  if (options.platform === "linux") {
    return null;
  }
  const timeoutMs = options.timeoutMs ?? DEFAULT_CREDENTIAL_TIMEOUT_MS;
  const platform = options.platform;
  return {
    async read(variable, request) {
      if (request?.signal?.aborted === true) {
        return { kind: "cancelled", code: "aborted-before-session-environment-read" };
      }
      const outcome = await options.commands.run(
        platform === "darwin"
          ? {
              executable: LAUNCHCTL_EXECUTABLE,
              argv: ["getenv", variable],
              environment: {},
              timeoutMs: request?.timeoutMs ?? timeoutMs,
              maxOutputBytes: MAX_CREDENTIAL_SECRET_BYTES,
              signal: request?.signal,
            }
          : {
              executable: windowsPowerShell(options.environment),
              argv: [
                "-NoLogo",
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                WINDOWS_POWERSHELL_SCRIPT,
              ],
              environment: { [WINDOWS_VARIABLE_ARGUMENT]: variable },
              timeoutMs: request?.timeoutMs ?? timeoutMs,
              maxOutputBytes: MAX_CREDENTIAL_SECRET_BYTES,
              signal: request?.signal,
            },
      );
      return outcomeFor(outcome, platform);
    },
  };
}
