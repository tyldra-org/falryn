import { describe, expect, test } from "bun:test";
import {
  blockOffersOpenArtifact,
  blockSelectsCodeViewer,
  primaryArtifactId,
} from "./artifact-open.ts";
import { everyBlockKind } from "./fixtures.ts";

describe("artifact open helpers", () => {
  test("selects code for typescript artifacts with an open route", () => {
    const artifact = everyBlockKind().find((block) => block.kind === "artifact");
    if (artifact === undefined || artifact.kind !== "artifact") {
      throw new Error("the corpus no longer has an artifact block");
    }

    expect(blockOffersOpenArtifact(artifact)).toBe(true);
    expect(blockSelectsCodeViewer(artifact)).toBe(true);
    expect(primaryArtifactId(artifact)).not.toBe(null);
  });

  test("refuses non-artifact blocks", () => {
    const notice = everyBlockKind().find((block) => block.kind === "notice");
    if (notice === undefined) {
      throw new Error("the corpus no longer has a notice block");
    }

    expect(blockOffersOpenArtifact(notice)).toBe(false);
    expect(blockSelectsCodeViewer(notice)).toBe(false);
    expect(primaryArtifactId(notice)).toBe(null);
  });
});
