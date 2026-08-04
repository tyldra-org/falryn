/**
 * The one path from a finalized transcript entry to the terminal's scrollback.
 *
 * In `split-footer` React owns the live footer and the terminal owns everything
 * above it. That region is not a surface Falryn can repaint: a row committed to
 * scrollback is durable, is the reader's own scroll history, and survives the
 * process. So the rules for reaching it are stricter than the rules for drawing
 * a frame, and all of them live here.
 *
 * **One FIFO.** OpenTUI's renderer already owns an ordered queue that captured
 * stdout and programmatic scrollback commits share, and the native side emits
 * both as ANSI alongside the footer repaint in one atomic frame. This adapter
 * adds no second queue and no second ordering rule — it feeds that one, in
 * order, and `./scrollback.test.ts` asserts the interleaving through the test
 * renderer's external-output recorder rather than assuming it.
 *
 * **Once, and never out of order.** A block commits exactly once, and a block is
 * only committed when every block before it already has been. Scrollback is
 * append-only, so an entry that overtook an unfinished one would be in the wrong
 * place permanently — there is no later frame in which to fix it. An unfinished
 * block therefore holds everything behind it, which is a real cost and the
 * correct one.
 *
 * **Streaming settles before it commits.** A block first seen mid-stream goes
 * through `createScrollbackSurface`, which renders into a backing buffer that can
 * be re-rendered in place; its rows are copied out only after `settle()`. A block
 * that was already final when it arrived is atomic and goes through
 * `writeToScrollback` in one call. Two paths because there are two situations,
 * not because there are two ordering rules: both end in the same queue.
 *
 * **A no-op everywhere else.** `alternate-screen` and `main-screen` draw into the
 * whole terminal and reserve no footer, and OpenTUI's scrollback APIs throw
 * rather than degrade when the mode is wrong. The mode is consulted on every
 * commit through `reservesFooter`, because renderer mode is application state
 * that can change rather than a constant fixed at construction.
 *
 * This module reaches OpenTUI's runtime, and `./tui-boundaries.test.ts` asserts
 * that nothing outside it writes to scrollback. Raw bytes from a child process
 * reach the terminal through the renderer's stdout capture or not at all; there
 * is no third door.
 */

import type {
  Renderable,
  RenderContext,
  ScreenMode,
  ScrollbackSurface,
  ScrollbackSurfaceOptions,
  ScrollbackWriter,
} from "@opentui/core";
import { BoxRenderable, TextRenderable } from "@opentui/core";
import type { TranscriptBlock } from "../presentation/index.ts";
import { blockKey } from "../presentation/index.ts";
import { reservesFooter } from "./screen-mode.ts";
import type { DrawableLine } from "./transcript/lines.ts";

/**
 * What the adapter needs from a renderer, and nothing more.
 *
 * Structural rather than `CliRenderer`, so the surface this module depends on is
 * three members instead of a class with a terminal attached. A real renderer
 * satisfies it, which is what lets the tests run against the actual queue rather
 * than against a stand-in that agrees with whatever this file happens to do.
 */
export type ScrollbackHost = {
  readonly screenMode: ScreenMode;
  writeToScrollback(write: ScrollbackWriter): void;
  createScrollbackSurface(options?: ScrollbackSurfaceOptions): ScrollbackSurface;
};

/**
 * How a block becomes lines, at the width the renderer reports.
 *
 * A callback rather than pre-rendered lines because the width is only known
 * inside the writer: it is the renderer's current width at the moment the
 * snapshot is built, and lines measured against a stale one would be committed
 * at the wrong wrap for good.
 */
export type ScrollbackRenderer = (
  block: TranscriptBlock,
  columns: number,
) => readonly DrawableLine[];

export type ScrollbackRequest = {
  /** The projection's blocks, in semantic order. */
  readonly blocks: readonly TranscriptBlock[];
  readonly render: ScrollbackRenderer;
};

