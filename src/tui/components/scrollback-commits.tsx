/**
 * `ScrollbackCommits` — the seam that drives the scrollback adapter.
 *
 * It draws nothing. Its whole job is to notice that the projection changed and
 * hand the finalized part of it to `../scrollback.ts`, which is the one module
 * allowed to write above the footer. A component rather than a call inside the
 * shell's wiring because the projection arrives through the tree, and because
 * the adapter has to be created and destroyed with the renderer that owns it.
 *
 * ## What gets committed, and why it is not what the reader sees
 *
 * Three of the surface's rendering inputs are deliberately fixed here, and each
 * is fixed because scrollback is durable and the live region is not.
 *
 * **Expanded, always.** What a reader has opened is a property of a reading
 * session. If it decided what was written, the permanent record of a session
 * would be whichever blocks somebody happened to have open at the time — and a
 * collapsed entry in scrollback is a headline with the content thrown away.
 * A secret block is still refused its content by `rowsForBlock`; expansion does
 * not reach past that.
 *
 * **Never selected.** A selection marker is an answer to "where is the cursor",
 * which is a question the terminal's scroll history cannot have.
 *
 * **No relative time.** `relativeTo: null`, so no entry carries an age. "2m ago"
 * is true for one minute and then is a permanent lie, and nothing repaints a
 * committed row to correct it. The block's own timestamp is what the projection
 * carries and what any later reading can be measured against.
 */

import { useRenderer } from "@opentui/react";
import { type ReactNode, useEffect, useRef } from "react";
import type { TranscriptBlock } from "../../presentation/index.ts";
import { scrollbackAdapterFor } from "../scrollback.ts";
import { describeRouteWith } from "../transcript/index.ts";
import { drawableLines } from "../transcript/lines.ts";
import { rowsForBlock } from "../transcript/rows.ts";
import type { TranscriptModel } from "../transcript-model.ts";
import { useFrame } from "./context.tsx";

export type ScrollbackCommitsProps = {
  readonly model: TranscriptModel;
};

export function ScrollbackCommits(props: ScrollbackCommitsProps): ReactNode {
  const renderer = useRenderer();
  const frame = useFrame();

  // Resolved from the renderer rather than created here. OpenTUI's React root
  // remounts the tree on every `render()` call, so an adapter this component
  // owned would forget what it had already committed and write the whole
  // session into scrollback again beneath itself. It is not destroyed on unmount
  // for the same reason: the adapter belongs to the renderer, and the renderer
  // outlives any one mount of the tree.
  const adapter = scrollbackAdapterFor(renderer);

  // Read through a ref rather than listed as effect dependencies. The theme, the
  // wrap cache, and the command rows all change for reasons that are not new
  // transcript entries — a resize, a rebind — and an effect that re-ran on them
  // would ask the adapter to commit again on every one of them. The adapter
  // would refuse the duplicates, which is exactly why depending on it would be
  // leaning on a guard instead of not creating the work.
  const inputs = useRef({ frame, model: props.model });
  inputs.current = { frame, model: props.model };

  const blocks = props.model.projection.blocks;

  useEffect(() => {
    // Not awaited and nothing to cancel. A commit is fire-and-forget by
    // construction: the adapter serializes and deduplicates on its own, and a
    // component that tore a commit down on unmount would abandon an entry
    // halfway to a region that cannot be repaired afterwards. A refused commit
    // is recorded in the report the adapter returns rather than thrown.
    void adapter.commit({
      blocks,
      render: (block, columns) => lines(block, columns, inputs.current),
    });
  }, [adapter, blocks]);

  return null;
}

/** One block, as the lines scrollback should keep of it. */
function lines(
  block: TranscriptBlock,
  columns: number,
  inputs: { frame: ReturnType<typeof useFrame>; model: TranscriptModel },
) {
  const { frame, model } = inputs;
  return drawableLines(
    rowsForBlock({
      block,
      expanded: true,
      selected: false,
      columns,
      symbols: frame.theme.symbols,
      wrap: frame.cache.wrap,
      describeRoute: (route) => describeRouteWith(model.commands, route),
      relativeTo: null,
    }),
    frame.theme,
    columns,
  );
}
