/**
 * `TranscriptView` — the transcript, on a terminal.
 *
 * Everything this component *decides* was decided somewhere else: rows come
 * from `../transcript/rows.ts`, the window from `../transcript/window.ts`, and
 * what the reader has done from `../transcript/surface.ts`. What is left here is
 * measurement and mounting, which is the part that genuinely needs a renderer.
 *
 * ## Why not `ScrollBox`
 *
 * OpenTUI ships a scrollbox with viewport culling, and it is the right component
 * for a bounded list whose items are already renderables. It is the wrong one
 * here, and the reason is the acceptance criterion: culling skips *render calls*
 * for offscreen children, so every block in the history would still be a mounted
 * renderable with a laid-out box. A hundred thousand of those is a hundred
 * thousand renderables, and "a large history renders in a bounded window" would
 * be false in exactly the case it was written for. This mounts the window and
 * nothing else, so the number of renderables is a function of the terminal's
 * height rather than of the session's length.
 *
 * ## Why measurement is cheap
 *
 * A collapsed block's height does not depend on the width — see
 * `collapsedRows`. So placing the window over a very long history is a sum over
 * numbers rather than a wrap of every block's text, and only the blocks the
 * reader has opened are measured by wrapping. Those go through the frame's
 * bounded text cache, which is what makes a resize a re-slice rather than a
 * re-measure of the whole session.
 */

import { type ReactNode, useEffect } from "react";
import { blockKey } from "../../presentation/index.ts";
import { primaryColumns, primaryRows } from "../layout.ts";
import {
  type BlockSpan,
  collapsedRows,
  describeRouteWith,
  rowsForBlock,
  type TranscriptAnchor,
  type TranscriptRow,
  type TranscriptWindow,
  windowFor,
} from "../transcript/index.ts";
import type { TranscriptGeometry, TranscriptModel } from "../transcript-model.ts";
import { useFrame, useLayoutClass } from "./context.tsx";
import { Line, StatusMark } from "./primitives.tsx";

export type TranscriptViewProps = {
  readonly model: TranscriptModel;
  /**
   * Reports what was measured, so commands can act on it.
   *
   * Scrolling needs block heights and a row budget, and both are known only
   * after a layout. The alternative — the runtime measuring the transcript
   * itself — would be a second measurement that disagrees with the drawn one
   * for a frame after every resize.
   */
  readonly onGeometry?: (geometry: TranscriptGeometry) => void;
};

export function TranscriptView(props: TranscriptViewProps): ReactNode {
  const frame = useFrame();
  const layoutClass = useLayoutClass();
  const { blocks } = props.model.projection;

  const columns = primaryColumns(frame.viewport, layoutClass);
  const region = primaryRows(frame.viewport);
  const measured = measure(props.model, columns, frame.cache.wrap, frame.theme.symbols);
  const view = place(measured.spans, region, props.model.surface.anchor);

  // Reported after the render that produced it, so a command always acts on the
  // geometry the reader is looking at rather than on the previous frame's.
  const report = props.onGeometry;
  const spans = measured.spans;
  const contentRows = view.contentRows;
  useEffect(() => {
    report?.({ spans, rows: contentRows });
  }, [report, spans, contentRows]);

  if (blocks.length === 0) {
    return <EmptyTranscript model={props.model} />;
  }

  const rows = visibleRows(props.model, measured, view.window, columns, frame);

  return (
    <box flexDirection="column" flexGrow={1}>
      {rows.map((row) => (
        <Row key={row.key} row={row} maxColumns={columns} />
      ))}
      <UnseenNotice model={props.model} window={view.window} maxColumns={columns} />
    </box>
  );
}

/** One row, drawn by the primitive its kind requires. */
function Row(props: { readonly row: TranscriptRow; readonly maxColumns: number }): ReactNode {
  const room = Math.max(1, props.maxColumns - props.row.indent);
  return (
    <box paddingLeft={props.row.indent}>
      {props.row.kind === "status" ? (
        <StatusMark status={props.row.status} label={props.row.label} maxColumns={room} />
      ) : (
        <Line
          color={props.row.color}
          typography={props.row.typography}
          maxColumns={room}
          untrusted={props.row.untrusted}
        >
          {props.row.text}
        </Line>
      )}
    </box>
  );
}

/**
 * What an empty transcript says.
 *
 * A real command, resolved from the registry rows the shell already built, so
 * the sentence cannot name a key that does nothing. Filler — "nothing is
 * running yet" — is what this replaces: it occupies the region a reader is
 * looking at and tells them nothing they can act on.
 */
