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

export type CommandRequest = {
  /** An absolute path. Never resolved through `PATH`. */
  readonly executable: string;
  readonly argv: readonly string[];
  /** The complete child environment. Inheriting the parent's is not an option. */
  readonly environment: Readonly<Record<string, string>>;
  readonly timeoutMs: DurationMs;
  readonly maxOutputBytes: number;
  readonly signal?: AbortSignal | undefined;
};

export type CommandOutcome =
  | {
      readonly kind: "exited";
      readonly exitCode: number;
      /** May hold a secret. Never logged, reported, or attached to an error. */
      readonly stdout: string;
      readonly outputTruncated: boolean;
    }
  | { readonly kind: "timed-out"; readonly timeoutMs: DurationMs }
  | { readonly kind: "cancelled" }
  /** The command could not be started: absent, not executable, refused. */
  | { readonly kind: "spawn-failed"; readonly code: string };

export type CommandRunnerPort = {
  run(request: CommandRequest): Promise<CommandOutcome>;
};

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
