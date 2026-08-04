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

import { useKeymap } from "@opentui/keymap/react";
import { type ReactNode, useEffect } from "react";
import type { CommandContext } from "../commands.ts";
import { CONTEXT_PRIORITY } from "../commands.ts";
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
  const keymap = useKeymap();
  // Joined rather than passed as an array: the effect must re-run when the *set*
  // changes, and an array literal is a new reference on every render.
  const active = [...props.contexts].sort().join(" ");
  const typing = props.typing === true;

  useEffect(() => {
    const contexts = active === "" ? [] : (active.split(" ") as CommandContext[]);
    const release = contexts.map((context) => {
      const declared = bindingsForContext(props.plan, context);
      const live = typing ? bindingsWhileTyping(declared) : declared;
      return keymap.registerLayer({
        priority: CONTEXT_PRIORITY[context],
        bindings: live.map((binding) => ({
          key: binding.key,
          cmd: binding.command,
        })),
      });
    });
    return () => {
      // Every layer, on every change. A layer left registered for a context that
      // is no longer active is precisely the shadowing this design avoids.
      for (const dispose of release) {
        dispose();
      }
    };
  }, [keymap, props.plan, active, typing]);

  useEffect(() => {
    // Commands are registered as one layer of handlers that delegate by id, so
    // the keymap holds names and this module holds no behavior at all.
    return keymap.registerLayer({
      priority: 0,
      commands: [...new Set(props.plan.bindings.map((binding) => binding.command))].map((id) => ({
        name: id,
        run: () => {
          props.run(id);
        },
      })),
    });
  }, [keymap, props.plan, props.run]);

  return null;
}
