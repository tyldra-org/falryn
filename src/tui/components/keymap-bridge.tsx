/**
 * Where the plan meets the renderer.
 *
 * One component, and it draws nothing. It registers a layer per active context
 * with `@opentui/keymap`, which owns key normalization, sequence resolution, and
 * dispatch — none of which this repository should reimplement. What Falryn keeps
 * is *which* bindings exist and *what* they run, and both of those arrive here
 * already decided as a validated plan.
 *
 * The layers are rebuilt when the active contexts change rather than registered
 * once and filtered at dispatch time. That is what makes "more specific wins
 * only when its scope is active" true of the keymap itself: a binding in an
 * inactive context is not registered, so it cannot shadow a broader one, and
 * `escape` reaches `app.cancel` the moment an overlay closes without anything
 * having to reorder.
 */

import { useBindings } from "@opentui/keymap/react";
import type { ReactNode } from "react";
import { CONTEXT_PRIORITY, type CommandContext, SHELL_COMMANDS } from "../commands.ts";
import { bindingsForContext, bindingsWhileTyping, type KeymapPlan } from "../keymap.ts";

export type KeymapBridgeProps = {
  readonly plan: KeymapPlan;
  /** The contexts whose surfaces exist right now. */
  readonly contexts: readonly CommandContext[];
  /** Runs a command by stable id. The bridge never decides what a command does. */
  readonly run: (id: string) => boolean;
  /**
   * Whether a text control currently has focus.
   *
   * Withholds bare single-character bindings from every layer while it is true,
   * so a focused composer can receive the characters those keys are made of. See
   * `bindingsWhileTyping` for why this is a rule rather than a workaround.
   */
  readonly typing?: boolean;
};

export function KeymapBridge(props: KeymapBridgeProps): ReactNode {
  const typing = props.typing === true;
  const active = new Set(props.contexts);

  useContextBindings("global", props.plan, active, typing);
  useContextBindings("scrollable", props.plan, active, typing);
  useContextBindings("transcript", props.plan, active, typing);
  useContextBindings("composer", props.plan, active, typing);
  useContextBindings("overlay", props.plan, active, typing);
  useContextBindings("confirmation", props.plan, active, typing);

  useBindings(
    () => ({
      priority: 0,
      commands: SHELL_COMMANDS.map((command) => ({
        name: command.id,
        desc: command.description,
        run: () => {
          props.run(command.id);
        },
      })),
    }),
    [props.run],
  );

  return null;
}

function useContextBindings(
  context: CommandContext,
  plan: KeymapPlan,
  active: ReadonlySet<CommandContext>,
  typing: boolean,
): void {
  const enabled = active.has(context);
  useBindings(() => {
    const declared = bindingsForContext(plan, context);
    const live = typing ? bindingsWhileTyping(declared) : declared;
    return {
      priority: CONTEXT_PRIORITY[context],
      bindings: enabled
        ? live.map((binding) => ({
            key: binding.key,
            cmd: binding.command,
            ...(isTextareaOwned(binding.command) ? { preventDefault: false } : {}),
          }))
        : [],
      commands:
        enabled && context === "composer"
          ? [
              { name: "composer.submit", run: () => false },
              { name: "composer.newline", run: () => false },
            ]
          : [],
    };
  }, [plan, context, enabled, typing]);
}

function isTextareaOwned(command: string): boolean {
  return command === "composer.submit" || command === "composer.newline";
}
