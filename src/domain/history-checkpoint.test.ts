/**
 * History checkpoint and overflow compact-retry tests.
 */

import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";

import { CONTENT_DIGEST_ALGORITHM, contentDigest } from "./artifact.ts";
import type { ContentHasherPort } from "./blob.ts";
import type { CompactModelPort } from "./compact-model.ts";
import {
  checkpointHistory,
  HISTORY_CHECKPOINT_VERSION,
  previewCompactForSmallerWindow,
  retryAfterOverflow,
} from "./history-checkpoint.ts";
import { eventId, historyCheckpointId } from "./identity.ts";
import { ok } from "./result.ts";

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

const requiredItems = [
  { id: "evt-commit", kind: "user-commitment", text: "ship the reducer", retained: true },
  { id: "evt-decision", kind: "decision", text: "keep hush separate" },
  { id: "evt-question", kind: "unresolved-question", text: "what is the token budget?" },
  { id: "evt-task", kind: "task-state", text: "in-progress #106" },
  { id: "evt-tool", kind: "tool-outcome", text: "tests failed" },
  { id: "evt-cite", kind: "citation", text: "design/CONTEXT-BRIEF-HUSH-AND-LOOM.md" },
  { id: "evt-art", kind: "artifact", text: "artifact:log-1" },
  { id: "evt-unc", kind: "uncertainty", text: "provider may be down" },
  { id: "evt-fix", kind: "correction", text: "the earlier exit code was wrong" },
  {
    id: "evt-skill",
    kind: "skill-instruction",
    text: "Always load git-workflow before mutating git.",
  },
];

describe("checkpointHistory", () => {
  test("preserves required items and does not rewrite the event log", () => {
    const prose = { id: "evt-prose", kind: "turn-prose", text: "long ".repeat(200).trim() };
    const port: CompactModelPort = {
      compact() {
        return ok({ kind: "lossy", text: "folded narration" });
      },
    };
    const result = checkpointHistory(
      { checkpointId: "chk-1", items: [...requiredItems, prose], compactUse: "evaluated" },
      hasher(),
      port,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.value.strategyVersion).toBe(HISTORY_CHECKPOINT_VERSION);
    expect(result.value.checkpointId).toBe(historyCheckpointId.from("chk-1"));
    expect(result.value.eventLogRewritten).toBe(false);
    expect(result.value.originalEventIds).toEqual([
      eventId.from("evt-commit"),
      eventId.from("evt-decision"),
      eventId.from("evt-question"),
      eventId.from("evt-task"),
      eventId.from("evt-tool"),
      eventId.from("evt-cite"),
      eventId.from("evt-art"),
      eventId.from("evt-unc"),
      eventId.from("evt-fix"),
      eventId.from("evt-skill"),
      eventId.from("evt-prose"),
    ]);
    expect(result.value.preserved.map((item) => item.kind)).toContain("skill-instruction");
    expect(result.value.preserved.map((item) => item.kind)).toContain("correction");
    expect(result.value.preserved.some((item) => item.kind === "skill-instruction")).toBe(true);
    const skill = result.value.preserved.find((item) => item.kind === "skill-instruction");
    expect(skill?.text).toBe("Always load git-workflow before mutating git.");
    expect(result.value.folded?.selectedStrategy).toBe("compact-model");
    expect(result.value.folded?.claimsExact).toBe(false);
    expect(result.value.folded?.text).toBe("folded narration");
    expect(result.value.expansions).toEqual([
      { eventId: eventId.from("evt-commit"), retained: true },
    ]);
  });

  test("does not fold skill instruction bodies into the summary", () => {
    const port: CompactModelPort = {
      compact(request) {
        expect(request.text).not.toContain("Always load git-workflow");
        return ok({ kind: "extractive", text: "narration only" });
      },
    };
    const result = checkpointHistory(
      {
        checkpointId: "chk-2",
        items: [
          ...requiredItems,
          { id: "evt-prose", kind: "turn-prose", text: "please compact this narration block now" },
        ],
        compactUse: "evaluated",
      },
      hasher(),
      port,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.value.folded?.text).toBe("narration only");
    expect(result.value.preserved.some((item) => item.text.includes("git-workflow"))).toBe(true);
  });
});

describe("retryAfterOverflow", () => {
  test("compacts once on prompt-too-long and refuses a second consecutive overflow", () => {
    const first = retryAfterOverflow(
      {
        checkpointId: "chk-overflow-1",
        items: requiredItems,
        consecutiveOverflows: 0,
        reason: "prompt-too-long",
      },
      hasher(),
      null,
    );
    expect(first.ok).toBe(true);
    if (!first.ok) {
      return;
    }
    expect(first.value.action).toBe("retry");
    expect(first.value.overflowRetries).toBe(1);
    expect(first.value.checkpoint.eventLogRewritten).toBe(false);

    const second = retryAfterOverflow(
      {
        checkpointId: "chk-overflow-2",
        items: requiredItems,
        consecutiveOverflows: 1,
        reason: "prompt-too-long",
      },
      hasher(),
      null,
    );
    expect(second).toEqual({
      ok: false,
      error: { kind: "compact", code: "overflow-exhausted", field: "consecutiveOverflows" },
    });
  });
});

describe("previewCompactForSmallerWindow", () => {
  test("previews only when the destination window is strictly smaller", () => {
    const preview = previewCompactForSmallerWindow(
      {
        checkpointId: "chk-window",
        items: requiredItems,
        fromWindowTokens: 8_000,
        toWindowTokens: 4_000,
      },
      hasher(),
      null,
    );
    expect(preview.ok).toBe(true);
    if (!preview.ok) {
      return;
    }
    expect(preview.value.eventLogRewritten).toBe(false);

    const equal = previewCompactForSmallerWindow(
      {
        checkpointId: "chk-window-eq",
        items: requiredItems,
        fromWindowTokens: 4_000,
        toWindowTokens: 4_000,
      },
      hasher(),
      null,
    );
    expect(equal.ok).toBe(false);
    if (equal.ok) {
      return;
    }
    expect(equal.error.code).toBe("unsupported");
  });
});
