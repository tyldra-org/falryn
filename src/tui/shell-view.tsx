/**
 * The placeholder tree.
 *
 * Deliberately the smallest thing that proves a renderer is alive: no theme, no
 * tokens, no layout classes, no overlays, no keymap, no transcript. Those are
 * #24, #25, and #26, and building any of them here would mean building them
 * before the lifecycle underneath was known to work — which is the ordering this
 * whole sequence of issues exists to avoid.
 *
 * It holds no state and runs no effect. Everything it draws is a function of the
 * view model it is handed, so a resize is a re-render with different numbers
 * rather than a component that has to be told what changed.
 */

import type { ScreenMode } from "@opentui/core";
import type { ReactNode } from "react";

/** What the shell can honestly say about itself today. */
export type ShellViewModel = {
  readonly version: string;
  readonly mode: ScreenMode;
  readonly columns: number;
  readonly rows: number;
};

/**
 * The only interaction this build promises.
 *
 * Interrupt is owned by `src/application/interruption.ts` and reaches the shell
 * through the invocation's cancellation scope, because the renderer was created
 * with `exitSignals: []`. Saying so on screen is the honest thing: there is
 * nothing else to press yet.
 */
export const SHELL_EXIT_HINT = "Press Ctrl+C to exit.";

export function ShellView(props: { readonly model: ShellViewModel }): ReactNode {
  const { model } = props;
  return (
    <box border>
      <text>{`Falryn ${model.version}`}</text>
      <text>{`${model.columns}×${model.rows} · ${model.mode}`}</text>
      <text>{SHELL_EXIT_HINT}</text>
    </box>
  );
}
