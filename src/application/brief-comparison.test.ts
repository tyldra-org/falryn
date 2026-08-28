import { describe, expect, test } from "bun:test";

import { ok } from "../domain/index.ts";
import {
  CAVEMAN_PINNED_COMMIT,
  CAVEMAN_PINNED_SKILL_DIGEST,
  loadPinnedCavemanPolicy,
} from "./brief-comparison.ts";

const pinnedContent = "pinned";

describe("loadPinnedCavemanPolicy", () => {
  test("fails closed when pinned content drifts", async () => {
    const result = await loadPinnedCavemanPolicy(
      {
        read: async () => ok({ commit: CAVEMAN_PINNED_COMMIT, content: pinnedContent }),
      },
      "full",
    );
    expect(result).toEqual({
      ok: false,
      error: {
        code: "baseline-drift",
        detail: `expected ${CAVEMAN_PINNED_COMMIT}:${CAVEMAN_PINNED_SKILL_DIGEST}`,
      },
    });
  });

  test("rejects unsupported intensity before reading the source", async () => {
    let reads = 0;
    const result = await loadPinnedCavemanPolicy(
      {
        read: async () => {
          reads += 1;
          return ok({ commit: CAVEMAN_PINNED_COMMIT, content: pinnedContent });
        },
      },
      "maximum",
    );
    expect(result).toMatchObject({ ok: false, error: { code: "unsupported-intensity" } });
    expect(reads).toBe(0);
  });
});
