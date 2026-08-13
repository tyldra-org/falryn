/**
 * Application seam for #52 result envelopes.
 *
 * Domain assembly stays free of the runtime redactor. This module applies that
 * redactor to the model/UI projection so secret patterns are not duplicated.
 */

import {
  type AssembleCapabilityResultInput,
  assembleCapabilityResult,
  type CapabilityResult,
  type ModelToolResultView,
  type ProjectionContract,
  projectCapabilityResult,
  type SensitiveValueRedactor,
} from "../domain/index.ts";

export type ToolResultEnvelope = {
  readonly result: CapabilityResult;
  readonly projection: ModelToolResultView;
};

export type EnvelopeToolResultInput = AssembleCapabilityResultInput & {
  readonly projection: ProjectionContract;
  readonly redactor: SensitiveValueRedactor;
};

export function envelopeToolResult(input: EnvelopeToolResultInput): ToolResultEnvelope {
  const { projection, redactor, ...assembleInput } = input;
  const result = assembleCapabilityResult(assembleInput);
  return {
    result,
    projection: projectCapabilityResult(result, projection, redactor),
  };
}
