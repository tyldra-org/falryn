import type { HushProjectionKind } from "../src/domain/hush/routing/index.ts";

export type ProjectionCase = Readonly<{
  id: string;
  projection: HushProjectionKind;
  executable: string;
  argv: readonly string[];
  rtkArgv?: readonly string[];
  shellCommand?: string;
  baseline?: "raw" | "rewrite" | "rtk-log";
  competitiveTarget?: "tie" | "win";
  acceptedExitCodes?: readonly number[];
  requiredMarkers: readonly string[];
  forbiddenMarkers?: readonly string[];
}>;
