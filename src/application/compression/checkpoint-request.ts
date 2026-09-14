import { z } from "zod";
import { HISTORY_LIMITS } from "../../domain/sessions/history.ts";
import type { CheckpointOutcome } from "./product-checkpoint.ts";

export const checkpointRequestSchema = z.discriminatedUnion("action", [
  z.strictObject({ action: z.literal("preview") }),
  z.strictObject({
    action: z.enum(["apply", "inspect", "restore"]),
    candidateId: z.string().uuid(),
  }),
]);
/** Explicit whole-request components for a headless producer; no implicit zero modality costs. */
export const checkpointReservationSchema = z.strictObject({
  protectedRequest: z.string().max(HISTORY_LIMITS.contentBytes),
  contextGeneration: z.string().min(1).max(128),
  freshToolsTokens: z.int().nonnegative().max(HISTORY_LIMITS.contentBytes),
  freshResultsTokens: z.int().nonnegative().max(HISTORY_LIMITS.contentBytes),
  modalityTokens: z.int().nonnegative().max(HISTORY_LIMITS.contentBytes),
  reservedContinuationTokens: z.int().nonnegative().max(HISTORY_LIMITS.contentBytes),
  reservedOutputTokens: z.int().positive().max(HISTORY_LIMITS.contentBytes),
});
export type CheckpointControl = (
  argument: string | null,
  signal: AbortSignal,
) => Promise<{ readonly message: string }>;
export function checkpointMessage(result: CheckpointOutcome): string {
  if (result.kind === "refused")
    return `Compaction refused: ${result.reason}. Effect: ${result.effect}.`;
  return `Checkpoint ${result.kind}: ${result.candidateId}. ${result.beforeBytes} source bytes → ${result.afterBytes} projection bytes. Whole-request token estimate (UTF-8 bytes ÷ 4): ${result.budget.wholeRequestTokens}/${result.budget.limit}. Source fidelity: ${result.projection.fidelity}. Original captured evidence follows existing retention.${result.kind === "preview" ? ` Use /compact apply ${result.candidateId} before ${new Date(result.expiresAt).toISOString()}.` : ""}`;
}
export function checkpointControl(
  run: (
    request: z.infer<typeof checkpointRequestSchema>,
    signal: AbortSignal,
  ) => Promise<CheckpointOutcome>,
  scope: () => string = () => "session",
): CheckpointControl {
  let preview: { readonly scope: string; readonly candidateId: string } | null = null;
  return async (argument, signal) => {
    const [action = "preview", candidateId, extra] =
      argument?.trim().split(/\s+/u).filter(Boolean) ?? [];
    const selected =
      action === "apply" && candidateId === undefined && preview?.scope === scope()
        ? preview.candidateId
        : candidateId;
    const parsed = checkpointRequestSchema.safeParse(
      action === "preview" ? { action } : { action, candidateId: selected },
    );
    if (
      !parsed.success ||
      extra !== undefined ||
      (action === "preview" && candidateId !== undefined)
    )
      return {
        message:
          "Use /compact [preview], /compact apply <candidate-id>, /compact inspect <candidate-id>, or /compact restore <candidate-id>.",
      };
    const capturedScope = scope();
    const result = await run(parsed.data, signal);
    if (capturedScope !== scope())
      return {
        message: "Checkpoint operation belongs to the previous session; inspect its receipt there.",
      };
    if (result.kind === "preview")
      preview = { scope: capturedScope, candidateId: result.candidateId };
    if (result.kind === "applied") preview = null;
    return { message: checkpointMessage(result) };
  };
}