export type ScrollbackReport = {
  /** Keys this call committed, in the order they were committed. */
  readonly committed: readonly string[];
  /**
   * The first block that was not final, or `null`.
   *
   * Reported rather than silently skipped: it is the reason everything after it
   * is still waiting, and a caller that could not name it would have no way to
   * tell "nothing new" from "blocked behind a stream".
   */
  readonly held: string | null;
  /** A safe description of a commit that threw, or `null`. Never the error. */
  readonly failure: string | null;
};

export type ScrollbackAdapter = {
  /**
   * Commits every finalized block that has not been committed yet.
   *
   * Resolves once the commits this call enqueued have been handed to the
   * renderer's queue, so a caller can assert what reached scrollback. Never
   * throws: a renderer that refused a commit is reported, because the shell has
   * to keep drawing either way.
   */
  commit(request: ScrollbackRequest): Promise<ScrollbackReport>;
  /** Keys already committed. Exported so a control can prove commits happen once. */
  committedKeys(): ReadonlySet<string>;
  /** Stops further commits. Safe to call more than once. */
  destroy(): void;
};

/**
 * The adapter each renderer has, created on first use.
 *
 * Keyed by the renderer rather than held by whatever asked for it, and that is
 * the difference between "commits once" being a property of the terminal and
 * being a property of a caller's lifetime. OpenTUI's React root remounts the
 * whole tree on every `render()` call, so an adapter owned by a component would
 * start again with an empty set — and every entry already in the reader's
 * scroll history would be written a second time underneath itself.
 *
 * Weak, so the adapter is collected with the renderer it belongs to and nothing
 * has to remember to unregister it.
 */
const adapters = new WeakMap<ScrollbackHost, ScrollbackAdapter>();

/**
 * The adapter for a renderer, reused across mounts.
 *
 * The accessor product code uses. `createScrollbackAdapter` stays exported for
 * tests that want an isolated one, which is the only situation where a second
 * adapter over one renderer is anything other than a duplication bug.
 */
export function scrollbackAdapterFor(host: ScrollbackHost): ScrollbackAdapter {
  const existing = adapters.get(host);
  if (existing !== undefined) {
    return existing;
  }
  const created = createScrollbackAdapter(host);
  adapters.set(host, created);
  return created;
}

const MAX_FAILURE_DETAIL = 200;

function safeDetail(thrown: unknown): string {
  const raw = thrown instanceof Error ? thrown.message : "unknown failure";
  return raw.length > MAX_FAILURE_DETAIL ? `${raw.slice(0, MAX_FAILURE_DETAIL)}…` : raw;
}

