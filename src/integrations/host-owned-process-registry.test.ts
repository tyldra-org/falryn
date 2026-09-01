/**
 * Owned-process shutdown participant: registration, termination, and unfinished
 * reports when trees will not stop.
 */

import { describe, expect, test } from "bun:test";

import { createShutdownCoordinator } from "../application/shutdown-coordinator.ts";
import {
  createManualClock,
  createSystemClock,
  duration,
  instant,
  MAX_COMMAND_OUTPUT_BYTES,
} from "../domain/index.ts";
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
});
