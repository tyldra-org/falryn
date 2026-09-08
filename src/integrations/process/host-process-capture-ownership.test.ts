import { describe, expect, test } from "bun:test";
import { duration } from "../../domain/foundation/index.ts";
import type { ProcessCaptureOwnership } from "../../domain/process/process-capture.ts";
import { createHostProcessCapturePort } from "./host-process-capture.ts";
import { createHostProcessIdentityPort } from "./host-process-identity.ts";

const ownedTest = process.platform === "linux" || process.platform === "darwin" ? test : test.skip;
const command = {
  executable: "/bin/sh",
  argv: ["-c", "printf ready; exec sleep 30"],
  environment: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
  timeoutMs: duration(5_000),
  maxOutputBytes: 65_536,
};

describe("capture ownership on the existing launcher", () => {
  test.skipIf(process.platform !== "win32")(
    "Windows refuses owned capture before spawn",
    async () => {
      let started = false;
      const capture = createHostProcessCapturePort();
      expect(capture.supportsOwnership).toBe(false);
      const result = await capture.run({
        ...command,
        ownership: {
          async started() {
            started = true;
          },
          async event() {},
        },
      });
      expect(result).toMatchObject({ ok: false, error: { code: "ownership-unavailable" } });
      expect(started).toBe(false);
    },
  );

  ownedTest(
    "leader exit cannot leave a redirected descendant behind a successful capture",
    async () => {
      const result = await createHostProcessCapturePort().run({
        ...command,
        argv: ["-c", "sleep 30 >/dev/null 2>&1 & printf %s $!"],
        ownership: { async started() {}, async event() {} },
      });
      if (!result.ok) throw new Error("capture unavailable");
      expect(result.value.stop).toEqual({
        kind: "uncertain",
        reason: "owned-descendants-remained",
      });
      const descendant = Number(result.value.stdout.inlineText);
      expect(descendant).toBeGreaterThan(1);
      if (result.value.killStage !== "unconfirmed")
        expect((await createHostProcessIdentityPort().inspect(descendant)).kind).toBe("vanished");
      expect(result.value.killStage).not.toBe("none");
    },
  );
  ownedTest(
    "returns a birth-bound control for the same capture and persists chunks without report duplication",
    async () => {
      const started = Promise.withResolvers<Parameters<ProcessCaptureOwnership["started"]>[0]>();
      const output = Promise.withResolvers<void>();
      const seen: number[] = [];
      const captured = createHostProcessCapturePort().run({
        ...command,
        retainChunkEvents: false,
        ownership: {
          async started(handle) {
            started.resolve(handle);
          },
          async event(event) {
            if (event.kind === "started") seen.push(event.pid);
            if (event.kind === "chunk") output.resolve();
          },
        },
      });
      const handle = await started.promise;
      try {
        await output.promise;
        expect(seen).toEqual([handle.identity.pid]);
        expect(await handle.stop(true, () => false)).toBe("unavailable");
        expect((await createHostProcessIdentityPort().inspect(handle.identity.pid)).kind).toBe(
          "present",
        );
        expect(await handle.stop(true)).toBe("requested");
        const result = await captured;
        expect(result.ok).toBe(true);
        if (!result.ok) throw new Error("capture failed");
        expect(result.value.pid).toBe(handle.identity.pid);
        expect(result.value.stop.kind).toBe("cancelled");
        expect(result.value.killStage).toBe("kill");
        expect(result.value.stdout.inlineText).toBe("ready");
        expect(result.value.events.some((event) => event.kind === "chunk")).toBe(false);
        expect(await handle.stop(true)).toBe("unavailable");
      } finally {
        await handle.stop(true);
        await captured;
      }
    },
  );

  ownedTest(
    "a failed durable start commit stops the owned process rather than returning live authority",
    async () => {
      let pid = 0;
      const result = await createHostProcessCapturePort().run({
        ...command,
        ownership: {
          async started(handle) {
            pid = handle.identity.pid;
            throw new Error("storage unavailable");
          },
          async event() {},
        },
      });
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("capture failed");
      expect(result.value.stop).toEqual({ kind: "uncertain", reason: "owner-persistence-failed" });
      expect((await createHostProcessIdentityPort().inspect(pid)).kind).toBe("vanished");
    },
  );

  ownedTest("failed durable chunk capture stops output and records uncertainty", async () => {
    const result = await createHostProcessCapturePort().run({
      ...command,
      ownership: {
        async started() {},
        async event(event) {
          if (event.kind === "chunk") throw new Error("artifact unavailable");
        },
      },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("capture failed");
    expect(result.value.stop).toEqual({ kind: "uncertain", reason: "owner-persistence-failed" });
  });

  ownedTest("cancellation cannot conceal a pending durable chunk failure", async () => {
    const pending = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const cancel = new AbortController();
    const captured = createHostProcessCapturePort().run({
      ...command,
      signal: cancel.signal,
      ownership: {
        async started() {},
        async event(event) {
          if (event.kind !== "chunk") return;
          pending.resolve();
          await release.promise;
          throw new Error("artifact unavailable");
        },
      },
    });
    try {
      await pending.promise;
      cancel.abort();
      release.resolve();
      const result = await captured;
      if (!result.ok) throw new Error("capture failed");
      expect(result.value.stop).toEqual({ kind: "uncertain", reason: "owner-persistence-failed" });
    } finally {
      cancel.abort();
      release.resolve();
      await captured;
    }
  });

  ownedTest("fast commands still bind their original child before terminal capture", async () => {
    const capture = createHostProcessCapturePort();
    for (let count = 0; count < 10; count++) {
      let bound = false;
      const result = await capture.run({
        ...command,
        argv: ["-c", "printf ready"],
        ownership: {
          async started() {
            bound = true;
          },
          async event() {},
        },
      });
      expect(bound).toBe(true);
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("capture failed");
      expect(result.value.stop.kind).toBe("exited");
      expect(result.value.exit.exitCode).toBe(0);
    }
  });
});