export function createScrollbackAdapter(host: ScrollbackHost): ScrollbackAdapter {
  const committed = new Set<string>();
  /**
   * Keys seen while still in progress.
   *
   * Membership is what selects the settling path later: a block that was ever
   * observed mid-stream is streamed content, even if the projection it finally
   * commits from looks identical to one that arrived complete.
   */
  const streamed = new Set<string>();
  /**
   * The serializing chain.
   *
   * `writeToScrollback` enqueues synchronously but a surface has to settle
   * first, so without this a settling entry would be overtaken by the atomic
   * entry behind it. One chain, so the order commits are *started* in is the
   * order they reach the queue.
   */
  let tail: Promise<void> = Promise.resolve();
  let disposed = false;

  function enqueue(work: () => void | Promise<void>): Promise<void> {
    const next = tail.then(work, work);
    // Failures are recorded by the caller and must not poison the chain: a
    // refused commit is one entry that did not land, not a scrollback that
    // stops working for the rest of the session.
    tail = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  return {
    committedKeys: () => committed,

    destroy(): void {
      disposed = true;
    },

    async commit(request: ScrollbackRequest): Promise<ScrollbackReport> {
      if (disposed || !reservesFooter(host.screenMode)) {
        return { committed: [], held: null, failure: null };
      }

      const started: string[] = [];
      const pending: Promise<void>[] = [];
      let held: string | null = null;
      let failure: string | null = null;

      const record = (thrown: unknown): void => {
        // The first failure is the one reported. A later one is usually the
        // same cause seen again, and a caller needs the reason rather than a
        // list of its repetitions.
        failure ??= safeDetail(thrown);
      };

      for (const block of request.blocks) {
        const key = blockKey(block.anchor);
        if (committed.has(key)) {
          continue;
        }
        if (block.status !== "final") {
          // Everything behind it waits. See this module's header: scrollback is
          // append-only, so committing past an unfinished entry would place it
          // permanently out of semantic order.
          streamed.add(key);
          held = key;
          break;
        }

        // Marked before the work rather than after. Two renders can observe the
        // same projection before the queue drains, and a set updated on
        // completion would let the second one commit the entry again.
        committed.add(key);
        started.push(key);

        const settling = streamed.delete(key);
        pending.push(
          enqueue(async () => {
            try {
              if (settling) {
                await commitSettled(host, block, request.render);
              } else {
                commitAtomic(host, block, request.render);
              }
            } catch (thrown) {
              record(thrown);
            }
          }),
        );
      }

      await Promise.all(pending);
      return { committed: started, held, failure };
    },
  };
}

/**
 * A block that was already final: rendered once and committed in one call.
 *
 * The height is stated rather than measured. `writeToScrollback` renders the
 * tree into the snapshot buffer it sizes from this number, and a box whose
 * height is still `auto` at that moment measures as nothing — so the line count,
 * which is known exactly, is the honest answer.
 */
function commitAtomic(
  host: ScrollbackHost,
  block: TranscriptBlock,
  render: ScrollbackRenderer,
): void {
  const key = blockKey(block.anchor);
  host.writeToScrollback((context) => {
    const lines = render(block, context.width);
    const height = Math.max(1, lines.length);
    const root = new BoxRenderable(context.renderContext, {
      id: `scrollback-${key}`,
      position: "absolute",
      left: 0,
      top: 0,
      width: context.width,
      height,
      flexDirection: "column",
      backgroundColor: "transparent",
    });
    fill(root, context.renderContext, key, lines, context.width);
    return {
      root,
      width: context.width,
      height,
      startOnNewLine: true,
      trailingNewline: true,
    };
  });
}

/**
 * A block that was seen mid-stream: rendered into a surface, settled, committed.
 *
 * The surface is measured rather than told a height — that is the difference
 * that makes this path worth having, because settled content is content whose
 * final size was not knowable when the entry first appeared. It is destroyed on
 * every path, including a commit that threw, so a refused entry does not leak a
 * backing buffer for the rest of the session.
 */
async function commitSettled(
  host: ScrollbackHost,
  block: TranscriptBlock,
  render: ScrollbackRenderer,
): Promise<void> {
  const key = blockKey(block.anchor);
  const surface = host.createScrollbackSurface({ startOnNewLine: true });
  try {
    fill(surface.root, surface.renderContext, key, render(block, surface.width), surface.width);
    // Renders and then waits for anything still resolving. Only after this is
    // the row range a commit would copy the finished content rather than a
    // frame of it.
    await surface.settle();
    surface.commitRows(0, surface.height);
  } finally {
    surface.destroy();
  }
}

/** Adds one text renderable per line, in order. */
function fill(
  root: Renderable,
  context: RenderContext,
  key: string,
  lines: readonly DrawableLine[],
  width: number,
): void {
  for (const [index, line] of lines.entries()) {
    root.add(
      new TextRenderable(context, {
        id: `scrollback-${key}-${index}`,
        content: line.text,
        width,
        height: 1,
        // Never wrapped here. The rows arrive already wrapped to the width they
        // were measured against, and a second wrap would re-flow text whose
        // indentation was chosen a step earlier.
        wrapMode: "none",
        ...(line.color === null ? {} : { fg: line.color }),
        attributes: line.attributes,
      }),
    );
  }
}
