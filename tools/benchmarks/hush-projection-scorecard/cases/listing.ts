import type { ProjectionCase } from "../../hush-projection-case.ts";
import { HUSH_FIND_LISTING_MARKERS } from "../listing.ts";

export const LISTING_CASES: readonly ProjectionCase[] = [
  {
    id: "listing-find",
    projection: "listing",
    executable: "find",
    argv: ["corpus/src/domain/hush", "-type", "f"],
    rtkArgv: ["find", "corpus/src/domain/hush", "-type", "f"],
    requiredMarkers: HUSH_FIND_LISTING_MARKERS,
    forbiddenMarkers: ["+17 more", "omitted", "…"],
  },
];
