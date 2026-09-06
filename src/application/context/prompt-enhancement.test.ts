/**
 * Prompt enhancement port (#279).
 */

import { describe, expect, test } from "bun:test";
import { ENHANCEMENT_MODEL_OWNER, enhancePrompt } from "./prompt-enhancement.ts";

describe("enhancePrompt", () => {
  test("returns a local proposal without submitting", () => {
    const result = enhancePrompt({
      text: "  hello  \n",
      revision: 3,
      path: "local",
      attachments: ["paste:att-1"],
    });
    expect(result).toEqual({
      kind: "proposal",
      original: "  hello  \n",
      proposed: "hello",
      explanation: "trimmed trailing spaces, and trimmed edges",
      revision: 3,
    });
  });

  test("reports empty and unchanged drafts", () => {
    expect(enhancePrompt({ text: "   \n", revision: 1, path: "local", attachments: [] }).kind).toBe(
      "empty",
    );
    expect(
      enhancePrompt({
        text: "already clear",
        revision: 1,
        path: "local",
        attachments: [],
      }),
    ).toEqual({ kind: "unchanged", revision: 1 });
  });

  test("refuses a model path without calling a provider", () => {
    const result = enhancePrompt({
      text: "rewrite this",
      revision: 1,
      path: "model",
      attachments: [],
    });
    expect(result.kind).toBe("unavailable");
    expect(result.kind === "unavailable" && result.owner).toBe(ENHANCEMENT_MODEL_OWNER);
  });

  test("keeps a secret-shaped draft in-process and does not send a model rewrite", () => {
    const secret = "export API_KEY=abc123  ";
    const local = enhancePrompt({
      text: secret,
      revision: 2,
      path: "local",
      attachments: [],
    });
    expect(local).toEqual({
      kind: "proposal",
      original: secret,
      proposed: "export API_KEY=abc123",
      explanation: "trimmed trailing spaces",
      revision: 2,
    });
    const model = enhancePrompt({
      text: secret,
      revision: 2,
      path: "model",
      attachments: [],
    });
    expect(model.kind).toBe("unavailable");
    expect(model.kind === "unavailable" && model.owner).toBe(ENHANCEMENT_MODEL_OWNER);
  });
});
