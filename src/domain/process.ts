/**
 * The supervised external-command boundary.
 *
 * Falryn reaches a few platform capabilities Bun does not provide by running
 * the platform's own command. Every such call goes through this port, so the
 * rules that make it safe are declared once rather than re-decided per caller:
 * a structured argument vector, an explicit environment, a bounded output, and
 * a deadline.
 *
 * Two rules the type enforces rather than documents:
 *
 * - **There is no command string.** `executable` and `argv` are separate and
 *   `argv` is a list, so nothing here can be assembled into a shell line. A
 *   locator that begins with a dash is the caller's problem to reject; a
 *   locator containing `;` is not a problem at all.
 * - **The environment is supplied, not inherited.** A child that inherits the
 *   parent's environment inherits every credential in it.
 *
 * `stdout` may hold a secret — that is the point of the one caller this port
 * has today. It is therefore never logged, never folded into a diagnostic, and
 * never attached to an error. JavaScript cannot wipe a string once it exists,
 * so the mitigation is to keep it in one narrow scope rather than to pretend it
 * can be erased.
 *
 * **`stderr` is not returned at all.** A platform tool's error text is written
 * by someone with no idea what Falryn considers sensitive, and it routinely
 * quotes what the tool was asked for. Redacting it would need the application
 * layer's redactor, which a leaf adapter may not import; discarding it costs an
 * exit code's worth of context and removes the leak path entirely.
 */

import type { DurationMs } from "./clock.ts";

/** Longest output a supervised command may produce before it is abandoned. */
export const MAX_COMMAND_OUTPUT_BYTES = 64 * 1_024;

/** Most arguments one command may carry. */
export const MAX_COMMAND_ARGUMENTS = 32;

/** Longest UTF-8 Bash script a non-PTY command may submit. */
export const MAX_COMMAND_SCRIPT_BYTES = 64 * 1_024;

/** Maximum number of environment entries supplied to one child. */
export const MAX_COMMAND_ENVIRONMENT_ENTRIES = 64;

/** Maximum UTF-8 bytes in one complete child environment. */
export const MAX_COMMAND_ENVIRONMENT_BYTES = 32 * 1_024;

export const COMMAND_MODES = ["argv", "bash"] as const;
export type CommandMode = (typeof COMMAND_MODES)[number];

type CommandRequestBase = {
  /** An absolute path. Never resolved through `PATH`. */
  readonly executable: string;
  /** The complete child environment. Inheriting the parent's is not an option. */
  readonly environment: Readonly<Record<string, string>>;
  /** An absolute working directory. Omitted when the caller does not need one. */
  readonly cwd?: string | undefined;
  readonly timeoutMs: DurationMs;
  readonly maxOutputBytes: number;
  readonly signal?: AbortSignal | undefined;
  /**
   * Optional bytes delivered to child stdin. They are never rendered, logged,
   * or copied into argv/environment. Callers must keep this bounded and scoped.
   */
  readonly stdinBytes?: Uint8Array | undefined;
};

/**
 * A non-interactive command request.
 *
 * `mode` is optional for backwards compatibility with the credential and
 * workspace adapters that predate Bash execution; an omitted mode means
 * direct argv execution.
 */
export type DirectCommandRequest = CommandRequestBase & {
  readonly mode?: "argv";
  readonly argv: readonly string[];
};

/** A deliberate shell request. The command is never assembled from argv. */
export type BashCommandRequest = CommandRequestBase & {
  readonly mode: "bash";
  readonly command: string;
};

export type CommandRequest = DirectCommandRequest | BashCommandRequest;

export type CommandOutcome =
  | {
      readonly kind: "exited";
      readonly exitCode: number;
      /** May hold a secret. Never logged, reported, or attached to an error. */
      readonly stdout: string;
    }
  /**
   * The command wrote more than its bound allowed and was stopped.
   *
   * Its own outcome rather than a truncated `exited`, because truncated output
   * is not shorter output — it is different output, and a caller that treated
   * the two the same would act on a fragment. The child is killed as soon as
   * the bound is reached rather than left to run out its deadline.
   */
  | { readonly kind: "output-exceeded"; readonly maxOutputBytes: number }
  | { readonly kind: "timed-out"; readonly timeoutMs: DurationMs }
  | { readonly kind: "cancelled" }
  /** The command could not be started: absent, not executable, refused. */
  | { readonly kind: "spawn-failed"; readonly code: string };

export type CommandRunnerPort = {
  run(request: CommandRequest): Promise<CommandOutcome>;
};

export function commandMode(request: CommandRequest): CommandMode {
  return request.mode === "bash" ? "bash" : "argv";
}

/**
 * Checks the path shape required by a host executable or working directory.
 *
 * This is lexical only. The host adapter owns existence and executable-bit
 * checks, while workspace tools own binding a directory to a workspace root.
 */
export function isAbsoluteCommandPath(value: string): boolean {
  return (
    value.length > 0 &&
    !value.includes("\0") &&
    (value.startsWith("/") || /^[A-Za-z]:[\\/]/.test(value) || value.startsWith("\\\\"))
  );
}

/**
 * A command runner that answers from a supplied function.
 *
 * Test-only. It records every request, so a test can assert the argument
 * vector, the environment, and the bounds a caller applied — which is how the
 * "structured argv, minimal environment, bounded output, deadline" rules are
 * proven rather than asserted in a comment.
 */
export type StubCommandRunner = CommandRunnerPort & {
  requests(): readonly CommandRequest[];
};

export function createStubCommandRunner(
  handler: (request: CommandRequest) => CommandOutcome | Promise<CommandOutcome>,
): StubCommandRunner {
  const recorded: CommandRequest[] = [];
  return {
    requests: (): readonly CommandRequest[] => [...recorded],
    async run(request: CommandRequest): Promise<CommandOutcome> {
      recorded.push(request);
      if (request.signal?.aborted === true) {
        return { kind: "cancelled" };
      }
      return await handler(request);
    },
  };
}
