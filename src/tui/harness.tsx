/**
 * The one harness every rendered test mounts through.
 *
 * Before #374 the same four things — a list of live renderers, an `afterEach`
 * that destroyed them, a `mount` that built one, and a `settle` that waited for
 * it — were written out in nine test files. Nine copies is nine chances to get
 * teardown or settling slightly different, and #372 is what that costs: a
 * settle predicate that accepted a buffer nothing had drawn into lived in one
 * file, was corrected in one file, and left eight other files settling by a
 * different rule.
 *
 * This module is test support, not product surface. It ships in no build —
 * `bun run build` compiles `src/main.ts` — and only `*.test.tsx` files import
 * it, which `./tui-boundaries.test.ts` asserts rather than trusts.
 *
 * ## Why teardown is a disposable rather than a hook
 *
 * A leaked renderer is process-wide state: OpenTUI cleans up on neither
 * `process.exit` nor an unhandled error, so one test that forgets fails the
 * *next* test instead of itself. The obvious fix — an `afterEach` in this
 * module — does not work. Bun evaluates an imported module once for the whole
 * run, so a top-level `afterEach` here would register against whichever test
 * file happened to load first and every other file would leak. Measured, not
 * assumed.
 *
 * `using` binds cleanup to the scope that created the renderer, runs on the way
 * out of a thrown assertion, and cannot be declared in the wrong place because
 * there is only one place to declare it.
 */

import { createTestRenderer, type TestRendererSetup } from "@opentui/core/testing";
import { createRoot, flushSync, type Root } from "@opentui/react";
import type { ReactNode } from "react";

/** How many columns and rows the terminal has. */
export type TerminalShape = {
  readonly columns: number;
  readonly rows: number;
};

/** The shape a rendered test uses when it is not testing a particular size. */
export const STANDARD_SHAPE: TerminalShape = { columns: 100, rows: 24 };

/**
 * The cell a test renderer's buffer holds before anything has drawn into it.
 *
 * `U+0A00`, and the whole of #372 is that it is not whitespace. The predicate
 * before it asked `frame.trim() !== ""`, which an entirely unpainted buffer
 * satisfies — so a rendered check could be handed that buffer as its answer,
 * failing at random where the assertion was positive and *passing against
 * nothing* where it was negative.
 */
export const UNPAINTED = "਀";

/**
 * Whether a captured buffer is a frame the shell drew.
 *
 * Two conditions, and both are needed. A buffer holding an unpainted cell
 * anywhere has not finished being drawn into — the renderer paints the whole
 * region, so a partial capture is a capture taken mid-pass rather than a frame
 * with a gap in it. A buffer of nothing but spaces is painted and empty, which
 * is not a frame either.
 *
 * Exported so a check can hand it a buffer directly, which is the only way to
 * test a settle predicate without waiting for the race it exists to lose.
 */
export function hasPainted(frame: string): boolean {
  return frame.trim() !== "" && !frame.includes(UNPAINTED);
}

/** How long a frame is given before waiting becomes a failure rather than a delay. */
const SETTLE_ATTEMPTS = 60;
const SETTLE_INTERVAL_MS = 5;

/**
 * Consecutive identical captures that count as settled when nothing was named.
 *
 * A predicate that returns the first *painted* frame is wrong after input: the
 * previous frame is already painted, so the capture would be the state before
 * the key. Waiting for the frame to stop changing asks the question the caller
 * meant — "the shell has finished reacting" — rather than "something is on
 * screen".
 *
 * Three rather than one because a commit can land between two renderer passes.
 * This is not a substitute for naming what you are waiting for: `frame(marker)`
 * is exact where this is a heuristic, and every check that can name its marker
 * should.
 */
const QUIET_CAPTURES = 3;

export type MountOptions = {
  readonly shape?: TerminalShape;
  /** Enables Kitty keyboard encoding so modified keys remain distinguishable. */
  readonly kittyKeyboard?: boolean;
};

/** A renderer with no React tree in it, disposed with the scope that opened it. */
export type Live = TestRendererSetup & Disposable;

/**
 * A test renderer, and nothing mounted into it.
 *
 * For checks that drive a renderer directly rather than a component tree. They
 * share this module for teardown rather than for mounting.
 */
export async function openRenderer(options: MountOptions = {}): Promise<Live> {
  const shape = options.shape ?? STANDARD_SHAPE;
  const setup = await createTestRenderer({
    width: shape.columns,
    height: shape.rows,
    consoleMode: "disabled",
    screenMode: "alternate-screen",
    externalOutputMode: "passthrough",
    ...(options.kittyKeyboard === undefined ? {} : { kittyKeyboard: options.kittyKeyboard }),
  });
  return Object.assign({ ...setup }, { [Symbol.dispose]: () => setup.renderer.destroy() });
}

/** Modifiers the mock keyboard understands. */
export type Modifiers = {
  readonly ctrl?: boolean;
  readonly shift?: boolean;
  readonly meta?: boolean;
};

/**
 * A mounted tree, and everything a rendered check does to one.
 *
 * Disposable: `using rendered = await mount(...)` unmounts the React tree and
 * destroys the renderer on the way out of the test, including out of a thrown
 * assertion.
 */
