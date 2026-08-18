/**
 * Optional compact-model lane tests.
 */

import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";

import { CONTENT_DIGEST_ALGORITHM, contentDigest } from "./artifact.ts";
import type { ContentHasherPort } from "./blob.ts";
import {
  COMPACT_MODEL_VERSION,
  type CompactModelPort,
  describeCompactError,
  reduceCompact,
} from "./compact-model.ts";
import { err, ok } from "./result.ts";

const HARD_LIMIT_PROBE = 64 * 1_024 + 1;

function hasher(): ContentHasherPort {
  return {
    create() {
      const hash = createHash("sha256");
      return {
        update(chunk) {
          hash.update(chunk);
        },
        digest() {
          return contentDigest.from(`${CONTENT_DIGEST_ALGORITHM}:${hash.digest("hex")}`);
        },
      };
    },
  };
}

function longProse(): string {
  return "alpha ".repeat(400).trim();
}

function countingPort(
  kind: "extractive" | "lossy",
  text: string,
  calls: { count: number },
): CompactModelPort {
  return {
    compact() {
      calls.count += 1;
      return ok({ kind, text });
    },
  };
}

describe("reduceCompact", () => {
  test("extractive compact-model projection never claims exact-source", () => {
    const source = longProse();
    const calls = { count: 0 };
    const port = countingPort("extractive", "kept facts", calls);
    const result = reduceCompact({ text: source, compactUse: "evaluated" }, hasher(), port);
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.value.strategyVersion).toBe(COMPACT_MODEL_VERSION);
    expect(result.value.selectedStrategy).toBe("compact-model");
    expect(result.value.fallbackDestination).toBeNull();
    expect(result.value.evidenceFidelity).toBe("extractive-summary");
    expect(result.value.claimsExact).toBe(false);
    expect(result.value.complete).toBe(false);
    expect(result.value.text).toBe("kept facts");
    expect(result.value.modelCalls).toBe(1);
    expect(calls.count).toBe(1);
    expect(result.value.expansion?.kind).toBe("inline");
  });

  test("lossy synthesis is labeled and keeps an expansion handle", () => {
    const calls = { count: 0 };
    const result = reduceCompact(
      { text: longProse(), compactUse: "evaluated", question: "what broke?" },
      hasher(),
      countingPort("lossy", "the build failed on types", calls),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.value.modelKind).toBe("lossy");
    expect(result.value.evidenceFidelity).toBe("lossy-synthesis");
    expect(result.value.claimsExact).toBe(false);
    expect(result.value.expansion).not.toBeNull();
  });

  test("off disables the model and falls back without a second call", () => {
    const calls = { count: 0 };
    const source = "short original";
    const result = reduceCompact(
      { text: source, compactUse: "off" },
      hasher(),
      countingPort("lossy", "should-not-run", calls),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.value.selectedStrategy).toBe("passthrough");
    expect(result.value.fallbackDestination).toBe("passthrough");
    expect(result.value.fallbackReason).toBe("disabled");
    expect(result.value.claimsExact).toBe(true);
    expect(result.value.evidenceFidelity).toBe("exact-source");
    expect(result.value.text).toBe(source);
    expect(result.value.modelCalls).toBe(0);
    expect(calls.count).toBe(0);
  });

  test("unavailable, malformed, timeout, and no-savings fall back once", () => {
    const source = longProse();
    const unavailable = reduceCompact({ text: source, compactUse: "evaluated" }, hasher(), null);
    expect(unavailable.ok && unavailable.value.fallbackReason).toBe("unavailable");
    expect(unavailable.ok && unavailable.value.modelCalls).toBe(0);

    const failing: CompactModelPort = {
      compact() {
        return err({ code: "timed-out" });
      },
    };
    const timed = reduceCompact({ text: source, compactUse: "evaluated" }, hasher(), failing);
    expect(timed.ok && timed.value.fallbackReason).toBe("timed-out");
    expect(timed.ok && timed.value.fallbackDestination).toBe("passthrough");
    expect(timed.ok && timed.value.selectedStrategy).toBe("passthrough");

    const calls = { count: 0 };
    const noSavings = reduceCompact(
      { text: "tiny", compactUse: "evaluated" },
      hasher(),
      countingPort("extractive", "tiny and more", calls),
    );
    expect(noSavings.ok && noSavings.value.fallbackReason).toBe("no-savings");
    expect(calls.count).toBe(1);

    const malformed: CompactModelPort = {
      compact() {
        return err({ code: "malformed" });
      },
    };
    const bad = reduceCompact({ text: source, compactUse: "evaluated" }, hasher(), malformed);
    expect(bad.ok && bad.value.fallbackReason).toBe("malformed");
  });

  test("fallback cannot recurse into the compact model", () => {
    let calls = 0;
    const port: CompactModelPort = {
      compact() {
        calls += 1;
        return err({ code: "unavailable" });
      },
    };
    const result = reduceCompact({ text: longProse(), compactUse: "evaluated" }, hasher(), port);
    expect(result.ok).toBe(true);
    expect(calls).toBe(1);
    if (!result.ok) {
      return;
    }
    expect(result.value.modelCalls).toBe(0);
    expect(result.value.fallbackDestination).toBe("passthrough");
  });

  test("cancelled and restricted input fail closed", () => {
    const cancelled = reduceCompact(
      { text: longProse(), cancelled: true },
      hasher(),
      countingPort("lossy", "nope", { count: 0 }),
    );
    expect(cancelled).toEqual({
      ok: false,
      error: { kind: "compact", code: "cancelled", field: "signal" },
    });

    const modelCancel: CompactModelPort = {
      compact() {
        return err({ code: "cancelled" });
      },
    };
    const fromModel = reduceCompact({ text: longProse() }, hasher(), modelCancel);
    expect(fromModel.ok).toBe(false);
    if (fromModel.ok) {
      return;
    }
    expect(fromModel.error.code).toBe("cancelled");
    expect(describeCompactError(fromModel.error)).toBe("cancelled model");

    const secret = reduceCompact(
      { text: longProse(), sensitivity: "restricted" },
      hasher(),
      countingPort("lossy", "nope", { count: 0 }),
    );
    expect(secret.ok).toBe(false);
    if (secret.ok) {
      return;
    }
    expect(secret.error.code).toBe("secret");
  });

  test("empty, NUL, and oversized input are refused", () => {
    expect(reduceCompact({ text: "" }, hasher(), null)).toEqual({
      ok: false,
      error: { kind: "compact", code: "empty", field: "text" },
    });
    expect(reduceCompact({ text: "a\0b" }, hasher(), null)).toEqual({
      ok: false,
      error: { kind: "compact", code: "malformed", field: "text" },
    });
    const huge = "x".repeat(HARD_LIMIT_PROBE);
    expect(reduceCompact({ text: huge }, hasher(), null).ok).toBe(false);
  });
});
