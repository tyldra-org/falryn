import { z } from "zod";
import {
  executePeerAction,
  peerActionSchema,
} from "../../application/orchestration/peer-actions.ts";
import { err } from "../../domain/foundation/result.ts";
import { openProductArtifactSession } from "../runtime/product-artifact-session.ts";
import type { ServiceProvider } from "../runtime/services.ts";
import { resultFor } from "./shared.ts";

export const peerArgumentsSchema = z.strictObject({
  sessionId: z
    .string()
    .min(1)
    .max(160)
    .regex(/^[a-zA-Z0-9._:-]+$/u),
  action: peerActionSchema,
});
export type PeerArguments = z.infer<typeof peerArgumentsSchema>;
export type PeerPayload = Awaited<ReturnType<typeof executePeerAction>>;
export async function runPeer(
  services: ServiceProvider,
  args: PeerArguments,
  signal: AbortSignal = new AbortController().signal,
) {
  const graph = services();
  const workspace = await graph.ensureWorkspaceSet(signal);
  const unavailable: PeerPayload = err({ code: "unavailable" });
  const result = (payload: PeerPayload) =>
    resultFor(
      "peer",
      payload,
      [],
      payload.ok ? { kind: "completed" } : { kind: "failed", effect: "none" },
      { intent: "mutate", observed: payload.ok ? "completed" : "none" },
    );
  if (!workspace.ok) return result(unavailable);
  await graph.workspaceTrust.resolve(undefined, signal);
  const product = await openProductArtifactSession(graph, signal);
  if (!product) return result(unavailable);
  try {
    const peer = await product.peers.open({
      sessionId: args.sessionId,
      agentId: "main",
      generation: 1,
    });
    const selected = args.action.as
      ? (product.peers.owned(args.action.as, args.sessionId) ?? peer)
      : peer;
    return result(await executePeerAction(selected, args.action, "user", signal));
  } finally {
    await product.close();
  }
}