export type Rendered = Disposable & {
  readonly setup: TestRendererSetup;
  /** Replaces the tree in the same root, for a check that renders more than once. */
  show(node: ReactNode): Promise<string>;
  /**
   * The settled frame.
   *
   * With `marker`, waits until the frame contains it and throws when it never
   * does. Without one, waits until the frame stops changing.
   */
  frame(marker?: string): Promise<string>;
  press(key: string, modifiers?: Modifiers): Promise<string>;
  /**
   * Escape, tab, and backspace have their own methods for one reason: they are
   * escape sequences rather than text, and `pressKey("escape")` types the six
   * letters of the word — which asserts that nothing happened, and passes.
   */
  pressEscape(modifiers?: Modifiers): Promise<string>;
  pressTab(modifiers?: Modifiers): Promise<string>;
  pressBackspace(): Promise<string>;
  type(text: string): Promise<string>;
  paste(text: string): Promise<string>;
  resize(columns: number, rows: number): Promise<string>;
  /** Every renderable currently in the tree, the root included. */
  renderableCount(): number;
};

/**
 * Mounts a tree into a fresh test renderer.
 *
 * The tree is not settled here. A caller that wants the first frame asks for it,
 * because what counts as the first frame differs: a marker for a check that
 * knows what it is waiting for, and quiet for one that does not.
 */
export async function mount(node: ReactNode, options: MountOptions = {}): Promise<Rendered> {
  const shape = options.shape ?? STANDARD_SHAPE;
  const setup = await openRenderer(options);

  const root: Root = createRoot(setup.renderer);
  root.render(node);

  const frame = (marker?: string): Promise<string> => settle(setup, shape, marker);

  return {
    setup,
    async show(next) {
      root.render(next);
      return await frame();
    },
    frame,
    async press(key, modifiers = {}) {
      setup.mockInput.pressKey(key, modifiers);
      return await frame();
    },
    async pressEscape(modifiers = {}) {
      setup.mockInput.pressEscape(modifiers);
      return await frame();
    },
    async pressTab(modifiers = {}) {
      setup.mockInput.pressTab(modifiers);
      return await frame();
    },
    async pressBackspace() {
      setup.mockInput.pressBackspace();
      return await frame();
    },
    async type(text) {
      for (const character of text) {
        setup.mockInput.pressKey(character);
      }
      return await frame();
    },
    async paste(text) {
      setup.mockInput.pasteBracketedText(text);
      return await frame();
    },
    async resize(columns, rows) {
      setup.resize(columns, rows);
      return await settle(setup, { columns, rows });
    },
    renderableCount: () => countRenderables(setup.renderer.root),
    [Symbol.dispose]: () => {
      // Unmount before destroy, and both unconditionally. Destroying a renderer
      // whose React root still holds it leaves effects subscribed to a renderer
      // that no longer exists, which is a leak that reports itself as a later
      // test failing for no reason.
      //
      // `flushSync` because an ordinary `unmount()` only schedules the work:
      // React runs effect cleanups on a later tick, so without this the
      // subscriptions a tree held are still live when the next check starts,
      // and "released on teardown" would be true only eventually. Measured —
      // `./harness.test.tsx` asserts the release immediately after the scope
      // ends, and fails without this call.
      flushSync(() => root.unmount());
      setup.renderer.destroy();
    },
  };
}

/**
 * Mounts, settles, and tears down in one call.
 *
 * For the many checks whose whole interest is the frame a tree produces. They
 * hold no renderer afterwards, so they need no `using` — and a check that
 * cannot leak is better than one that remembers not to.
 */
export async function frameOf(
  node: ReactNode,
  options: MountOptions = {},
  marker?: string,
): Promise<string> {
  using rendered = await mount(node, options);
  return await rendered.frame(marker);
}

/**
 * Yields to the loop until the renderer has drawn what the caller asked for.
 *
 * The sleep is deliberate and is not a wall-clock wait: React commits on a
 * microtask and the test renderer's own wait helpers advance passes by draining
 * microtasks and `nextTick` only, so a loop that never hands the host loop back
 * polls a buffer that a pending timer has not been allowed to change yet. Each
 * pass is a poll against a predicate, and the first one that answers ends it.
 *
 * It throws rather than returning the last capture. A helper that hands back
 * whatever the buffer happened to hold turns "the shell never painted" into
 * "the assertion below failed", which is a different defect reported in a
 * different place.
 */
async function settle(
  setup: TestRendererSetup,
  shape: TerminalShape,
  marker?: string,
): Promise<string> {
  let last = "";
  let quiet = 0;

  for (let attempt = 0; attempt < SETTLE_ATTEMPTS; attempt += 1) {
    await Bun.sleep(SETTLE_INTERVAL_MS);
    await setup.flush();
    const captured = setup.captureCharFrame();
    quiet = captured === last ? quiet + 1 : 0;
    last = captured;

    if (!hasPainted(captured)) {
      continue;
    }
    if (marker === undefined ? quiet >= QUIET_CAPTURES : captured.includes(marker)) {
      return captured;
    }
  }

  throw new Error(
    `the frame never settled after ${SETTLE_ATTEMPTS * SETTLE_INTERVAL_MS}ms` +
      ` (${shape.columns}×${shape.rows}, painted: ${hasPainted(last)}` +
      `${marker === undefined ? "" : `, waiting for ${JSON.stringify(marker)}`})`,
  );
}

/** Every renderable under a node, the node itself included. */
export function countRenderables(node: { getChildren?: () => readonly unknown[] }): number {
  let total = 1;
  for (const child of node.getChildren?.() ?? []) {
    total += countRenderables(child as { getChildren?: () => readonly unknown[] });
  }
  return total;
}
