/**
 * Interpret a pseudo-terminal transcript as the screen a terminal would show.
 *
 * #384. Every rendered check in this area reads the buffer the test renderer
 * believes it drew. The compiled walk reads raw bytes. Neither answers what a
 * person sees: which row a string ended up on, and whether another region had
 * already painted those cells. Feeding the transcript through a headless
 * emulator is the missing oracle.
 *
 * ## Dependency record — `@xterm/headless@6.0.0`
 *
 * - **Need.** No in-repository component interprets an escape stream. Writing
 *   one is writing a terminal emulator, which is a larger commitment than the
 *   defect this oracle exists to catch.
 * - **Alternatives rejected.** A minimal cursor/text decoder is cheap and wrong
 *   the first time a check meets a scroll region, a synchronized update, or a
 *   wide glyph — precisely the ground this covers. `node-pty` plus a full
 *   emulator duplicates the pseudo-terminal this repository already has.
 * - **Bun / compiled / platform.** Dev dependency only. Reached from this module
 *   alone; `src/tui/tui-boundaries.test.ts` holds it out of every shipping
 *   graph. Loads cleanly under Bun 1.4.0 (verified by the companion check).
 * - **License / maintenance / transitive cost.** MIT; repository
 *   https://github.com/xtermjs/xterm.js; no runtime dependencies.
 * - **Research provenance.** Pattern observed in oh-my-pi / qwen-code test and
 *   tool paths that drive `@xterm/headless` and read `buffer.active` rows. No
 *   code was copied; Falryn owns this adapter and its fixtures.
 * - **Decision.** Adopt `@xterm/headless@6.0.0` as the sole interpreter behind
 *   this module.
 *
 * A check asks for rows. It does not import the emulator.
 */

import { Terminal } from "@xterm/headless";

export type EmulatedCursor = {
  readonly column: number;
  readonly row: number;
};

export type EmulatedScreen = {
  /** Visible rows, top to bottom, trimmed of trailing blank cells per row. */
  readonly rows: readonly string[];
  readonly columns: number;
  readonly terminalRows: number;
  readonly cursor: EmulatedCursor;
};

export type EmulatedScreenSize = {
  readonly columns: number;
  readonly rows: number;
};

/**
 * The visible screen after `transcript` is written into a headless terminal of
 * the given size.
 *
 * The size must be the size the emitting process was told about. Interpreting a
 * 100×30 transcript at a different size invents a layout nobody drew.
 */
export async function emulateScreen(
  transcript: string,
  size: EmulatedScreenSize,
): Promise<EmulatedScreen> {
  const columns = Math.max(1, Math.floor(size.columns));
  const rows = Math.max(1, Math.floor(size.rows));
  const terminal = new Terminal({
    cols: columns,
    rows,
    // The compiled walk's transcript is one session, not a scrollback history.
    // Keeping scrollback at zero makes the active buffer the viewport.
    scrollback: 0,
    allowProposedApi: true,
  });

  try {
    await writeTerminal(terminal, transcript);
    const buffer = terminal.buffer.active;
    const visible: string[] = [];
    for (let y = 0; y < terminal.rows; y += 1) {
      const line = buffer.getLine(buffer.viewportY + y);
      visible.push(line ? line.translateToString(true) : "");
    }
    return {
      rows: visible,
      columns: terminal.cols,
      terminalRows: terminal.rows,
      cursor: { column: buffer.cursorX, row: buffer.cursorY },
    };
  } finally {
    terminal.dispose();
  }
}

/**
 * Rows that carry marks from more than one exclusive group.
 *
 * Each group is a region's exclusive landmarks. A clean frame places at most
 * one group's marks on any row; a spliced row is exactly the defect the
 * in-memory height sweep already names and the shipped artifact can still hide
 * from byte assertions.
 */
export function rowsCarryingMarksFromMultipleGroups(
  rows: readonly string[],
  groups: readonly (readonly string[])[],
): readonly string[] {
  return rows.filter((row) => {
    let hits = 0;
    for (const group of groups) {
      if (group.some((mark) => row.includes(mark))) {
        hits += 1;
        if (hits > 1) {
          return true;
        }
      }
    }
    return false;
  });
}

function writeTerminal(terminal: Terminal, output: string): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  terminal.write(output, resolve);
  return promise;
}
