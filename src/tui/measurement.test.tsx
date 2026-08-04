/**
 * The shell's resource behavior, measured.
 *
 * Six quantities the compatibility document names under *Performance and leak
 * checks* and that nothing had ever taken a number for: startup to first draw,
 * render cadence, input latency under stream load, event-loop delay, memory
 * growth across a long transcript, and shutdown latency.
 *
 * It consumes the shape `src/data/measurement.test.ts` established rather than
 * redefining it — `../measurement-fixtures.ts` is that shape, moved out when
 * this second area needed it. Every number carries the platform it was taken
 * on, states its dataset, and is a distribution rather than a sample; a quantity
 * that could not be taken is reported as unmeasured and fails rather than
 * printing a zero that reads as fast.
 *
 * ## Two of the six cannot come from a test renderer
 *
 * OpenTUI's frame loop is what advances a timeline, and a test renderer does not
 * run one. So **render cadence** measured in process would be measuring the
 * test harness's own polling, and **startup to first draw** measured in process
 * would exclude process start — which is the part that costs, since a compiled
 * Bun executable already starts roughly 170 ms slower than a source run.
 *
 * Those two, and shutdown latency with them, are taken from `dist/falryn` on a
 * real pseudo-terminal through `./pty-fixtures.ts`, where a real frame loop
 * runs and a frame boundary is a byte sequence the terminal actually received.
 * The other three are taken in process through `./harness.tsx`, mounting the
 * same tree every rendered check mounts.
 *
 * ## What it asserts, and what it refuses to
 *
 * No timing threshold. A budget invented without a measurement behind it is a
 * flake on a loaded developer machine, and thresholds belong to the benchmark
 * harness this repository has no owner for yet — `bun run check` does not run
 * this file at all.
 *
 * What it does assert is that the work it measured actually happened: the frame
 * drew, the keys reached the composer, the blocks rendered, the process exited
 * through the table it owns. A run that measured nothing must not be able to
 * report a fast number.
 */

import { describe, expect, test } from "bun:test";
import type { ReactNode } from "react";
import { EXIT_CODES } from "../cli/index.ts";
import type { ScopeEvent } from "../domain/index.ts";
import {
  binarySize,
  distribution,
  formatDistribution,
  MEASURING,
  milliseconds,
  report,
  rounded,
  unmeasured,
} from "../measurement-fixtures.ts";
import { scopeEvent } from "../presentation/activity/fixtures.ts";
import type { TranscriptBlock, TranscriptProjection } from "../presentation/index.ts";
import { complete, EMPTY_PROJECTION } from "../presentation/index.ts";
import { everyBlockKind, FIXTURE_AT } from "../presentation/transcript/fixtures.ts";
import { ShellApp } from "./components/shell-app.tsx";
import { mount } from "./harness.tsx";
import {
  compiledArtifactBuilt,
  compiledShellRunnable,
  EXIT_MS,
  FRAME_START,
  frameOffsets,
  MOUNT_MS,
  RESTORED,
  startOnPty,
  waitForBytes,
  waitForQuiet,
  write,
} from "./pty-fixtures.ts";
import { type RuntimeFeed, useRuntimeProjection } from "./runtime-feed.ts";
import type { ThemeRequest } from "./theme/index.ts";
import { known, type ShellModel, unavailable } from "./view-model.ts";

// ── The declared dataset ────────────────────────────────────────────────────
//
// Fixed, bounded, and reported alongside every result, because a number whose
// input is not stated cannot be compared to anything. Each one is small enough
// that the whole file runs in a couple of minutes: this measures shape, not
// scale.

/** Whole processes started, each one a fresh compiled executable on its own tty. */
const STARTUP_SAMPLES = 5;

/** Keystrokes paced apart, which is what a cadence is measured across. */
const PACED_KEYS = 60;
const PACED_INTERVAL_MS = 8;

/** Keystrokes in one burst, written back to back with no delay between them. */
const BURST_KEYS = 60;

/** Key presses timed, each one opening the overlay while the rail is streaming. */
const INPUT_SAMPLES = 20;

/** Scope events per second the fake runtime emits while input is being timed. */
const LOAD_EVENTS_PER_SECOND = 200;

