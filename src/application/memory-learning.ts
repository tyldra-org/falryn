/**
 * Application boundary for operational learning (#113).
 *
 * Stores bounded observations and suggested recommendations. Applying a
 * recommendation is always denied; product tools and SQLite remain later.
 */

import {
  defineOperationalObservation,
  defineOperationalRecommendation,
  err,
  type MemoryError,
  type OperationalObservation,
  type OperationalObservationInput,
  type OperationalRecommendation,
  type OperationalRecommendationInput,
  observationId,
  ok,
  type Result,
  recommendationId,
} from "../domain/index.ts";
import { containsRedactableSecret } from "./redaction.ts";

function memoryError(code: MemoryError["code"], field: string | null): MemoryError {
  return { kind: "memory", code, field };
}

export type OperationalLearning = {
  record(
    input: OperationalObservationInput,
    signal?: AbortSignal,
  ): Result<OperationalObservation, MemoryError>;
  recommend(
    input: OperationalRecommendationInput,
    signal?: AbortSignal,
  ): Result<OperationalRecommendation, MemoryError>;
  observation(id: unknown): Result<OperationalObservation, MemoryError>;
  recommendation(id: unknown): Result<OperationalRecommendation, MemoryError>;
  listRecommendations(): readonly OperationalRecommendation[];
  apply(id: unknown, signal?: AbortSignal): Result<never, MemoryError>;
};

export function createOperationalLearning(): OperationalLearning {
  const observations = new Map<string, OperationalObservation>();
  const recommendations = new Map<string, OperationalRecommendation>();

  return {
    record(input, signal) {
      if (signal?.aborted) {
        return err(memoryError("cancelled", "signal"));
      }
      if (typeof input.identity === "string" && containsRedactableSecret(input.identity)) {
        return err(memoryError("secret", "identity"));
      }
      const defined = defineOperationalObservation(input);
      if (!defined.ok) {
        return defined;
      }
      if (observations.has(defined.value.observationId)) {
        return err(memoryError("conflict", "observationId"));
      }
      observations.set(defined.value.observationId, defined.value);
      return defined;
    },
    recommend(input, signal) {
      if (signal?.aborted) {
        return err(memoryError("cancelled", "signal"));
      }
      if (
        typeof input.expectedBenefit === "string" &&
        containsRedactableSecret(input.expectedBenefit)
      ) {
        return err(memoryError("secret", "expectedBenefit"));
      }
      if (typeof input.risks === "string" && containsRedactableSecret(input.risks)) {
        return err(memoryError("secret", "risks"));
      }
      const defined = defineOperationalRecommendation(input);
      if (!defined.ok) {
        return defined;
      }
      for (const id of defined.value.supporting) {
        if (!observations.has(id)) {
          return err(memoryError("unavailable", "supporting"));
        }
      }
      for (const id of defined.value.counterexamples) {
        if (!observations.has(id)) {
          return err(memoryError("unavailable", "counterexamples"));
        }
      }
      if (recommendations.has(defined.value.recommendationId)) {
        return err(memoryError("conflict", "recommendationId"));
      }
      recommendations.set(defined.value.recommendationId, defined.value);
      return defined;
    },
    observation(id) {
      const parsed = observationId.parse(id);
      if (!parsed.ok) {
        return err(memoryError("malformed", "observationId"));
      }
      const found = observations.get(parsed.value);
      if (found === undefined) {
        return err(memoryError("unavailable", "observationId"));
      }
      return ok(found);
    },
    recommendation(id) {
      const parsed = recommendationId.parse(id);
      if (!parsed.ok) {
        return err(memoryError("malformed", "recommendationId"));
      }
      const found = recommendations.get(parsed.value);
      if (found === undefined) {
        return err(memoryError("unavailable", "recommendationId"));
      }
      return ok(found);
    },
    listRecommendations() {
      return [...recommendations.values()];
    },
    apply() {
      return err(memoryError("denied", "recommendationId"));
    },
  };
}
