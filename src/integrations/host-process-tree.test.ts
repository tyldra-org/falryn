/**
 * Owned process-tree kill, against real POSIX grandchildren.
 *
 * A grandchild that ignores SIGHUP survives SIGTERM to the leader PID alone.
 * Escalation must still reap it. Windows has no process-group primitive here.
 */

import { describe, expect, test } from "bun:test";

import {
  escalateOwnedTree,
  ownedTreeSpawnOptions,
  processIsAlive,
  signalOwnedTree,
} from "./host-process-tree.ts";

const POSIX = process.platform !== "win32";
const platformTest = POSIX ? test : test.skip;
const GRANDCHILD = '/bin/sh -c "trap \\"\\" HUP; exec /bin/sleep 30" & echo $!; wait';

describe("owned process-tree escalation", () => {
  platformTest("reaps a grandchild that survives leader-only SIGTERM", async () => {
    const child = Bun.spawn(["/bin/sh", "-c", GRANDCHILD], {
      ...ownedTreeSpawnOptions(),
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const pid = child.pid;
    expect(typeof pid).toBe("number");
    if (typeof pid !== "number") {
      throw new Error("expected a leader pid");
    }
    void drain(child.stderr);
    try {
      const grandchildPid = Number.parseInt(await readFirstLine(child.stdout), 10);
      expect(Number.isSafeInteger(grandchildPid) && grandchildPid > 1).toBe(true);
      expect(processIsAlive(grandchildPid)).toBe(true);

      process.kill(pid, "SIGTERM");
      await Bun.sleep(150);
      expect(processIsAlive(grandchildPid)).toBe(true);

      const cleanup = await escalateOwnedTree({ pid, exited: child.exited });
      await waitUntilDead(grandchildPid);
      expect(processIsAlive(pid)).toBe(false);
      expect(cleanup.certainty).toBe("reaped");
      expect(["terminate", "kill"]).toContain(cleanup.stage);
    } finally {
      if (processIsAlive(pid)) {
        await escalateOwnedTree({ pid, exited: child.exited });
      }
    }
  });

  platformTest("refuses to signal pid 1 or Falryn itself", () => {
    signalOwnedTree(1, "SIGKILL");
    signalOwnedTree(process.pid, "SIGKILL");
    expect(processIsAlive(process.pid)).toBe(true);
  });
});

async function waitUntilDead(pid: number, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!processIsAlive(pid)) {
      return;
    }
    await Bun.sleep(20);
  }
  expect(processIsAlive(pid)).toBe(false);
}

async function readFirstLine(stream: ReadableStream<Uint8Array> | undefined): Promise<string> {
  if (stream === undefined) {
    return "";
  }
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let text = "";
  try {
    while (!text.includes("\n")) {
      const { value, done } = await reader.read();
      if (done) {
        break;
      }
      text += decoder.decode(value, { stream: true });
    }
  } finally {
    reader.releaseLock();
  }
  return text.trim().split("\n")[0] ?? "";
}

async function drain(stream: ReadableStream<Uint8Array> | undefined): Promise<void> {
  if (stream === undefined) {
    return;
  }
  const reader = stream.getReader();
  try {
    while (true) {
      const { done } = await reader.read();
      if (done) {
        return;
      }
    }
  } finally {
    reader.releaseLock();
  }
}
