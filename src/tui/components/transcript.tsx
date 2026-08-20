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
 * `collapsedRows`. Heights live in a prefix-sum index, so placing the window is
 * a binary search rather than a walk, and `reconcileHeights` rematerializes only
 * a changed suffix. Off-window collapsed blocks are counted, not built into
 * rows. Expanded wrapping still goes through the frame's bounded text cache.
 */

import { type ReactNode, useEffect, useRef } from "react";
import { blockKey, boundedTextsOf, type TranscriptBlock } from "../../presentation/index.ts";
import { primaryColumns, primaryRows } from "../layout.ts";
import {
  type BlockDescriptor,
  collapsedRows,
  describeRouteWith,
  EMPTY_HEIGHT_BATCH,
  EXPANSION_INDENT,
  type HeightBatch,
  reconcileHeights,
  rowsForBlock,
  spanIndexOf,
  type TranscriptAnchor,
  type TranscriptRow,
  type TranscriptWindow,
  windowOn,
} from "../transcript/index.ts";
import { contentLineCount, entriesForVisibleRows } from "../transcript/render-rows.ts";
import type { TranscriptGeometry, TranscriptModel } from "../transcript-model.ts";
import { useFrame, useLayoutClass } from "./context.tsx";
import { Line, StatusMark } from "./primitives.tsx";
import { TranscriptBodyField } from "./transcript-body.tsx";

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
  const region = primaryRows(frame.viewport, frame.composerRows);
  const measured = useMeasured(props.model, columns, frame);
  const view = place(measured.index, region, props.model.surface.anchor);

  // Reported after the render that produced it, so a command always acts on the
  // geometry the reader is looking at rather than on the previous frame's.
  const report = props.onGeometry;
  const spans = measured.index.spans;
  const contentRows = view.contentRows;
  useEffect(() => {
    report?.({ spans, rows: contentRows });
  }, [report, spans, contentRows]);

  if (blocks.length === 0) {
    return <EmptyTranscript model={props.model} />;
  }

  const rows = visibleRows(props.model, measured, view.window, columns, frame);
  const built = builtRowsFor(props.model, measured, blocks);
  const selectable =
    props.model.selectableBody === null || built === null
      ? null
      : {
          ...props.model.selectableBody,
          contentLines: contentLineCount(built, props.model.selectableBody.key),
        };
  const entries = entriesForVisibleRows(rows, selectable, props.model.focused);
  const onBodyRenderable = props.model.onBodyRenderable;

  return (
    <box flexDirection="column" flexGrow={1}>
      {entries.map((entry) =>
        entry.kind === "body" ? (
          <box key={entry.key} paddingLeft={EXPANSION_INDENT * 2}>
            <TranscriptBodyField
              text={entry.text}
              height={entry.height}
              width={Math.max(1, columns - EXPANSION_INDENT * 2)}
              focused={entry.focused}
              {...(onBodyRenderable === undefined ? {} : { onRenderable: onBodyRenderable })}
            />
          </box>
        ) : (
          <Row key={entry.row.key} row={entry.row} maxColumns={columns} />
        ),
      )}
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
  readonly index: ReturnType<typeof spanIndexOf>;
  readonly batch: HeightBatch;
};

function useMeasured(
  model: TranscriptModel,
  columns: number,
  frame: ReturnType<typeof useFrame>,
): Measured {
  const batchRef = useRef<HeightBatch>(EMPTY_HEIGHT_BATCH);
  const indexRef = useRef(spanIndexOf([]));
  const descriptors = descriptorsOf(model, columns);
  const batch = reconcileHeights(batchRef.current, descriptors, (index) =>
    materializeBlock(model, columns, frame, index),
  );
  batchRef.current = batch;
  if (batch.kind !== "reuse") {
    indexRef.current = spanIndexOf(
      batch.records.map((record) => ({ key: record.key, rows: record.rows })),
    );
  }
  return { index: indexRef.current, batch };
}

function descriptorsOf(model: TranscriptModel, columns: number): readonly BlockDescriptor[] {
  return model.projection.blocks.map((block) => {
    const key = blockKey(block.anchor);
    if (!model.surface.expanded.has(key)) {
      return { key, stamp: `c:${collapsedRows(block)}` };
    }
    const fingerprint = boundedTextsOf(block)
      .map((text) => `${text.disclosure.kind}:${text.text}`)
      .join("\n");
    const selected = model.surface.selected === key ? "s" : "n";
    return { key, stamp: `x:${columns}:${selected}:${fingerprint}` };
  });
}

function materializeBlock(
  model: TranscriptModel,
  columns: number,
  frame: ReturnType<typeof useFrame>,
  index: number,
): { readonly rows: number; readonly built: readonly TranscriptRow[] | null } {
  const block = model.projection.blocks[index];
  if (block === undefined) {
    return { rows: 0, built: null };
  }
  const key = blockKey(block.anchor);
  if (!model.surface.expanded.has(key)) {
    return { rows: collapsedRows(block), built: null };
  }
  const newest = model.projection.blocks.at(-1)?.occurredAt ?? null;
  const rows = rowsForBlock({
    block,
    expanded: true,
    selected: model.surface.selected === key,
    columns,
    symbols: frame.theme.symbols,
    wrap: frame.cache.wrap,
    describeRoute: (route) => describeRouteWith(model.commands, route),
    relativeTo: newest,
  });
  return { rows: rows.length, built: rows };
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
  index: ReturnType<typeof spanIndexOf>,
  region: number,
  anchor: TranscriptAnchor,
): { readonly window: TranscriptWindow; readonly contentRows: number } {
  const provisional = windowOn(index, region, anchor);
  if (provisional.atLatest) {
    return { window: provisional, contentRows: region };
  }
  const contentRows = Math.max(0, region - 1);
  return { window: windowOn(index, contentRows, anchor), contentRows };
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
  const records = measured.batch.records;

  for (let index = view.firstIndex; index < view.lastIndex; index += 1) {
    const block = model.projection.blocks[index];
    const record = records[index];
    if (block === undefined) {
      continue;
    }
    if (record?.built !== undefined && record.built !== null && record.built.length > 0) {
      mounted.push(...record.built);
      continue;
    }
    const key = blockKey(block.anchor);
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

function builtRowsFor(
  model: TranscriptModel,
  measured: Measured,
  blocks: readonly TranscriptBlock[],
): readonly TranscriptRow[] | null {
  const selected = model.selectableBody?.key;
  if (selected === undefined) {
    return null;
  }
  const index = blocks.findIndex((block) => blockKey(block.anchor) === selected);
  if (index < 0) {
    return null;
  }
  return measured.batch.records[index]?.built ?? null;
}
