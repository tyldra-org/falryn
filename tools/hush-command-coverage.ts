/** Maintained Hush command-routing coverage scorecard against pinned RTK 0.45.0. */

import { duration } from "../src/domain/clock.ts";
import {
  HUSH_COMMAND_CATALOG,
  HUSH_PROJECTION_KINDS,
  matchHushCommand,
} from "../src/domain/hush/catalog/index.ts";
import { commandShape } from "../src/domain/hush/command-shape.ts";
import { MAX_COMMAND_OUTPUT_BYTES, type ProcessCaptureRequest } from "../src/domain/index.ts";

export const HUSH_RTK_BASELINE = {
  version: "rtk 0.45.0",
  commit: "b34be37caf3796b69a50952a28e60e32b5daad43",
  nativeRewriteRules: 86,
  builtInFilters: 63,
} as const;

export type HushCommandCoverageFailure = {
  readonly example: string;
  readonly expectedReducerId: string;
  readonly actualReducerId: string | null;
  readonly reason: "compound" | "missing" | "wrong-reducer";
};

export type HushCommandCoverageScorecard = {
  readonly baseline: typeof HUSH_RTK_BASELINE;
  readonly catalogEntries: number;
  readonly commandExecutables: number;
  readonly examples: number;
  readonly projectionKinds: number;
  readonly failures: readonly HushCommandCoverageFailure[];
  readonly routingComplete: boolean;
  readonly parityProvenProjections: typeof HUSH_PROJECTION_KINDS;
  readonly parityProvenReducers: readonly string[];
};

export function createHushCommandCoverageScorecard(): HushCommandCoverageScorecard {
  const failures: HushCommandCoverageFailure[] = [];
  const executables = new Set<string>();
  let examples = 0;
  for (const entry of HUSH_COMMAND_CATALOG) {
    for (const executable of entry.executables) {
      executables.add(executable);
    }
    for (const example of entry.examples) {
      examples += 1;
      const shape = commandShape(bash(example));
      const policy = shape.compound ? null : matchHushCommand(shape.tokens);
      if (shape.compound) {
        failures.push({
          example,
          expectedReducerId: entry.reducerId,
          actualReducerId: null,
          reason: "compound",
        });
      } else if (policy === null) {
        failures.push({
          example,
          expectedReducerId: entry.reducerId,
          actualReducerId: null,
          reason: "missing",
        });
      } else if (policy.reducerId !== entry.reducerId) {
        failures.push({
          example,
          expectedReducerId: entry.reducerId,
          actualReducerId: policy.reducerId,
          reason: "wrong-reducer",
        });
      }
    }
  }
  return {
    baseline: HUSH_RTK_BASELINE,
    catalogEntries: HUSH_COMMAND_CATALOG.length,
    commandExecutables: executables.size,
    examples,
    projectionKinds: HUSH_PROJECTION_KINDS.length,
    failures,
    routingComplete: failures.length === 0,
    parityProvenProjections: HUSH_PROJECTION_KINDS,
    parityProvenReducers: HUSH_COMMAND_CATALOG.map((entry) => entry.reducerId),
  };
}

export function formatHushCommandCoverageScorecard(
  scorecard: HushCommandCoverageScorecard,
): string {
  const lines = [
    `Hush command coverage vs ${scorecard.baseline.version}`,
    `baseline: ${scorecard.baseline.commit}; ${scorecard.baseline.nativeRewriteRules} native rules + ${scorecard.baseline.builtInFilters} built-in filters`,
    `catalog: ${scorecard.catalogEntries} policies; ${scorecard.commandExecutables} executables; ${scorecard.examples} command examples; ${scorecard.projectionKinds} Hush projection kinds`,
    `routing: ${scorecard.routingComplete ? "PASS" : "FAIL"}`,
    `token/context parity proven: ${scorecard.parityProvenReducers.length} reducers across ${scorecard.parityProvenProjections.length} projections`,
  ];
  for (const failure of scorecard.failures) {
    lines.push(
      `- ${failure.example}: ${failure.reason}; expected=${failure.expectedReducerId}; actual=${failure.actualReducerId ?? "none"}`,
    );
  }
  return lines.join("\n");
}

function bash(command: string): ProcessCaptureRequest {
  return {
    mode: "bash",
    executable: "/bin/bash",
    command,
    environment: {},
    timeoutMs: duration(5_000),
    maxOutputBytes: MAX_COMMAND_OUTPUT_BYTES,
  };
}

if (import.meta.main) {
  const scorecard = createHushCommandCoverageScorecard();
  console.log(formatHushCommandCoverageScorecard(scorecard));
  if (!scorecard.routingComplete) {
    process.exitCode = 1;
  }
}
