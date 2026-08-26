/** Unknown exceptions and shutdown participant translations. */

import type { FalrynError, ParticipantReport } from "../../domain/index.ts";
import { redactText } from "../redaction.ts";
import { build, type ErrorContext } from "./shared.ts";

export function fromUnknown(thrown: unknown, context: ErrorContext = {}): FalrynError {
  const detail =
    thrown instanceof Error
      ? redactText(thrown.message)
      : typeof thrown === "string"
        ? redactText(thrown)
        : null;

  return build({
    code: "internal.unexpected",
    category: "internal",
    message: "An unexpected internal failure occurred.",
    retryable: false,
    // Nothing observed the effect of code that threw where it should not have.
    effect: "uncertain",
    cause: { source: "unknown", code: "thrown", detail },
    ...context,
  });
}

/**
 * Adopts an error described by a foreign or newer producer.
 *
 * An unrecognized category is preserved in the cause and the error is marked
 * unrecognized, rather than being mapped onto a known category that means
 * something else. Reading `data` where the producer said `provider` would be a
 * worse outcome than admitting the code is not understood.
 */

export function fromParticipantReports(
  reports: readonly ParticipantReport[],
  context: ErrorContext = {},
): readonly FalrynError[] {
  return reports
    .filter((report) => report.status !== "completed")
    .map((report) =>
      build({
        code:
          report.status === "failed"
            ? "internal.shutdown.participant-failed"
            : "cancellation.shutdown.participant-unfinished",
        category: report.status === "failed" ? "internal" : "cancellation",
        message:
          report.status === "failed"
            ? "A shutdown participant failed."
            : "A shutdown participant did not finish before its phase ended.",
        retryable: false,
        // Unfinished work was not observed stopping; a failure reported itself.
        effect: report.status === "failed" ? "partial" : "uncertain",
        cause: {
          source: "shutdown",
          code: report.status,
          detail:
            report.failure === null ? report.name : redactText(`${report.name}: ${report.failure}`),
        },
        ...context,
      }),
    );
}
