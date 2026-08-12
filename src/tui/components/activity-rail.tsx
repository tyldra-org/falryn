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
 *
 * The empty state and the overflow notice are mutually exclusive with a
 * dishonest pairing: saying "nothing is running" above "N more entries not
 * shown" is the palette's old "Nothing matches" / "24 more" failure, and it is
 * what let a short rail overdraw its neighbours on a real terminal (#385).
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

  // Content rows after the heading. The notice takes a row only when at least
  // one entry can sit beside it — reserving a notice row into a budget that
  // already had nowhere for entries is how the empty state and the count used
  // to land together and spill past the region.
  const room = Math.max(0, props.rows - HEADING_ROWS);
  const hasEntries = all.length > 0;
  const needsNotice = all.length > room || projection.droppedSettled > 0;
  const entryBudget = hasEntries && needsNotice && room >= 2 ? room - 1 : room;
  const shown = all.slice(0, Math.max(0, entryBudget));
  const hidden = all.length - shown.length + projection.droppedSettled;
  const showNotice = hidden > 0 && shown.length > 0 && shown.length < room;
  const showEmpty = !hasEntries && room >= 1;

  return (
    <box flexDirection="column" width={columns} height={Math.max(0, props.rows)} overflow="hidden">
      <Line color="mutedForeground" typography="label" maxColumns={columns}>
        {`Activity ${frame.theme.symbols.separator} ${live.length} running`}
      </Line>
      {showEmpty ? (
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
      {showNotice ? (
        <Line color="mutedForeground" typography="muted" maxColumns={columns}>
          {/* Never silent: a truncated list presented as a complete one is the
              one thing a rail must not do. Never alone: a count with no entry
              beside it is how #385 drew the notice into a neighbour's row. */}
          {`${hidden} more ${hidden === 1 ? "entry" : "entries"} not shown`}
        </Line>
      ) : null}
    </box>
  );
}
