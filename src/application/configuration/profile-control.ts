import type {
  ProfileTransitionPreview,
  ProfileTransitionScope,
  ProfileTransitions,
} from "./transition-contracts.ts";

export type ProfileControl = (
  argument: string | null,
  signal: AbortSignal,
  actor?: "user" | "model",
) => Promise<unknown>;

/** Text controls and embedders share the same candidate, CAS and receipt owner. */
export function createProfileControl(ports: {
  readonly scope: ProfileTransitionScope;
  readonly transitions: ProfileTransitions;
  current(): { generation: number; sources: string };
  list(signal: AbortSignal): Promise<unknown>;
  saveWorkspace?(id: string | null, signal: AbortSignal): Promise<unknown>;
  saveDefault(id: string, signal: AbortSignal): Promise<unknown>;
}): ProfileControl {
  let preview: ProfileTransitionPreview | null = null;
  let reviewedBy: "user" | "model" | null = null;
  let active: AbortController | null = null;
  return async (argument, signal, actor = "user") => {
    const words = argument?.trim().split(/\s+/) ?? [];
    const action = words[0] || "inspect";
    const id = words[1];
    if (words.length > 2) return { kind: "refused", code: "profile-arguments-invalid" };
    if (action === "inspect" || action === "list")
      return {
        kind: "inspection",
        ...ports.scope,
        current: ports.current(),
        profiles: await ports.list(signal),
        receipt: await ports.transitions.inspect(),
        guidance:
          "/profile use <id> previews a selection; /profile apply <candidateId> applies it; /profile default <id> saves the future-session default.",
      };
    if (action === "cancel") {
      if (actor !== "user") return { kind: "refused", code: "profile-policy-denied" };
      active?.abort();
      return { kind: "cancelled", receipt: await ports.transitions.inspect() };
    }
    if (action === "reconcile") return ports.transitions.reconcile(actor, signal);
    if (!id) return { kind: "refused", code: "profile-identity-required" };
    if (action === "workspace") {
      if (actor !== "user") return { kind: "refused", code: "profile-policy-denied" };
      return (
        ports.saveWorkspace?.(id === "reset" ? null : id, signal) ?? {
          kind: "refused",
          code: "workspace-preference-unavailable",
        }
      );
    }
    if (action === "default") {
      if (actor !== "user") return { kind: "refused", code: "profile-policy-denied" };
      return ports.saveDefault(id, signal);
    }
    if (action === "use" || action === "preview") {
      const current = ports.current();
      const result = await ports.transitions.preview(
        {
          ...ports.scope,
          profile: id,
          expectedGeneration: current.generation,
          expectedSources: current.sources,
          actor,
        },
        signal,
      );
      preview = result.kind === "preview" ? result : null;
      reviewedBy = actor;
      return result;
    }
    if (action === "apply") {
      if (reviewedBy !== actor) return { kind: "refused", code: "profile-policy-denied" };
      if (preview?.candidateId !== id) return { kind: "refused", code: "candidate-missing" };
      const reviewed = preview;
      preview = null;
      const stop = new AbortController();
      active = stop;
      try {
        return await ports.transitions.apply(
          {
            ...ports.scope,
            candidateId: id,
            actor,
            expectedGeneration: reviewed.expectedGeneration,
          },
          AbortSignal.any([signal, stop.signal]),
        );
      } finally {
        if (active === stop) active = null;
      }
    }
    return { kind: "refused", code: "profile-action-invalid" };
  };
}
