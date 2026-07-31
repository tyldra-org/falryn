import { describe, expect, test } from "bun:test";

import type { InterruptSignal } from "../domain/index.ts";
import { createProcessSignalPort, observedPlatformSignals } from "./process-signals.ts";

/** Bounds a hung subprocess. Not behavior timing — the test asserts on output, not elapsed time. */
const SUBPROCESS_TIMEOUT_MS = 10_000;

describe("platform mapping", () => {
  test("observes the interruption signals a process can actually handle", () => {
    expect([...observedPlatformSignals()]).toEqual(["SIGINT", "SIGTERM", "SIGHUP"]);
  });

  test("does not claim to handle SIGKILL", () => {
    expect(observedPlatformSignals()).not.toContain("SIGKILL");
  });
});

describe("subscription lifecycle", () => {
  test("installs a listener for every observed signal and removes them all", () => {
    const before = observedPlatformSignals().map((signal) => process.listenerCount(signal));

    const release = createProcessSignalPort().onInterrupt(() => {});
    const during = observedPlatformSignals().map((signal) => process.listenerCount(signal));
    expect(during).toEqual(before.map((count) => count + 1));

    release();
    expect(observedPlatformSignals().map((signal) => process.listenerCount(signal))).toEqual(
      before,
    );
  });

  test("releasing twice removes nothing extra", () => {
    const before = process.listenerCount("SIGINT");
    const release = createProcessSignalPort().onInterrupt(() => {});
    release();
    release();
    expect(process.listenerCount("SIGINT")).toBe(before);
  });

  test("two subscribers do not detach each other", () => {
    const port = createProcessSignalPort();
    const before = process.listenerCount("SIGINT");

    const first = port.onInterrupt(() => {});
    const second = port.onInterrupt(() => {});
    first();
    expect(process.listenerCount("SIGINT")).toBe(before + 1);

    second();
    expect(process.listenerCount("SIGINT")).toBe(before);
  });

  test("translates a platform signal into a Falryn signal", () => {
    const seen: InterruptSignal[] = [];
    const release = createProcessSignalPort().onInterrupt((signal) => seen.push(signal));

    process.emit("SIGHUP");
    release();

    expect(seen).toEqual(["hangup"]);
  });
});

describe("real process delivery", () => {
  test(
    "a subprocess receives SIGINT through the port",
    async () => {
      const moduleUrl = new URL("./process-signals.ts", import.meta.url).href;
      const script = [
        `import { createProcessSignalPort } from ${JSON.stringify(moduleUrl)};`,
        "const port = createProcessSignalPort();",
        'port.onInterrupt((signal) => { console.log("received:" + signal); process.exit(0); });',
        'console.log("ready");',
        // Keeps the subprocess alive until the signal arrives.
        "setInterval(() => {}, 1000);",
      ].join("\n");

      const child = Bun.spawn(["bun", "-e", script], { stdout: "pipe", stderr: "pipe" });
      const reader = child.stdout.getReader();
      const decoder = new TextDecoder();

      let output = "";
      while (!output.includes("ready")) {
        const chunk = await reader.read();
        if (chunk.done) {
          throw new Error(`subprocess exited before signalling readiness: ${output}`);
        }
        output += decoder.decode(chunk.value);
      }

      child.kill("SIGINT");

      while (!output.includes("received:")) {
        const chunk = await reader.read();
        if (chunk.done) {
          break;
        }
        output += decoder.decode(chunk.value);
      }

      await child.exited;
      expect(output).toContain("received:interrupt");
      expect(child.exitCode).toBe(0);
    },
    SUBPROCESS_TIMEOUT_MS,
  );
});
