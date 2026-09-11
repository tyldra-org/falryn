import { afterEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { removeTemporaryRoots, temporaryRoot } from "../../data/fixtures.ts";
import { canonicalDigest } from "../../domain/extensions/canonical.ts";
import {
  initialHealthResult,
  PACKAGE_TOOL_PROTOCOL,
  type PackageHealthRecord,
} from "../../domain/extensions/package-health.ts";
import { createHostSandbox } from "../security/host-sandbox.ts";
import { createHostPackageProcess } from "./host-package-health.ts";
import { nativeHealthFixture } from "./package-health-fixtures.ts";

afterEach(removeTemporaryRoots);
for (const mode of [
  "healthy",
  "hostile",
  "forged",
  "wrong-binding",
  "flood",
  "timeout",
  "invalid-output",
  "stale",
  "cancel",
] as const) {
  test.skipIf(createHostSandbox().probe().status !== "available")(
    `native tool supervised result: ${mode}`,
    async () => {
      const root = await temporaryRoot("falryn-native-tool-");
      const fixture = await nativeHealthFixture(root, mode, "", true);
      const digest = canonicalDigest(mode);
      const initial: PackageHealthRecord = {
        operation: randomUUID(),
        fingerprint: digest,
        revision: 1,
        packageId: "fixture",
        birth: null,
        directory: null,
        result: initialHealthResult({
          protocol: PACKAGE_TOOL_PROTOCOL,
          attempt: randomUUID(),
          package: digest,
          contribution: digest,
          generation: digest,
        }),
      };
      const stopped = new AbortController();
      let checks = 0;
      const result = await createHostPackageProcess({
        directory: join(root, "attempts"),
        policy: () => ({ mode: "strict", generation: 1 }),
      }).run({
        record: initial,
        snapshot: {
          sourceId: "fixture",
          files: [{ path: "health-peer", bytes: fixture.bytes }],
          diagnostics: [],
          omittedDiagnostics: 0,
        },
        declaration: fixture.declaration,
        signal: stopped.signal,
        resourceTaskId: "native-tool-test",
        expiresAt: Date.now() + 10_000,
        catalogGeneration: 1,
        confirmation: digest,
        current: async () => mode !== "stale" || ++checks < 3,
        save: (record) => {
          if (mode === "cancel" && record.birth) stopped.abort();
        },
        invocation: {
          input: { question: "answer" },
          validateOutput: (value) =>
            mode !== "invalid-output" && JSON.stringify(value) === '{"answer":42}',
        },
      });
      expect(result.result.terminated).toBe(true);
      expect(result.result.cleanup).toBe("removed");
      if (mode === "healthy" || mode === "hostile")
        expect(result.result).toMatchObject({
          state: "completed",
          requests: 3,
          value: { answer: 42 },
        });
      else {
        expect(result.result.state).toBe("failed");
        expect(result.result.value).toBeUndefined();
      }
      if (result.result.pid) expect(() => process.kill(result.result.pid ?? 0, 0)).toThrow();
    },
    10_000,
  );
}
