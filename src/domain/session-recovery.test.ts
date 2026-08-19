/**
 * Session recovery: export, import, backup, inspect, restore, diagnostics.
 */

import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";

import { backupName } from "./backup.ts";
import { sessionId } from "./identity.ts";
import {
  describeSessionRecoveryError,
  planSessionRecovery,
  SESSION_RECOVERY_KINDS,
  SESSION_RECOVERY_SOURCE,
  SESSION_RECOVERY_VERSION,
  sessionRecoveryConfirmationRequest,
} from "./session-recovery.ts";

describe("planSessionRecovery", () => {
  test("plans an export selection from session ids", () => {
    const result = planSessionRecovery({
      kind: "export",
      sessionIds: ["alpha", "beta"],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.value.kind).toBe("export");
    if (result.value.kind !== "export") {
      return;
    }
    expect(result.value.selection).toEqual({
      kind: "sessions",
      sessionIds: [sessionId.from("alpha"), sessionId.from("beta")],
      includeSensitive: false,
    });
    expect(result.value.intentFingerprint).toBe("export:alpha,beta");
    expect(result.value.provenance).toEqual({
      version: SESSION_RECOVERY_VERSION,
      source: SESSION_RECOVERY_SOURCE,
      model: null,
    });
  });

  test("refuses import until the package is verified", () => {
    const unverified = planSessionRecovery({
      kind: "import",
      packageName: "portable",
      verified: false,
    });
    expect(unverified.ok).toBe(false);
    if (!unverified.ok) {
      expect(unverified.error.code).toBe("not-verified");
    }
    const verified = planSessionRecovery({
      kind: "import",
      packageName: "portable",
      verified: true,
    });
    expect(verified.ok).toBe(true);
    if (verified.ok) {
      expect(verified.value.kind).toBe("import");
      if (verified.value.kind === "import") {
        expect(verified.value.verified).toBe(true);
      }
    }
  });

  test("plans backup and inspect interactions from a legal name", () => {
    const backup = planSessionRecovery({ kind: "backup", name: "before-reset" });
    expect(backup.ok).toBe(true);
    const inspect = planSessionRecovery({ kind: "inspect-backup", name: "before-reset" });
    expect(inspect.ok).toBe(true);
    if (inspect.ok) {
      expect(inspect.value.kind).toBe("inspect-backup");
    }
  });

  test("restore requires a closed live store and an exact confirmation", () => {
    const request = sessionRecoveryConfirmationRequest(backupName.from("before-reset"));
    const open = planSessionRecovery({
      kind: "restore-backup",
      name: "before-reset",
      liveStoreClosed: false,
      confirmation: { confirmationId: request.confirmationId },
    });
    expect(open.ok).toBe(false);
    if (!open.ok) {
      expect(open.error.code).toBe("live-store-open");
    }
    const missing = planSessionRecovery({
      kind: "restore-backup",
      name: "before-reset",
      liveStoreClosed: true,
    });
    expect(missing.ok).toBe(false);
    if (!missing.ok) {
      expect(missing.error.code).toBe("unconfirmed");
    }
    const mismatch = planSessionRecovery({
      kind: "restore-backup",
      name: "before-reset",
      liveStoreClosed: true,
      confirmation: { confirmationId: "wrong" },
    });
    expect(mismatch.ok).toBe(false);
    if (!mismatch.ok) {
      expect(mismatch.error.code).toBe("confirmation-mismatch");
    }
    const restored = planSessionRecovery({
      kind: "restore-backup",
      name: "before-reset",
      liveStoreClosed: true,
      confirmation: { confirmationId: request.confirmationId },
    });
    expect(restored.ok).toBe(true);
    if (restored.ok) {
      expect(restored.value.kind).toBe("restore-backup");
    }
  });

  test("plans local diagnostics without side effects", () => {
    const result = planSessionRecovery({ kind: "diagnostics" });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.kind).toBe("diagnostics");
      expect(result.value.intentFingerprint).toBe("diagnostics");
    }
  });

  test("refuses an empty export selection", () => {
    const result = planSessionRecovery({ kind: "export", sessionIds: [] });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("empty");
    }
  });

  test("treats cancellation as cancelled, not as an empty plan", () => {
    const result = planSessionRecovery({ kind: "diagnostics" }, AbortSignal.abort());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("cancelled");
    }
  });

  test("describes every error code", () => {
    for (const code of [
      "cancelled",
      "confirmation-mismatch",
      "empty",
      "live-store-open",
      "malformed",
      "not-found",
      "not-verified",
      "oversized",
      "unconfirmed",
    ] as const) {
      expect(
        describeSessionRecoveryError({ kind: "session-recovery", code, field: "x" }),
      ).toContain("x");
    }
  });

  test("covers every interaction kind", () => {
    expect(SESSION_RECOVERY_KINDS).toHaveLength(6);
  });

  test("never names a command runner, provider, filesystem, or mutation", async () => {
    const source = await readFile(new URL("./session-recovery.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(
      /CommandRunnerPort|ProviderPort|GitPort|FileSystemPort|Bun\.spawn|child_process|fetch\(|git add|git commit/,
    );
  });
});
