/**
 * `StatusLine` — health on the left, what you can press on the right.
 *
 * One row, and the last one an overlay may never cover. The reason it is
 * protected is the whole reason it exists: it is where a terminal outcome
 * arrives, and an interface that could hide an outcome behind a panel would be
 * able to tell a user their run succeeded by omission.
 *
 * Key hints carry the command name, not only the key. The key is what someone
 * presses; the command is what it does and the thing that stays true when #26
 * lets them rebind it.
 */

import type { ReactNode } from "react";
import { displayWidth } from "../../domain/index.ts";
import type { KeyHint, StatusLineModel } from "../view-model.ts";
import { useFrame, useLayoutClass } from "./context.tsx";
import { Line, StatusMark } from "./primitives.tsx";

export type StatusLineProps = {
  readonly model: StatusLineModel;
};

export function StatusLine(props: StatusLineProps): ReactNode {
  const { theme, terminal } = useFrame();
  const layoutClass = useLayoutClass();

  const hints = hintText(props.model.hints, layoutClass === "compact", theme.marks.separator);
  const hintWidth = displayWidth(hints);
  // The status keeps whatever the hints do not need, and never less than a
  // usable amount. Hints are the half that can be shortened: they are a
  // reminder, and the status is the answer.
  const statusRoom = Math.max(8, terminal.columns - hintWidth - 2);

  return (
    <box flexDirection="row" justifyContent="space-between">
      <box flexDirection="row" gap={theme.spacing("tight")}>
        <StatusMark status={props.model.status} maxColumns={statusRoom} />
        {props.model.message === "" ? null : (
          <Line color="mutedForeground" typography="muted" maxColumns={statusRoom}>
            {props.model.message}
          </Line>
        )}
      </box>
      {hints === "" ? null : (
        <Line color="mutedForeground" typography="muted" maxColumns={Math.max(1, hintWidth)}>
          {hints}
        </Line>
      )}
    </box>
  );
}

/**
 * The hints as one string.
 *
 * Compact shows the keys alone. That is not a truncation of the full form — it
 * is the form that fits, and dropping the command word is the right thing to
 * drop, because someone on a 40-column terminal reading `^C` already knows what
 * it does or is about to find out.
 */
function hintText(hints: readonly KeyHint[], compact: boolean, separator: string): string {
  if (hints.length === 0) {
    return "";
  }
  return hints
    .map((hint) => (compact ? hint.keys : `${hint.keys} ${hint.command}`))
    .join(` ${separator} `);
}
