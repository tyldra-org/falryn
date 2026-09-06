import type { ProjectionCase } from "../../hush-projection-case.ts";

export const COMPOUND_CASES: readonly ProjectionCase[] = [
  {
    id: "compound-rg-sed-pipe",
    projection: "compound",
    executable: "bash",
    argv: [],
    shellCommand: "rg marker . | sed -n '1,3p'",
    baseline: "rewrite",
    requiredMarkers: ["first marker", "second marker", "third marker"],
    forbiddenMarkers: ["fourth marker", "omitted", "…"],
  },
  {
    id: "compound-pipe-rg",
    projection: "compound",
    executable: "bash",
    argv: [],
    shellCommand: "cat fixture.txt | rg marker",
    baseline: "rewrite",
    requiredMarkers: ["first marker", "second marker", "third marker", "fourth marker"],
    forbiddenMarkers: ["omitted", "…"],
  },
  {
    id: "compound-rg-and-sed",
    projection: "compound",
    executable: "bash",
    argv: [],
    shellCommand: "rg marker . && sed -n '1,3p' fixture.txt",
    baseline: "rewrite",
    requiredMarkers: [
      "first marker",
      "second marker",
      "third marker",
      "fourth marker",
      "# Falryn",
      "Do more with less context.",
    ],
    forbiddenMarkers: ["omitted", "…"],
  },
];
