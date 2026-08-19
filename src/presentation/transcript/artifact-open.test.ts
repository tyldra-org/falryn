import { describe, expect, test } from "bun:test";
import {
  blockOffersOpenArtifact,
  blockSelectsCodeViewer,
  blockSelectsDiffViewer,
  blockSelectsDocumentViewer,
  blockSelectsMediaViewer,
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

  test("selects diff for x-diff media types", () => {
    const artifact = everyBlockKind().find((block) => block.kind === "artifact");
    if (artifact === undefined || artifact.kind !== "artifact") {
      throw new Error("the corpus no longer has an artifact block");
    }
    const diffBlock = { ...artifact, mediaType: "text/x-diff" };
    expect(blockSelectsDiffViewer(diffBlock)).toBe(true);
    expect(blockSelectsCodeViewer(diffBlock)).toBe(false);
  });

  test("selects document for markdown artifacts", () => {
    const artifact = everyBlockKind().find((block) => block.kind === "artifact");
    if (artifact === undefined || artifact.kind !== "artifact") {
      throw new Error("the corpus no longer has an artifact block");
    }
    const markdownBlock = { ...artifact, mediaType: "text/markdown" };
    expect(blockSelectsDocumentViewer(markdownBlock)).toBe(true);
    expect(blockSelectsCodeViewer(markdownBlock)).toBe(false);
  });

  test("selects media summary for image and pdf artifacts", () => {
    const artifact = everyBlockKind().find((block) => block.kind === "artifact");
    if (artifact === undefined || artifact.kind !== "artifact") {
      throw new Error("the corpus no longer has an artifact block");
    }
    expect(blockSelectsMediaViewer({ ...artifact, mediaType: "image/png" })).toBe(true);
    expect(blockSelectsMediaViewer({ ...artifact, mediaType: "application/pdf" })).toBe(true);
    expect(
      blockSelectsMediaViewer({ ...artifact, mediaType: "application/vnd.jupyter.notebook+json" }),
    ).toBe(true);
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
