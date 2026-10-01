/**
 * Whether one resolved invocation may run now (#790).
 *
 * Every caller (slash text, palette, key, headless run, model) asks this before
 * dispatch, so a planned entry, an unsupported caller and an invocation that
 * must wait for a turn to settle are refused the same way everywhere.
 */

import type { CommandCaller, CommandSpec, CommandTiming } from "./command-spec.ts";

export type CommandRefusal =
  | {
      readonly code: "command-planned";
      readonly owner: string;
      readonly message: string;
    }
  | {
      readonly code: "caller-unsupported";
      readonly caller: CommandCaller;
      readonly message: string;
    }
  | {
      /** `safe-point` and `queued` work waits for #954; it never runs early (#790). */
      readonly code: "unavailable-while-turn-active";
      readonly timing: Exclude<CommandTiming, "immediate">;
      readonly message: string;
    };

export type CommandAdmission = { readonly ok: true } | ({ readonly ok: false } & CommandRefusal);

export function admitCommand(
  spec: CommandSpec,
  context: {
    readonly caller: CommandCaller;
    readonly timing: CommandTiming;
    /** A turn is running or a submission is in flight. */
    readonly turnActive: boolean;
  },
): CommandAdmission {
  const name = spec.slash[0]?.form ?? spec.title;
  if (spec.status.kind === "planned") {
    return {
      ok: false,
      code: "command-planned",
      owner: spec.status.owner,
      message: `${name} is not available yet: ${spec.status.reason} (${spec.status.owner}).`,
    };
  }
  if (!spec.callers.includes(context.caller)) {
    return {
      ok: false,
      code: "caller-unsupported",
      caller: context.caller,
      message:
        context.caller === "headless"
          ? `${name} needs the interactive shell; run falryn without a subcommand to use it.`
          : `${name} cannot be invoked by the ${context.caller} caller.`,
    };
  }
  if (context.turnActive && context.timing !== "immediate") {
    return {
      ok: false,
      code: "unavailable-while-turn-active",
      timing: context.timing,
      message:
        context.timing === "safe-point"
          ? `${name} changes state the running turn uses; run it again after the turn finishes.`
          : `${name} starts work; run it again after the turn finishes.`,
    };
  }
  return { ok: true };
}
