/**
 * Keyboard navigation that OpenTUI's Select exposes imperatively.
 *
 * The focused input in the command palette owns Return, so callers can retain
 * that behaviour while every list still shares the same arrow-key handling.
 */

import { useKeyboard } from "@opentui/react";
import type { RefObject } from "react";

type SelectNavigationTarget = {
  moveUp(): void;
  moveDown(): void;
  selectCurrent(): void;
};

export type SelectNavigationOptions = {
  /** Whether this surface may claim list-navigation keys. Defaults to true. */
  readonly enabled?: boolean;
  /** Whether Return selects the current option. Defaults to true. */
  readonly selectOnReturn?: boolean;
};

/**
 * Let arrow keys navigate an OpenTUI Select and optionally select on Return.
 *
 * This stays a component-level `useKeyboard` subscription rather than a shell
 * command: moving a list cursor is local renderable behaviour, not a global
 * application action.
 */
export function useSelectNavigation(
  ref: RefObject<SelectNavigationTarget | null>,
  optionCount: number,
  options: SelectNavigationOptions = {},
): void {
  const enabled = options.enabled ?? true;
  const selectOnReturn = options.selectOnReturn ?? true;

  useKeyboard((key) => {
    const list = ref.current;
    if (!enabled || list === null || optionCount === 0) {
      return;
    }

    switch (key.name) {
      case "up":
        key.preventDefault();
        list.moveUp();
        return;
      case "down":
        key.preventDefault();
        list.moveDown();
        return;
      case "return":
        if (selectOnReturn) {
          key.preventDefault();
          list.selectCurrent();
        }
        return;
      default:
        return;
    }
  });
}