function EmptyTranscript(props: { readonly model: TranscriptModel }): ReactNode {
  const row = props.model.commands.find((entry) => entry.id === props.model.emptyStateCommand);
  const invitation =
    row === undefined
      ? "Nothing has happened in this session yet."
      : row.binding === null
        ? `Nothing has happened in this session yet. Run ${row.title} to see what this build can do.`
        : `Nothing has happened in this session yet. Press ${row.binding} for ${row.title.toLowerCase()}.`;

  return (
    <box flexDirection="column" flexGrow={1}>
      <Line color="mutedForeground" typography="muted">
        {invitation}
      </Line>
    </box>
  );
}

/**
 * Unseen activity, and the way back to it.
 *
 * Drawn only when the reader has scrolled away, which is the whole contract: a
 * transcript that jumped to the newest block would move the text someone was
 * reading, and one that said nothing would hide that anything arrived.
 */
function UnseenNotice(props: {
  readonly model: TranscriptModel;
  readonly window: TranscriptWindow;
  readonly maxColumns: number;
}): ReactNode {
  if (props.window.atLatest) {
    return null;
  }
  const row = props.model.commands.find((entry) => entry.id === "transcript.jumpToLatest");
  const key = row?.binding ?? null;
  const count = props.window.unseenBlocks;
  const entries = count === 1 ? "1 later entry" : `${count} later entries`;
  return (
    <StatusMark
      status="informational"
      label={`${entries} below${key === null ? "" : `; press ${key} to follow the latest`}`}
      maxColumns={props.maxColumns}
    />
  );
}

type Measured = {
  readonly spans: readonly BlockSpan[];
  /** Rows per block, for the blocks that were materialized. Keyed by block key. */
  readonly rowsFor: (key: string) => readonly TranscriptRow[];
};

/**
 * Heights for every block, and rows for the ones that need them.
 *
 * Collapsed blocks are counted rather than built, which is what keeps this a sum
 * over a large history instead of a wrap of it. Expanded blocks are built here
 * because their height is only knowable from their wrapped content, and the
 * result is kept so the window does not build them a second time.
 */
function measure(
  model: TranscriptModel,
  columns: number,
  wrap: (text: string, width: number) => readonly string[],
  symbols: Parameters<typeof rowsForBlock>[0]["symbols"],
): Measured {
  const built = new Map<string, readonly TranscriptRow[]>();
  const spans: BlockSpan[] = [];
  const newest = model.projection.blocks.at(-1)?.occurredAt ?? null;

  for (const block of model.projection.blocks) {
    const key = blockKey(block.anchor);
    if (!model.surface.expanded.has(key)) {
      spans.push({ key, rows: collapsedRows(block) });
      continue;
    }
    const rows = rowsForBlock({
      block,
      expanded: true,
      selected: model.surface.selected === key,
      columns,
      symbols,
      wrap,
      describeRoute: (route) => describeRouteWith(model.commands, route),
      relativeTo: newest,
    });
    built.set(key, rows);
    spans.push({ key, rows: rows.length });
  }

  return { spans, rowsFor: (key) => built.get(key) ?? [] };
}

/**
 * The window, and the rows left for content once the notice has taken its own.
 *
 * Resolved twice on purpose. Whether a reader has scrolled away decides whether
 * the unseen notice is drawn, and drawing it takes a row from the window — so
 * the first pass answers the question and the second places the window in the
 * room that is actually left. Guessing once and drawing over the last row is how
 * a transcript covers its own newest line.
 */
function place(
  spans: readonly BlockSpan[],
  region: number,
  anchor: TranscriptAnchor,
): { readonly window: TranscriptWindow; readonly contentRows: number } {
  const provisional = windowFor({ spans, rows: region, anchor });
  if (provisional.atLatest) {
    return { window: provisional, contentRows: region };
  }
  const contentRows = Math.max(0, region - 1);
  return { window: windowFor({ spans, rows: contentRows, anchor }), contentRows };
}

/** The rows the window actually shows, sliced from the mounted range. */
function visibleRows(
  model: TranscriptModel,
  measured: Measured,
  view: TranscriptWindow,
  columns: number,
  frame: ReturnType<typeof useFrame>,
): readonly TranscriptRow[] {
  const newest = model.projection.blocks.at(-1)?.occurredAt ?? null;
  const mounted: TranscriptRow[] = [];

  for (const block of model.projection.blocks.slice(view.firstIndex, view.lastIndex)) {
    const key = blockKey(block.anchor);
    const already = measured.rowsFor(key);
    if (already.length > 0) {
      mounted.push(...already);
      continue;
    }
    mounted.push(
      ...rowsForBlock({
        block,
        expanded: false,
        selected: model.surface.selected === key,
        columns,
        symbols: frame.theme.symbols,
        wrap: frame.cache.wrap,
        describeRoute: (route) => describeRouteWith(model.commands, route),
        relativeTo: newest,
      }),
    );
  }

  return mounted.slice(view.skippedRows, view.skippedRows + view.visibleRows);
}
