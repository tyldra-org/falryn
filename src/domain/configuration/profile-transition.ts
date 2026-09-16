import { z } from "zod";

const identity = z.string().min(1).max(256);
const generation = z.number().int().nonnegative();
export const profileTransitionReceiptSchema = z.object({
  sessionId: identity,
  workspaceId: identity,
  candidateId: identity,
  profile: identity,
  previousGeneration: generation,
  publishedGeneration: generation.nullable(),
  savedFileRevision: identity.nullable(),
  stage: z.enum(["prepared", "rejected", "published", "settled"]),
  code: identity,
  owners: z
    .array(
      z.object({
        owner: identity,
        state: z.enum([
          "applied",
          "pending",
          "unavailable",
          "failed",
          "new-session-required",
          "restart-required",
        ]),
        generation: generation.nullable(),
        code: identity,
      }),
    )
    .max(64),
});
export type ProfileTransitionReceipt = z.infer<typeof profileTransitionReceiptSchema>;
export type ProfileOwnerReceipt = ProfileTransitionReceipt["owners"][number];
export type ProfileOwnerState = ProfileOwnerReceipt["state"];