/** Timer round trips sampled, loaded and idle. */
const LOOP_SAMPLES = 200;

/** Transcript lengths the projection is grown through, in blocks. */
const TRANSCRIPT_STEPS = [250, 500, 1_000, 2_000] as const;

/** Interrupts delivered, each to its own compiled process. */
const SHUTDOWN_SAMPLES = 3;

/** Mount-and-tear-down cycles timed in process. */
const TEARDOWN_SAMPLES = 10;

/** The terminal every in-process measurement mounts against. */
const SHAPE = { columns: 100, rows: 30 } as const;

const MEASUREMENT_TIMEOUT_MS = 300_000;

// ── The tree, and what feeds it ─────────────────────────────────────────────

const THEME: ThemeRequest = {
  variant: "dark",
  colorLevel: "truecolor",
  symbols: "unicode",
  reducedMotion: true,
  generation: 1,
};

const MODEL: Omit<ShellModel, "overlay" | "commands" | "transcript" | "composer" | "activity"> = {
  header: {
    workspace: known("/work/falryn"),
    branch: unavailable("no Git yet"),
    session: unavailable("no session yet"),
    model: unavailable("no provider yet"),
  },
  status: { status: "informational", message: "Nothing is running.", hints: [] },
  help: [{ title: "Leaving", body: "Ctrl+C ends the session." }],
};

/** The marker the base view always carries, and the one the overlay adds. */
const AT_REST = "/work/falryn";
const OVERLAY = "Help";

