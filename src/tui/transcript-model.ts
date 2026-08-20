/**
 * What the transcript surface is given.
 *
 * A view model in the sense `./view-model.ts` means it: plain data, no
 * renderer, no OpenTUI type, no port. The component that draws it can be handed
 * one in a test and asserted on, and the shell builds one from the projection
 * and the registry rather than from anything it drew.
 *
 * The projection is carried whole rather than flattened into rows. Flattening
 * here would put a second copy of the block model in the interface, and the copy
 * is what goes stale — a block revised by a stream would keep rendering from a
 * shape somebody derived one frame earlier. The surface's own state is beside it
 * rather than inside it, because what a reader has opened is not a fact about
 * the transcript.
 */

import type { TranscriptProjection } from "../presentation/index.ts";
import type { BlockSpan, TranscriptSurfaceState } from "./transcript/index.ts";
import type { CommandEntry } from "./view-model.ts";

export type TranscriptModel = {
  readonly projection: TranscriptProjection;
  readonly surface: TranscriptSurfaceState;
  /**
   * Every command as a row, resolved through the live keymap.
   *
   * Carried so the surface can name a key without knowing a keymap exists. It is
   * also what makes the empty state and every expansion route honest: a
   * sentence offering an action is built from a registry entry, so it cannot
   * name a command that is not there or a key that currently does something
   * else.
   */
  readonly commands: readonly CommandEntry[];
  /**
   * The command an empty transcript points at.
   *
   * An id rather than a sentence, resolved against `commands` at render time.
   * A hard-coded sentence would keep promising a key after the binding moved.
   */
  readonly emptyStateCommand: string;
  /** Whether the transcript region holds focus. */
  readonly focused: boolean;
  /**
   * When set, the selected expanded block's disclosed body may collapse into one
   * OpenTUI textarea for native range picks (#622).
   */
  readonly selectableBody: {
    readonly key: string;
    readonly text: string;
  } | null;
  /** Registers the active body textarea for include/copy commands. */
  readonly onBodyRenderable?: (
    renderable: import("@opentui/core").TextareaRenderable | null,
  ) => void;
};

/**
 * What the surface measured, reported back to whatever dispatches commands.
 *
 * Scrolling is arithmetic over block heights and a row budget, and neither is
 * known until a layout has happened. Reporting the measurement is what lets the
 * one dispatcher act on the same numbers the reader is looking at, instead of
 * measuring the transcript a second time and disagreeing with it.
 */
export type TranscriptGeometry = {
  readonly spans: readonly BlockSpan[];
  readonly rows: number;
};

export const EMPTY_GEOMETRY: TranscriptGeometry = { spans: [], rows: 0 };
