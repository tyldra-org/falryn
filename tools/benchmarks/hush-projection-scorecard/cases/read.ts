import type { ProjectionCase } from "../../hush-projection-case.ts";

export const READ_CASES: readonly ProjectionCase[] = [
  {
    id: "read-cat",
    projection: "read",
    executable: "cat",
    argv: ["fixture.txt"],
    rtkArgv: ["read", "fixture.txt"],
    requiredMarkers: ["# Falryn", "Do more with less context.", "Keep every useful fact."],
  },
];
