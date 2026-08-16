import { describe, expect, test } from "bun:test";
import { capabilityId, type FocusedConfirmationRequest, invocationId } from "../../domain/index.ts";
import {
  applySecretEdit,
  CONFIRMATION_ALTERNATIVES,
  confirmationIsStale,
  confirmationView,
  formatConfirmationTarget,
  labelledChoices,
  maskSecret,
  promptFromPolicy,
  reasonForEffect,
  resolvedConfirmationKey,
  secretGraphemeCount,
  WITHHELD_TARGET,
} from "./prompt.ts";

function request(overrides: Partial<FocusedConfirmationRequest> = {}): FocusedConfirmationRequest {
  return {
    confirmationId: "conf-1",
    invocationId: invocationId.from("inv-1"),
    toolName: "write_file",
    capabilityId: capabilityId.from("builtin:workspace/write_file@1"),
    effectClass: "mutation",
    title: "Write file",
    normalizedInput: { path: "src/app.ts" },
    inputFingerprint: "fp-1",
    ...overrides,
  };
}

describe("promptFromPolicy", () => {
  test("projects operation, target, reason, and once-only scope", () => {
    const prompt = promptFromPolicy(request());
    expect(prompt).toMatchObject({
      id: "conf-1",
      title: "Write file",
      operation: "write_file",
      target: "path=src/app.ts",
      reason: "This would change files or other local state.",
      effect: "mutation",
      scope: "once",
      fingerprint: "fp-1",
      secret: null,
    });
    expect(prompt.alternatives).toEqual([...CONFIRMATION_ALTERNATIVES]);
  });

  test("withholds secret-shaped keys and values from the target", () => {
    const prompt = promptFromPolicy(
      request({
        normalizedInput: {
          path: "src/app.ts",
          token: "sk-live-not-for-the-frame",
          note: "Bearer abc",
        },
      }),
    );
    expect(prompt.target).toContain("path=src/app.ts");
    expect(prompt.target).toContain(`token=${WITHHELD_TARGET}`);
    expect(prompt.target).toContain(`note=${WITHHELD_TARGET}`);
    expect(prompt.target).not.toContain("sk-live");
    expect(prompt.target).not.toContain("Bearer");
  });

  test("covers every effect class with a reason", () => {
    expect(reasonForEffect("observation")).toContain("read");
    expect(reasonForEffect("mutation")).toContain("change");
    expect(reasonForEffect("external")).toContain("outside");
    expect(reasonForEffect("interactive")).toContain("terminal");
  });
});

describe("stale identity", () => {
  test("a changed fingerprint cannot reuse the bound decision", () => {
    const bound = promptFromPolicy(request());
    const live = promptFromPolicy(request({ inputFingerprint: "fp-2" }));
    expect(confirmationIsStale(bound, live)).toBe(true);
    expect(confirmationView(bound, live, 0).stale).toBe(true);
  });

  test("matching id and fingerprint stay fresh", () => {
    const bound = promptFromPolicy(request());
    expect(confirmationIsStale(bound, bound)).toBe(false);
    expect(resolvedConfirmationKey(bound)).toBe("conf-1:fp-1");
  });
});

describe("labelled choices", () => {
  test("bind y and n when there is no secret field", () => {
    const prompt = promptFromPolicy(request());
    expect(labelledChoices(prompt).map((choice) => choice.key)).toEqual(["y", "n"]);
  });

  test("bind return to accept when a secret field is capturing", () => {
    const prompt = {
      ...promptFromPolicy(request()),
      secret: { label: "API token" },
    };
    expect(labelledChoices(prompt).map((choice) => `${choice.id}:${choice.key}`)).toEqual([
      "accept:return",
      "deny:escape",
    ]);
  });
});

describe("the secret buffer", () => {
  test("inserts, deletes by grapheme, and masks without the value", () => {
    const next = applySecretEdit("", { kind: "insert", text: "hunting" });
    expect(secretGraphemeCount(next)).toBe(7);
    expect(maskSecret(7, "•")).toBe("•••••••");
    expect(maskSecret(7, "•")).not.toContain("hunting");
    expect(applySecretEdit(next, { kind: "delete" })).toBe("huntin");
  });

  test("treats a flag as one grapheme", () => {
    const next = applySecretEdit("", { kind: "insert", text: "🇬🇧" });
    expect(secretGraphemeCount(next)).toBe(1);
    expect(applySecretEdit(next, { kind: "delete" })).toBe("");
  });
});

describe("formatConfirmationTarget", () => {
  test("names an empty input rather than drawing nothing", () => {
    expect(formatConfirmationTarget({})).toBe("(no target)");
  });
});