/** A feed a measurement drives by hand, in the shape `./runtime-feed.test.tsx` uses. */
function fakeFeed() {
  let events: ScopeEvent[] = [];
  const listeners = new Set<() => void>();
  return {
    feed: {
      events: () => events,
      subscribe: (listener: () => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      shutdown: () => null,
    } satisfies RuntimeFeed,
    emit(...next: readonly ScopeEvent[]) {
      events = [...events, ...next];
      for (const listener of [...listeners]) {
        listener();
      }
    },
  };
}

/**
 * The shell subscribed to a runtime, which is the tree `src/tui/shell.tsx`
 * mounts.
 *
 * Written here rather than imported because the shell composes it inside a
 * function that also opens a renderer session. What is under measurement is the
 * adapter and the tree, and this is both of them wired the same way.
 */
function Streaming(props: { readonly feed: RuntimeFeed }): ReactNode {
  const runtime = useRuntimeProjection(props.feed);
  return <ShellApp theme={THEME} model={MODEL} onExit={() => {}} activity={runtime.activity} />;
}

/** A long history of distinguishable blocks, the shape `./components/transcript.test.tsx` uses. */
function history(count: number): TranscriptProjection {
  const notice = everyBlockKind().find((block) => block.kind === "notice");
  if (notice === undefined || notice.kind !== "notice") {
    unmeasured("memory growth across a long transcript", "the corpus no longer has a notice block");
  }
  const blocks: TranscriptBlock[] = Array.from({ length: count }, (_unused, index) => ({
    ...notice,
    anchor: { of: "declared", key: `entry-${index}` } as const,
    occurredAt: FIXTURE_AT,
    order: index,
    summary: complete(`entry ${index}`),
    note: complete(`the body of entry ${index}`),
  }));
  return { ...EMPTY_PROJECTION, blocks };
}

/** Bytes this process is holding, after the collector has had its say. */
function heldBytes(): number {
  // Forced rather than hoped for: an uncollected step reads as growth that the
  // next step does not repeat, which is the noise this whole measurement is
  // trying to see through.
  Bun.gc(true);
  return process.memoryUsage().heapUsed;
}

// ── In process, through the one harness ─────────────────────────────────────

describe.if(MEASURING)("the shell's resource behavior", () => {
  test(
    "input latency under stream load",
    async () => {
      const source = fakeFeed();
      using shell = await mount(<Streaming feed={source.feed} />, {
        shape: SHAPE,
        // The mode an overlay has room to draw in. In `split-footer` the live
        // region is a six-row footer, so what would be measured is the footer
        // rather than the interface reacting.
        screenMode: "alternate-screen",
      });
      await shell.frame(AT_REST);

      // The load: a runtime emitting scope events for the whole time the keys
      // are being pressed, so every press lands on a tree that is already
      // re-rendering. An idle measurement would be a different quantity.
      let order = 0;
      const load = setInterval(() => {
        order += 1;
        source.emit(
          scopeEvent({
            order,
            kind: order % 2 === 0 ? "scope.terminal" : "scope.opened",
            scope: `load-${Math.floor(order / 2)}`,
            ...(order % 2 === 0 ? { outcome: { kind: "completed" } as const } : {}),
          }),
        );
      }, 1_000 / LOAD_EVENTS_PER_SECOND);

      const samples: number[] = [];
      try {
        for (let sample = 0; sample < INPUT_SAMPLES; sample += 1) {
          const pressedAt = Bun.nanoseconds();
          shell.setup.mockInput.pressKey("?");
          await shell.frame(OVERLAY);
          samples.push(Bun.nanoseconds() - pressedAt);
          // Closed again, untimed: what is being measured is one direction, and
          // a sample that alternated would report the mean of two behaviors.
          shell.setup.mockInput.pressEscape();
          await shell.frame(AT_REST);
        }
      } finally {
        clearInterval(load);
      }

      // The load was real, and the frame is the state the last press left.
      expect(order).toBeGreaterThan(0);
      expect(await shell.frame(AT_REST)).toContain(AT_REST);

      report({
        quantity: "input latency under stream load",
        against: "the mounted shell tree, subscribed to a runtime feed",
        dataset: `${INPUT_SAMPLES} presses opening the overlay, under ${LOAD_EVENTS_PER_SECOND} scope events/second (${order} emitted)`,
        state: "warm",
        result: formatDistribution(distribution(samples)),
        notes: [
          "press to the settled frame that contains the overlay, so it includes React's commit and the renderer's pass",
          "resolution is the harness's 5 ms settle interval; each sample is an upper bound quantized to it",
        ],
      });
    },
    MEASUREMENT_TIMEOUT_MS,
  );

  test(
    "event-loop delay",
    async () => {
      const source = fakeFeed();
      using shell = await mount(<Streaming feed={source.feed} />, {
        shape: SHAPE,
        screenMode: "alternate-screen",
      });
      await shell.frame(AT_REST);

      /** How late a timer asked for now actually ran. */
      const lag = async (): Promise<number> => {
        const asked = Bun.nanoseconds();
        await new Promise<void>((resolve) => {
          setTimeout(resolve, 0);
        });
        return Bun.nanoseconds() - asked;
      };

      const idle: number[] = [];
      for (let sample = 0; sample < LOOP_SAMPLES; sample += 1) {
        idle.push(await lag());
      }

      let order = 0;
      const load = setInterval(() => {
        order += 1;
        source.emit(scopeEvent({ order, kind: "scope.opened", scope: `load-${order}` }));
      }, 1_000 / LOAD_EVENTS_PER_SECOND);

      const loaded: number[] = [];
      try {
        for (let sample = 0; sample < LOOP_SAMPLES; sample += 1) {
          loaded.push(await lag());
        }
      } finally {
        clearInterval(load);
      }

      expect(order).toBeGreaterThan(0);

      report({
        quantity: "event-loop delay",
        against: "the mounted shell tree, subscribed to a runtime feed",
        dataset: `${LOOP_SAMPLES} timer round trips under ${LOAD_EVENTS_PER_SECOND} scope events/second (${order} emitted)`,
        state: "warm",
        result: formatDistribution(distribution(loaded)),
        notes: [
          `idle baseline, same tree with nothing streaming: ${formatDistribution(distribution(idle))}`,
          "a zero-delay timer, so the number is the loop's own turnaround rather than a scheduling error",
        ],
      });
    },
    MEASUREMENT_TIMEOUT_MS,
  );

  test(
    "memory growth across a long transcript",
    async () => {
      using shell = await mount(
        <ShellApp theme={THEME} model={MODEL} onExit={() => {}} transcript={EMPTY_PROJECTION} />,
        { shape: SHAPE, screenMode: "alternate-screen" },
      );
      await shell.frame(AT_REST);

      const empty = { held: heldBytes(), renderables: shell.renderableCount() };
      const steps: { blocks: number; held: number; renderables: number }[] = [];

      for (const blocks of TRANSCRIPT_STEPS) {
        await shell.show(
          <ShellApp theme={THEME} model={MODEL} onExit={() => {}} transcript={history(blocks)} />,
        );
        // Named rather than quiet: the last block is the one a bounded window
        // shows, so waiting for it is waiting for the projection to have been
        // drawn rather than for the frame to have stopped moving.
        await shell.frame(`entry ${blocks - 1}`);
        steps.push({ blocks, held: heldBytes(), renderables: shell.renderableCount() });
      }

      const first = steps[0];
      const last = steps[steps.length - 1];
      if (first === undefined || last === undefined) {
        unmeasured("memory growth across a long transcript", "no transcript step was rendered");
      }

      // The blocks reached the screen. Without this the growth could be the cost
      // of building projections nothing ever drew.
      expect(await shell.frame()).toContain(`entry ${last.blocks - 1}`);

      const grown = last.held - first.held;
      const perBlock = grown / (last.blocks - first.blocks);
      report({
        quantity: "memory growth across a long transcript",
        against: "the mounted shell tree, re-rendered at each transcript length",
        dataset: `${TRANSCRIPT_STEPS.join(", ")} notice blocks, each with a summary and a body`,
        state: "warm",
        result: `${binarySize(grown)} held across ${last.blocks - first.blocks} added blocks | ${rounded(perBlock)} bytes/block`,
        notes: [
          `held: empty ${binarySize(empty.held)}${steps.map((step) => `, ${step.blocks} blocks ${binarySize(step.held)}`).join("")}`,
          `renderables: empty ${empty.renderables}${steps.map((step) => `, ${step.blocks} blocks ${step.renderables}`).join("")}`,
          "heap after a forced collection, so what is reported is held rather than allocated",
          "growth is taken between the first and last transcript step: the empty reading is dominated by module, renderer, and mount allocation, and is not a baseline the later steps grew from",
          "the surface draws a bounded window, so renderables are expected to stay flat while blocks grow",
        ],
      });
    },
    MEASUREMENT_TIMEOUT_MS,
  );
});

// ── On the shipped artifact, through a real terminal ────────────────────────

describe.if(MEASURING && compiledShellRunnable)("the shipped artifact's resource behavior", () => {
  test(
    "startup to first draw",
    async () => {
      const toFirstByte: number[] = [];
      const toFirstFrame: number[] = [];
      let drew = "";

      for (let sample = 0; sample < STARTUP_SAMPLES; sample += 1) {
        using started = startOnPty([]);
        const frame = await waitForBytes(started.pty, FRAME_START, MOUNT_MS * 2);
        if (frame === -1) {
          unmeasured(
            "startup to first draw",
            `dist/falryn drew no frame within ${MOUNT_MS * 2} ms on sample ${sample + 1}`,
          );
        }
        const frameAt = started.pty.arrivalOf(frame);
        const firstAt = started.pty.arrivalOf(0);
        if (frameAt === null || firstAt === null) {
          unmeasured(
            "startup to first draw",
            "the terminal recorded no arrival for a byte it holds",
          );
        }
        toFirstFrame.push(frameAt - started.spawnedAt);
        toFirstByte.push(firstAt - started.spawnedAt);
        // Let the frame finish arriving, so the assertion below is about what
        // was drawn rather than about how much of it had been read.
        await waitForQuiet(started.pty);
        drew = started.pty.transcript();
      }

      // A frame, and the shell's own frame: a process that wrote an escape
      // sequence and died would otherwise be reported as a fast startup.
      expect(drew).toContain("workspace");

      report({
        quantity: "startup to first draw",
        against: "dist/falryn on a pseudo-terminal, 100×30, TERM=xterm-256color",
        dataset: `${STARTUP_SAMPLES} cold process starts, one pseudo-terminal each`,
        state: "cold",
        result: formatDistribution(distribution(toFirstFrame)),
        notes: [
          `spawn to first byte on the terminal: ${formatDistribution(distribution(toFirstByte))}`,
          "measured from immediately before spawn to the arrival of the synchronized-update sequence that opens the first frame",
          "includes the executable's own start, which is the part an in-process measurement cannot see",
        ],
      });
    },
    MEASUREMENT_TIMEOUT_MS,
  );

  test(
    "render cadence",
    async () => {
      using started = startOnPty([]);
      const { pty } = started;
      if ((await waitForBytes(pty, FRAME_START, MOUNT_MS * 2)) === -1) {
        unmeasured("render cadence", "dist/falryn drew no frame to measure a cadence between");
      }
      await waitForQuiet(pty);

      // Into the composer: two tabs from the header, past the primary region.
      // Typing at the header would be measuring keys nothing consumes.
      write(pty, [0x09]);
      await waitForQuiet(pty);
      write(pty, [0x09]);
      await waitForQuiet(pty);

      // Sustained input rather than one instant of it. A cadence is the
      // interval between frames while there is something to draw, so the keys
      // are paced: written all at once they arrive inside a single frame, which
      // measures coalescing and not cadence.
      const pacedFrom = pty.transcript().length;
      for (let key = 0; key < PACED_KEYS; key += 1) {
        write(pty, "abcdefghij"[key % 10] ?? "a");
        await Bun.sleep(PACED_INTERVAL_MS);
      }
      const pacedTo = await waitForQuiet(pty);

      const arrivals = frameOffsets(pty, pacedFrom, pacedTo)
        .map((offset) => pty.arrivalOf(offset))
        .filter((at) => at !== null);
      const first = arrivals[0];
      const last = arrivals[arrivals.length - 1];
      if (arrivals.length < 2 || first === undefined || last === undefined) {
        unmeasured(
          "render cadence",
          `${PACED_KEYS} paced keystrokes produced ${arrivals.length} frame(s), which is too few to measure an interval between`,
        );
      }
      const intervals = arrivals.slice(1).map((at, index) => at - (arrivals[index] ?? at));
      const drawing = milliseconds(last - first);

      // And the same keys again with nothing between them, which is the other
      // half of the question: how far the renderer collapses input it is given
      // faster than it can draw.
      const burstFrom = pty.transcript().length;
      for (let key = 0; key < BURST_KEYS; key += 1) {
        write(pty, "abcdefghij"[key % 10] ?? "a");
      }
      const burstTo = await waitForQuiet(pty);
      const burstFrames = frameOffsets(pty, burstFrom, burstTo).length;

      // The keys arrived and were drawn, so the frames counted are frames of
      // this input rather than of something else the interface was doing.
      //
      // On the burst, because a frame under paced input is an *incremental*
      // redraw — the terminal is sent the two cells that changed and a cursor
      // move, not the line — so the typed run only appears whole where the
      // renderer had enough queued to repaint the field. The paced slice is
      // asserted on the composer taking focus and drawing, which is what makes
      // its frames this input's frames.
      expect(pty.transcript().slice(burstFrom, burstTo)).toContain("abcdefghij");
      expect(pty.transcript().slice(pacedFrom, pacedTo)).toContain("Editing");

      report({
        quantity: "render cadence",
        against: "dist/falryn on a pseudo-terminal, 100×30, typing into the composer",
        dataset: `${PACED_KEYS} keystrokes ${PACED_INTERVAL_MS} ms apart, then ${BURST_KEYS} written back to back`,
        state: "warm",
        result: `intervals ${formatDistribution(distribution(intervals))} | ${arrivals.length} frames across ${rounded(drawing)} ms of typing | ${rounded((arrivals.length - 1) / (drawing / 1_000))} frames/second`,
        notes: [
          `the same ${BURST_KEYS} keystrokes written back to back drew ${burstFrames} frame(s), so input arriving faster than the loop draws is coalesced rather than queued`,
          "a frame is the synchronized-update sequence the terminal received, timed at the arrival of the chunk carrying it",
          "the interval distribution is the cadence under continuous input, not an idle frame rate — an idle renderer draws nothing",
        ],
      });
    },
    MEASUREMENT_TIMEOUT_MS,
  );

  test(
    "shutdown latency",
    async () => {
      const toExit: number[] = [];
      const toLastByte: number[] = [];

      for (let sample = 0; sample < SHUTDOWN_SAMPLES; sample += 1) {
        using started = startOnPty([]);
        const { pty } = started;
        if ((await waitForBytes(pty, FRAME_START, MOUNT_MS * 2)) === -1) {
          unmeasured(
            "shutdown latency",
            "dist/falryn never drew, so there was nothing to shut down",
          );
        }
        await waitForQuiet(pty);

        const interruptedAt = Bun.nanoseconds();
        // The byte, not the signal: in raw mode this is Ctrl+C arriving as input
        // and leaving through the keymap, which is the way a user leaves.
        write(pty, [0x03]);
        const code = await Promise.race([
          started.process.exited,
          Bun.sleep(EXIT_MS).then(() => "timed-out" as const),
        ]);
        const exitedAt = Bun.nanoseconds();
        if (code !== EXIT_CODES.COMPLETED) {
          unmeasured(
            "shutdown latency",
            `the shell exited ${String(code)} rather than leaving cleanly`,
          );
        }
        toExit.push(exitedAt - interruptedAt);

        // The bytes written on the way out arrive after the process has gone,
        // and giving the terminal back is the last of them.
        await Bun.sleep(200);
        const lastAt = pty.arrivalOf(pty.transcript().length - 1);
        if (lastAt === null) {
          unmeasured("shutdown latency", "the terminal recorded no arrival for its last byte");
        }
        toLastByte.push(lastAt - interruptedAt);

        // The terminal was actually given back. A fast exit that left the
        // terminal in raw mode is not a shutdown, it is a shorter failure.
        for (const sequence of Object.values(RESTORED)) {
          expect(pty.transcript().includes(sequence)).toBe(true);
        }
      }

      const teardown: number[] = [];
      for (let sample = 0; sample < TEARDOWN_SAMPLES; sample += 1) {
        // The clock is read inside the block and the difference outside it, so
        // what is timed is the scope's own disposal — which is also the only way
        // to time teardown without holding a renderer the harness would no
        // longer be responsible for.
        let readyAt = 0;
        {
          using shell = await mount(<ShellApp theme={THEME} model={MODEL} onExit={() => {}} />, {
            shape: SHAPE,
            screenMode: "alternate-screen",
          });
          await shell.frame(AT_REST);
          readyAt = Bun.nanoseconds();
        }
        teardown.push(Bun.nanoseconds() - readyAt);
      }

      report({
        quantity: "shutdown latency",
        against: "dist/falryn on a pseudo-terminal, left through the keyboard",
        dataset: `${SHUTDOWN_SAMPLES} interrupts, one compiled process each`,
        state: "warm",
        result: formatDistribution(distribution(toExit)),
        notes: [
          `interrupt to the last byte the terminal received: ${formatDistribution(distribution(toLastByte))}`,
          `in-process teardown alone — React unmounted and the renderer destroyed, ${TEARDOWN_SAMPLES} cycles: ${formatDistribution(distribution(teardown))}`,
          "the process figure includes the shutdown phases and terminal restoration; the teardown figure is the renderer's share of it",
        ],
      });
    },
    MEASUREMENT_TIMEOUT_MS,
  );
});

// ── What did not run, and why ───────────────────────────────────────────────

describe.if(MEASURING && !compiledShellRunnable)("the shipped artifact's resource behavior", () => {
  test.skip(
    compiledArtifactBuilt
      ? "no pseudo-terminal is available on this platform, so startup, cadence, and shutdown were not measured"
      : "dist/falryn has not been built, so startup, cadence, and shutdown were not measured",
    () => {
      // Recorded as a skip rather than as an empty passing check. A green tick
      // beside a quantity nobody took is the failure this file exists to avoid.
    },
  );
});

describe.if(!MEASURING)("the shell's resource behavior", () => {
  test.skip("was not measured, because FALRYN_MEASURE is not set — run `bun run measure`", () => {
    // The gate, visible. An ordinary `bun test` reports this rather than
    // spending two minutes of everyone's day on numbers nobody asked for.
  });
});
