import { describe, expect, test } from "bun:test";

import {
  DEFAULT_MAX_WRITE_TARGETS,
  describeWorkspaceWriteError,
  encodeWriteText,
  HARD_MAX_WRITE_TARGETS,
  parseWorkspaceWritePlan,
} from "./workspace-write.ts";

describe("encodeWriteText", () => {
  test("applies lf, crlf, and preserve without mixing policies", () => {
    expect(encodeWriteText("a\r\nb\nc", "lf")).toBe("a\nb\nc");
    expect(encodeWriteText("a\nb\n", "crlf")).toBe("a\r\nb\r\n");
    expect(encodeWriteText("a\r\nb", "preserve")).toBe("a\r\nb");
  });
});

describe("parseWorkspaceWritePlan", () => {
  test("defaults to fail-before-effect and preserve newlines", () => {
    const parsed = parseWorkspaceWritePlan({
      targets: [{ kind: "create", path: "src/a.ts", text: "hello\n" }],
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) {
      throw new Error("expected plan");
    }
    expect(parsed.value.policy).toBe("fail-before-effect");
    expect(parsed.value.targets).toHaveLength(1);
    expect(parsed.value.targets[0]?.newline).toBe("preserve");
    expect(parsed.value.limits.maxTargets).toBe(DEFAULT_MAX_WRITE_TARGETS);
  });

  test("rejects a NUL in text without echoing the secret", () => {
    const parsed = parseWorkspaceWritePlan({
      targets: [{ kind: "create", path: "secret.txt", text: "sk-live-SECRET\0" }],
    });
    expect(parsed).toEqual({ ok: false, error: { code: "malformed-text" } });
    expect(JSON.stringify(parsed)).not.toContain("sk-live-SECRET");
  });

  test("rejects overlapping and case-colliding targets", () => {
    expect(
      parseWorkspaceWritePlan({
        targets: [
          { kind: "create", path: "src/a.ts", text: "a" },
          { kind: "replace", path: "src/a.ts", text: "b" },
        ],
      }),
    ).toEqual({ ok: false, error: { code: "overlapping-targets", reason: "duplicate" } });
    expect(
      parseWorkspaceWritePlan({
        targets: [
          { kind: "create", path: "src/A.ts", text: "a" },
          { kind: "create", path: "src/a.ts", text: "b" },
        ],
      }),
    ).toEqual({ ok: false, error: { code: "overlapping-targets", reason: "case-collision" } });
  });

  test("rejects malformed kinds, policies, limits, and oversize text", () => {
    expect(
      parseWorkspaceWritePlan({
        targets: [{ kind: "patch", path: "a.ts", text: "x" }],
      }),
    ).toEqual({ ok: false, error: { code: "malformed-kind" } });
    expect(
      parseWorkspaceWritePlan({
        policy: "atomic",
        targets: [{ kind: "create", path: "a.ts", text: "x" }],
      }),
    ).toEqual({ ok: false, error: { code: "malformed-policy" } });
    expect(
      parseWorkspaceWritePlan({
        maxTargets: HARD_MAX_WRITE_TARGETS + 1,
        targets: [{ kind: "create", path: "a.ts", text: "x" }],
      }),
    ).toEqual({
      ok: false,
      error: { code: "malformed-limit", field: "maxTargets", reason: "above-hard-maximum" },
    });
    expect(
      parseWorkspaceWritePlan({
        maxFileBytes: 4,
        targets: [{ kind: "create", path: "a.ts", text: "12345" }],
      }),
    ).toEqual({ ok: false, error: { code: "oversized", byteLength: 5 } });
  });

  test("describeWorkspaceWriteError covers every declared code", () => {
    expect(describeWorkspaceWriteError({ code: "malformed", reason: "path-empty" })).toBe(
      "malformed:path-empty",
    );
    expect(describeWorkspaceWriteError({ code: "overlapping-targets", reason: "duplicate" })).toBe(
      "overlapping-targets:duplicate",
    );
    expect(describeWorkspaceWriteError({ code: "plan-refused" })).toBe("plan-refused");
    expect(describeWorkspaceWriteError({ code: "filesystem", reason: "io-failure" })).toBe(
      "filesystem:io-failure",
    );
  });
});
