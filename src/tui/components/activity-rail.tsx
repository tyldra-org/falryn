/**
 * `ActivityRail` — what the runtime is doing, beside the transcript.
 *
 * The contextual surface a `wide` layout gets, and the only one it gets. The
 * design direction allows one persistent contextual panel and refuses a
 * permanently tiled control centre, so this is the whole of it: live work first,
 * recently settled work under it, and a truthful count of what is not shown.
 *
 * Everything it decides was decided elsewhere — the entries and their ordering
 * in `../../presentation/activity/`, the status tokens in `../activity/rows.ts`.
 * What is left here is mounting, which is the part that needs a renderer.
 *
 * ## Bounded by construction
 *
 * The rail draws at most the rows its region has, and the projection has already
 * bounded how many settled entries it keeps. Live work is never dropped to make
 * room for finished work: an interface that hid a running operation to show a
 * completed one would hide the thing the rail exists to show.
 */

import type { ReactNode } from "react";
import type { ActivityProjection } from "../../presentation/index.ts";
import { liveEntries, settledEntries } from "../../presentation/index.ts";
import { activityRows } from "../activity/index.ts";
import { PANEL_COLUMNS } from "../layout.ts";
import { useFrame } from "./context.tsx";
import { Line, StatusMark } from "./primitives.tsx";

export type ActivityRailProps = {
  readonly projection: ActivityProjection;
  /** Rows the rail may occupy. The caller measured them; this does not. */
  readonly rows: number;
};

/** The heading row, which the rail always draws so the region is nameable. */
const HEADING_ROWS = 1;

export function ActivityRail(props: ActivityRailProps): ReactNode {
  const frame = useFrame();
  const columns = PANEL_COLUMNS;
  const { projection } = props;

  const live = activityRows(liveEntries(projection));
  // Newest last in the projection, so the tail is the recent history a reader
  // wants. Reversed here so the newest settled entry sits closest to the live
  // work it followed.
  const settled = activityRows([...settledEntries(projection)].reverse());
  const all = [...live, ...settled];

  // The notice takes a row only when there is something to say, and the budget
  // is computed against that rather than reserved unconditionally — a rail that
  // held a row back for a message it never shows wastes the one region a wide
  // layout gets.
  const room = Math.max(0, props.rows - HEADING_ROWS);
  const overflowing = all.length > room || projection.droppedSettled > 0;
  const shown = all.slice(0, overflowing ? Math.max(0, room - 1) : room);
  const hidden = all.length - shown.length + projection.droppedSettled;

  return (
    <box flexDirection="column" width={columns}>
      <Line color="mutedForeground" typography="label" maxColumns={columns}>
        {`Activity ${frame.theme.symbols.separator} ${live.length} running`}
      </Line>
      {shown.length === 0 ? (
        <Line color="mutedForeground" typography="muted" maxColumns={columns}>
          {/*
           * A statement about the runtime, not filler. Nothing produces work in
           * this build, so "nothing is running" is the true and complete answer
           * — and it is different from a rail that could not read the runtime,
           * which the status line reports as unknown.
           */}
          Nothing is running.
        </Line>
      ) : (
        shown.map((row) => (
          <StatusMark key={row.key} status={row.status} label={row.label} maxColumns={columns} />
        ))
      )}
      {hidden > 0 ? (
        <Line color="mutedForeground" typography="muted" maxColumns={columns}>
          {/* Never silent: a truncated list presented as a complete one is the
              one thing a rail must not do. */}
          {`${hidden} more ${hidden === 1 ? "entry" : "entries"} not shown`}
        </Line>
      ) : null}
    </box>
  );
}
