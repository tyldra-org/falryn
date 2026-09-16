import type { EnvironmentInspection } from "./scoped-environment.ts";
import type {
  ProfileTransitionOutcome,
  ProfileTransitionScope,
  ProfileTransitions,
} from "./transition-contracts.ts";

export type EnvironmentControl = {
  execute(
    action: "inspect" | "reload",
    signal?: AbortSignal,
  ): Promise<{
    readonly kind: "environment";
    readonly inspection: EnvironmentInspection;
    readonly restartRequired: readonly string[];
    readonly transition: ProfileTransitionOutcome | null;
  }>;
};

export function createEnvironmentControl(ports: {
  readonly scope: ProfileTransitionScope;
  readonly transitions: ProfileTransitions;
  current(): { generation: number; sources: string; profile: string | null };
  inspect(): EnvironmentInspection | Promise<EnvironmentInspection>;
  restartRequired(): readonly string[];
}): EnvironmentControl {
  return {
    async execute(action, signal) {
      let transition: ProfileTransitionOutcome | null = null;
      if (action === "reload") {
        const current = ports.current();
        const preview = await ports.transitions.preview(
          {
            ...ports.scope,
            actor: "user",
            profile: current.profile ?? "default",
            expectedGeneration: current.generation,
            expectedSources: current.sources,
          },
          signal,
        );
        transition =
          preview.kind === "refused"
            ? preview
            : await ports.transitions.apply(
                {
                  ...ports.scope,
                  actor: "user",
                  candidateId: preview.candidateId,
                  expectedGeneration: preview.expectedGeneration,
                },
                signal,
              );
      }
      return {
        kind: "environment",
        inspection: await ports.inspect(),
        restartRequired: ports.restartRequired(),
        transition,
      };
    },
  };
}
