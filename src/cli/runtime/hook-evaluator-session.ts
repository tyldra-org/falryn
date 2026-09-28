/**
 * What a composed session lends its package evaluator hooks (#1186): the granted provider
 * profile, resolved at each evaluation with current credentials, its durable history
 * ports, and its tools once composed. The session's main provider serves its own profile.
 */
import type {
  HookEvaluatorProvider,
  HookEvaluatorSession,
} from "../../application/extensions/hook-evaluator.ts";
import type { ProductToolBundle } from "../../application/tools/product-tools-merge.ts";

export function composeHookEvaluatorSession(options: {
  readonly main: () => HookEvaluatorProvider | null;
  readonly resolve?: (
    profileId: string,
    signal: AbortSignal,
  ) => Promise<HookEvaluatorProvider | { readonly reason: string }>;
  readonly ports: HookEvaluatorSession["ports"];
  readonly artifacts?: HookEvaluatorSession["artifacts"];
}) {
  let tools: ProductToolBundle | null = null;
  const session: HookEvaluatorSession = {
    async provider(profileId, signal) {
      const main = options.main();
      if (main !== null && main.adapter.identity.profileId === profileId) return main;
      return options.resolve === undefined
        ? { reason: "provider-profile-unavailable" }
        : options.resolve(profileId, signal);
    },
    ports: options.ports,
    ...(options.artifacts === undefined ? {} : { artifacts: options.artifacts }),
    tools: () => tools,
  };
  return {
    session,
    /** Bind the session's composed tools; agent evaluators read only through these. */
    bindTools(bundle: ProductToolBundle) {
      tools = bundle;
    },
  };
}
