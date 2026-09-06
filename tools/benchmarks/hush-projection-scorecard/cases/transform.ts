import type { ProjectionCase } from "../../hush-projection-case.ts";

export const TRANSFORM_CASES: readonly ProjectionCase[] = [
  {
    id: "transform-sed",
    projection: "transform",
    executable: "sed",
    argv: ["-n", "1,3p", "fixture.txt"],
    baseline: "raw",
    requiredMarkers: ["# Falryn", "Do more with less context."],
  },
];
