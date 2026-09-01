import { describe, expect, test } from "bun:test";

import { MAX_CAUSE_DETAIL_LENGTH } from "../domain/index.ts";
import {
  containsRedactableSecret,
  createRuntimeProjectionRedactor,
  isSecretName,
  REDACTED,
  redactMetadata,
  redactText,
} from "./redaction.ts";

/**
 * A value with no recognizable credential shape.
 *
 * Deliberately boring: a sentinel like `ghp_…` would match the bare-token rule
 * on its own and hide whether the key-name rule fired at all.
 */
const SHAPELESS = "p4ss";

describe("free text", () => {
  test.each([
    ["api_key=hunter2", "hunter2"],
    ["password: correct-horse", "correct-horse"],
    ["authToken = abc123", "abc123"],
    ["Authorization: Bearer abcdefghijklmnop", "abcdefghijklmnop"],
    ["postgres://admin:hunter2@db.internal/app", "hunter2"],
  ])("strips the secret in %s", (text, secret) => {
    expect(redactText(text)).not.toContain(secret);
    expect(containsRedactableSecret(text)).toBe(true);
  });

  test("leaves ordinary text untouched", () => {
    expect(redactText("queue depth 12 of maxItems 8")).toBe("queue depth 12 of maxItems 8");
  });

  test("preserves tool-output layout while redacting secrets", () => {
    const projected = createRuntimeProjectionRedactor().redactText(
      "first\n  second api_key=hunter2\n",
      Number.MAX_SAFE_INTEGER,
    );
    expect(projected).toBe("first\n  second api_key=[redacted]\n");
  });

  test("is bounded, counting the ellipsis toward the bound", () => {
    const long = "x".repeat(MAX_CAUSE_DETAIL_LENGTH * 3);
    expect(redactText(long).length).toBe(MAX_CAUSE_DETAIL_LENGTH);
  });
});

describe("structured metadata", () => {
  test.each(["apiKey", "api_key", "password", "authToken", "clientSecret", "ACCESS_KEY"])(
    "redacts a shapeless value under the secret-named key %s",
    (key) => {
      const redacted = redactMetadata({ [key]: SHAPELESS });
      expect(JSON.stringify(redacted)).not.toContain(SHAPELESS);
      expect(Object.values(redacted)[0]).toBe(REDACTED);
    },
  );

  test("a key and its value never form the text rule's key=value pair", () => {
    // The gap this test exists for: the free-text rule cannot see a structured
    // pair, so the key name has to be matched on its own.
    expect(containsRedactableSecret("apiKey")).toBe(false);
    expect(containsRedactableSecret(SHAPELESS)).toBe(false);
    expect(redactMetadata({ apiKey: SHAPELESS }).apiKey).toBe(REDACTED);
  });

  test("leaves an ordinary key and value alone", () => {
    expect(redactMetadata({ queued: 12, priority: "maintenance" })).toEqual({
      queued: 12,
      priority: "maintenance",
    });
  });

  test("redacts a numeric value under a secret-named key too", () => {
    expect(redactMetadata({ apiToken: 12345 }).apiToken).toBe(REDACTED);
  });

  test("still redacts a recognizable shape under an innocuous key", () => {
    const redacted = redactMetadata({ note: "see sk-live-ABCDEFGHIJKLMNOP" });
    expect(JSON.stringify(redacted)).not.toContain("sk-live-ABCDEFGHIJKLMNOP");
  });

  test("recognizes secret names case-insensitively and with separators", () => {
    for (const key of ["Password", "API-KEY", "x_private_key_y", "credentialRef"]) {
      expect(isSecretName(key)).toBe(true);
    }
    for (const key of ["queued", "priority", "durationMs", "keyboard"]) {
      expect(isSecretName(key)).toBe(false);
    }
  });
});
