/**
 * Which artifact a transcript block opens, and whether that open targets code.
 *
 * Pure functions over projection data and validated media types. No store access.
 */

import {
  type ArtifactId,
  type ArtifactOrigin,
  selectArtifactViewKind,
} from "../../domain/index.ts";
import { type BlockSource, expansionRoutesFor, type TranscriptBlock } from "./blocks.ts";

export function primaryArtifactId(block: TranscriptBlock): ArtifactId | null {
  if (block.kind === "artifact") {
    return block.artifactId;
  }
  return block.artifactIds[0] ?? null;
}

export function blockOffersOpenArtifact(block: TranscriptBlock): boolean {
  return expansionRoutesFor(block).includes("transcript.open-artifact");
}

/** Whether the block's declared media type selects a code viewer. */
export function blockSelectsCodeViewer(block: TranscriptBlock): boolean {
  if (block.kind !== "artifact") {
    return false;
  }
  return selectArtifactViewKind(block.mediaType, artifactOriginFor(block.source)) === "code";
}

export function artifactOriginFor(source: BlockSource): ArtifactOrigin {
  switch (source) {
    case "tool":
      return "tool-output";
    case "model":
      return "model-output";
    case "user":
      return "user-supplied";
    case "process":
      return "capture";
    case "runtime":
      return "diagnostic";
    default: {
      const exhaustive: never = source;
      return exhaustive;
    }
  }
}
