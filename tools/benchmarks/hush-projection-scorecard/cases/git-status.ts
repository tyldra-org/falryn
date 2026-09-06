import type { ProjectionCase } from "../../hush-projection-case.ts";

export const GIT_STATUS_CASES: readonly ProjectionCase[] = [
  {
    id: "git-status",
    projection: "git-status",
    executable: "git",
    argv: ["status", "--short", "--branch"],
    rtkArgv: ["git", "status", "--short", "--branch"],
    requiredMarkers: [
      "main",
      "src/domain/compression/hush.ts",
      "reducers/plain-text.ts",
      "hush-projection-scorecard.ts",
    ],
  },
];
