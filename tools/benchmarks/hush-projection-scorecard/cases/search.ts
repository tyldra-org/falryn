import type { ProjectionCase } from "../../hush-projection-case.ts";

export const SEARCH_CASES: readonly ProjectionCase[] = [
  {
    id: "search-rg",
    projection: "search",
    executable: "rg",
    argv: ["marker", "."],
    rtkArgv: ["rg", "marker", "."],
    requiredMarkers: ["first marker", "second marker", "third marker", "fourth marker"],
  },
];
