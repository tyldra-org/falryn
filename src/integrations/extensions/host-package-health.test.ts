import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalDigest } from "../../domain/extensions/canonical.ts";
import {
  initialHealthResult,
  PACKAGE_HEALTH_PROTOCOL,
  type PackageHealthRecord,
} from "../../domain/extensions/package-health.ts";
import { createHostProcessIdentityPort } from "../process/host-process-identity.ts";
import { createHostSandbox } from "../security/host-sandbox.ts";
import { createHostPackageHealth, validateHealthExecutable } from "./host-package-health.ts";
import { nativeHealthFixture } from "./package-health-fixtures.ts";

const qualified = createHostSandbox().probe().status === "available";
test("native health rejects unknown executable formats without execution", () => {
  expect(validateHealthExecutable(new TextEncoder().encode("#!/bin/sh\necho unsafe"))).toBe(
    "native-format-unavailable",
  );
});
for (const mode of [
  "healthy",
  "hostile",
  "forged",
  "wrong-binding",
  "flood",
  "crash",
  "timeout",
  "cancel",
  "stale",
] as const) {
  test.skipIf(!qualified)(
    `governed native package health: ${mode}`,
    async () => {
      const root = await mkdtemp(join(tmpdir(), "falryn-health-"));
      try {
        await mkdir(join(root, "attempts"));
        const secret = join(root, "outside-secret");
        await writeFile(secret, "PRIVATE-CONTENT");
        const fixture = await nativeHealthFixture(root, mode, secret);
        if (mode === "hostile") {
          const control = Bun.spawnSync([join(root, "health-peer"), "control", secret], {
            cwd: root,
            env: { FALRYN_HEALTH_SECRET: "positive-control" },
            stdout: "pipe",
            stderr: "pipe",
            timeout: 5000,
          });
          expect(control.exitCode).toBe(0);
          expect(new TextDecoder().decode(control.stdout)).toBe("31");
          await rm(join(root, "write-escape"));
        }
        const controller = new AbortController();
        let checks = 0;
        const digest = canonicalDigest({ fixture: mode });
        let record: PackageHealthRecord = {
          operation: randomUUID(),
          packageId: "fixture",
          fingerprint: digest,
          revision: 1,
          birth: null,
          directory: null,
          result: initialHealthResult({
            protocol: PACKAGE_HEALTH_PROTOCOL,
            attempt: randomUUID(),
            package: digest,
            contribution: digest,
            generation: digest,
          }),
        };
        const result = await createHostPackageHealth({
          directory: join(root, "attempts"),
          policy: () => ({ mode: "strict", generation: 1 }),
        }).run({
          record,
          declaration: fixture.declaration,
          snapshot: {
            sourceId: "fixture",
            files: [{ path: "health-peer", bytes: fixture.bytes }],
            diagnostics: [],
            omittedDiagnostics: 0,
          },
          signal: controller.signal,
          resourceTaskId: "health-test",
          expiresAt: Date.now() + 30_000,
          catalogGeneration: 7,
          confirmation: digest,
          current: async () => mode !== "stale" || ++checks < 3,
          save(next) {
            expect(next.revision).toBe(record.revision + 1);
            record = next;
            if (mode === "cancel" && next.birth) controller.abort();
          },
        });
        expect(result.result.terminated).toBe(true);
        expect(result.result.cleanup).toBe("removed");
        if (mode === "healthy" || mode === "hostile") {
          expect(result.result).toMatchObject({
            state: "healthy",
            requests: 4,
            code: "health-completed",
          });
          expect(result.result.sandbox?.effectiveMode).toBe("strict");
          expect(result.result.sandbox?.catalogGeneration).toBe(7);
          expect(result.result.sandbox?.confirmationId).toBe(digest);
        } else {
          expect(result.result.state).toBe("failed");
          expect(result.result.pid).not.toBeNull();
          expect(
            {
              forged: ["health-protocol-malformed"],
              "wrong-binding": ["health-protocol-forgery"],
              cancel: ["cancelled"],
              stale: ["stale-health-authority"],
              flood: ["health-frame-exhausted", "health-output-exhausted"],
              crash: ["health-birth-unavailable", "health-child-crashed"],
              timeout: ["health-request-timeout"],
            }[mode],
          ).toContain(result.result.code);
        }
        expect(JSON.stringify(result.result)).not.toContain("PRIVATE-CONTENT");
        expect(await readFile(secret, "utf8")).toBe("PRIVATE-CONTENT");
        if (result.result.pid !== null)
          expect(() => process.kill(result.result.pid ?? 0, 0)).toThrow();
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
    10_000,
  );
}

test.skipIf(!qualified)(
  "recovery stops a birth-identified live child and refuses an unidentified launch",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "falryn-health-recovery-"));
    let child: ReturnType<typeof Bun.spawn> | null = null;
    try {
      await nativeHealthFixture(root, "timeout");
      child = Bun.spawn([join(root, "health-peer"), "timeout"], {
        stdin: "ignore",
        stdout: "ignore",
        stderr: "ignore",
      });
      const identity = await createHostProcessIdentityPort().inspect(child.pid);
      if (identity.kind !== "present") throw new Error("fixture birth unavailable");
      const digest = canonicalDigest("recovery-fixture");
      const record: PackageHealthRecord = {
        operation: randomUUID(),
        packageId: "fixture",
        fingerprint: digest,
        revision: 1,
        directory: null,
        birth: identity.identity,
        result: {
          ...initialHealthResult({
            protocol: PACKAGE_HEALTH_PROTOCOL,
            attempt: randomUUID(),
            package: digest,
            contribution: digest,
            generation: digest,
          }),
          state: "uncertain",
          pid: child.pid,
        },
      };
      const owner = createHostPackageHealth({
        directory: join(root, "attempts"),
        policy: () => ({ mode: "strict", generation: 1 }),
      });
      const unknown = await owner.recover({ ...record, birth: null }, new AbortController().signal);
      expect(unknown.result).toMatchObject({ terminated: false, code: "health-recovery-unknown" });
      expect(child.exitCode).toBeNull();
      const recovered = await owner.recover(record, new AbortController().signal);
      expect(recovered.result).toMatchObject({
        terminated: true,
        state: "recovered",
        code: "health-recovered",
      });
      await child.exited;
      expect(() => process.kill(record.result.pid ?? 0, 0)).toThrow();
    } finally {
      if (child && child.exitCode === null) {
        child.kill();
        await child.exited;
      }
      await rm(root, { recursive: true, force: true });
    }
  },
  10_000,
);

test("recovery never removes an unowned path or reports its cleanup complete", async () => {
  const root = await mkdtemp(join(tmpdir(), "falryn-health-unowned-"));
  try {
    const secret = join(root, "unrelated");
    await writeFile(secret, "keep");
    const digest = canonicalDigest("cleanup-fixture");
    const record: PackageHealthRecord = {
      operation: randomUUID(),
      packageId: "fixture",
      fingerprint: digest,
      revision: 1,
      directory: secret,
      birth: null,
      result: {
        ...initialHealthResult({
          protocol: PACKAGE_HEALTH_PROTOCOL,
          attempt: randomUUID(),
          package: digest,
          contribution: digest,
          generation: digest,
        }),
        state: "failed",
        terminated: true,
        cleanup: "unknown",
      },
    };
    const owner = createHostPackageHealth({
      directory: join(root, "attempts"),
      policy: () => ({ mode: "strict", generation: 1 }),
    });
    expect((await owner.recover(record, new AbortController().signal)).result).toMatchObject({
      state: "failed",
      code: "health-files-unknown",
      terminated: true,
      cleanup: "unknown",
    });
    expect(await readFile(secret, "utf8")).toBe("keep");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
