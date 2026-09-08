/**
 * Owned-process shutdown participant: registration, termination, and unfinished
 * reports when trees will not stop.
 */

import { describe, expect, test } from "bun:test";

import { createShutdownCoordinator } from "../../application/runtime/shutdown-coordinator.ts";
import {
  createManualClock,
  createSystemClock,
  duration,
  instant,
} from "../../domain/foundation/index.ts";
import { MAX_COMMAND_OUTPUT_BYTES } from "../../domain/process/index.ts";
import { createHostCommandRunner } from "./host-commands.ts";
import {
  createOwnedProcessRegistry,
  OWNED_PROCESS_SHUTDOWN_PARTICIPANT,
} from "./host-owned-process-registry.ts";

const POSIX = process.platform !== "win32";
const platformTest = POSIX ? test : test.skip;
const SLEEP = "/bin/sleep";

describe("owned-process shutdown participant", () => {
  test("registers in terminate-children", () => {
    const bundle = createOwnedProcessRegistry();
    expect(bundle.shutdownParticipant).toMatchObject({
      name: OWNED_PROCESS_SHUTDOWN_PARTICIPANT,
      phase: "terminate-children",
    });
  });

  platformTest("stops an owned tree adopted through the command runner", async () => {
    const bundle = createOwnedProcessRegistry();
    const coordinator = createShutdownCoordinator({ clock: createSystemClock() });
    coordinator.register(bundle.shutdownParticipant);

    const runner = createHostCommandRunner({ ownedProcesses: bundle.registry });
    const controller = new AbortController();
    void runner.run({
      executable: SLEEP,
      argv: ["30"],
      environment: {},
      timeoutMs: duration(60_000),
      maxOutputBytes: MAX_COMMAND_OUTPUT_BYTES,
      signal: controller.signal,
    });
    await Bun.sleep(20);

    const report = await coordinator.shutdown({ level: "forced" });

    controller.abort();
    expect(report.unfinished).toEqual([]);
    expect(report.outcome).toEqual({ kind: "completed" });
  });

  test("finishes when nothing was adopted", async () => {
    const clock = createManualClock(instant(0));
    const bundle = createOwnedProcessRegistry();
    const coordinator = createShutdownCoordinator({ clock });
    coordinator.register(bundle.shutdownParticipant);

    const pending = coordinator.shutdown();
    await clock.runUntilIdle();
    const report = await pending;

    expect(report.unfinished).toEqual([]);
    expect(report.outcome).toEqual({ kind: "completed" });
  });

  test("reports unfinished when termination will not complete before the phase ends", async () => {
    const clock = createManualClock(instant(0));
    const coordinator = createShutdownCoordinator({ clock });
    coordinator.register({
      name: OWNED_PROCESS_SHUTDOWN_PARTICIPANT,
      phase: "terminate-children",
      run: () => new Promise<void>(() => {}),
    });

    const pending = coordinator.shutdown({ level: "forced" });
    await clock.runUntilIdle();
    const report = await pending;

    expect(report.unfinished).toContain(OWNED_PROCESS_SHUTDOWN_PARTICIPANT);
    expect(report.outcome).toEqual({ kind: "uncertain", effect: "uncertain" });
  });

  test("normal drain retains durable owners without interrupting and is idempotent", async () => {
    const bundle = createOwnedProcessRegistry();
    const finish = Promise.withResolvers<boolean>();
    let interrupts = 0;
    let drains = 0;
    const lifetime = {
      interrupt() {
        interrupts++;
      },
      drain() {
        drains++;
        return finish.promise;
      },
    };
    expect(bundle.registry.retain(lifetime)).toBe(true);
    const first = bundle.registry.drain();
    expect(bundle.registry.drain()).toBe(first);
    expect(bundle.registry.retain(lifetime)).toBe(false);
    expect(interrupts).toBe(0);
    expect(drains).toBe(1);
    finish.resolve(true);
    expect(await first).toBe(true);
  });

  test("shutdown interrupts retained owners and records failed durable settlement", async () => {
    const bundle = createOwnedProcessRegistry();
    const clock = createManualClock();
    const coordinator = createShutdownCoordinator({ clock });
    coordinator.register(bundle.shutdownParticipant);
    const finish = Promise.withResolvers<boolean>();
    let interrupted = false;
    bundle.registry.retain({
      interrupt() {
        interrupted = true;
        finish.resolve(false);
      },
      drain: () => finish.promise,
    });
    const shuttingDown = coordinator.shutdown();
    await clock.runUntilIdle();
    const report = await shuttingDown;
    expect(interrupted).toBe(true);
    expect(report.unfinished).toContain(OWNED_PROCESS_SHUTDOWN_PARTICIPANT);
    expect(await bundle.registry.drain()).toBe(false);
  });

  test("refuses durable owner capacity instead of evicting it", async () => {
    const bundle = createOwnedProcessRegistry();
    for (let index = 0; index < 64; index++)
      expect(bundle.registry.retain({ interrupt() {}, drain: async () => true })).toBe(true);
    expect(bundle.registry.retain({ interrupt() {}, drain: async () => true })).toBe(false);
    expect(await bundle.registry.drain()).toBe(true);
  });
});
