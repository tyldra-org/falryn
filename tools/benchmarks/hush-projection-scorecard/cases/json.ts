import type { ProjectionCase } from "../../hush-projection-case.ts";

export const JSON_CASES: readonly ProjectionCase[] = [
  {
    id: "json-structure",
    projection: "json",
    executable: "json",
    argv: ["config.json"],
    rtkArgv: ["json", "--keys-only", "config.json"],
    requiredMarkers: ["serviceName", "enabled", "targets", "arch", "os", "metadata", "ports"],
    forbiddenMarkers: [
      "falryn-private-value",
      "darwin-private",
      "arm64-private",
      "owner-private",
      "3000",
    ],
  },
];
