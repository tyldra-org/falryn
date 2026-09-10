import type { CompositionProvenance } from "../../../domain/capabilities/composition.ts";
/** Public contracts and bounds for iterative model tool execution. */

import type {
  ConfigurationGeneration,
  InvocationId,
  TurnId,
} from "../../../domain/foundation/index.ts";
import type { EffectCertainty } from "../../../domain/orchestration/index.ts";
import type { TurnSnapshot } from "../../../domain/sessions/index.ts";
import type {
  BoundToolInvocation,
  ToolBindError,
  ToolCatalog,
  ToolInvocationOutcome,
  ToolInvocationRecord,
  ToolProposal,
} from "../../../domain/tools/index.ts";
import {
  DEFAULT_MAX_CONCURRENT_TOOLS,
  DEFAULT_MAX_TOOL_CALLS_PER_ITERATION,
  DEFAULT_MAX_TOOL_LOOP_ITERATIONS,
} from "../../../domain/tools/index.ts";
import type { AssembledToolProposal } from "../../../providers/index.ts";
import type { ProductTaskResources } from "../../orchestration/product-resources.ts";
import type { TurnCoordinator, TurnCoordinatorError } from "../turn-coordinator.ts";

export type ToolCallLoopLimits = {
  /** Max model→tool cycles in one `run` (fail closed when exceeded). */
  readonly maxIterations: number;
  /** Max concurrent in-flight tool executions. */
  readonly maxConcurrentTools: number;
  /** Max proposals admitted per iteration (queue bound). */
  readonly maxToolCallsPerIteration: number;
};

export const DEFAULT_TOOL_CALL_LOOP_LIMITS: ToolCallLoopLimits = {
  maxIterations: DEFAULT_MAX_TOOL_LOOP_ITERATIONS,
  maxConcurrentTools: DEFAULT_MAX_CONCURRENT_TOOLS,
  maxToolCallsPerIteration: DEFAULT_MAX_TOOL_CALLS_PER_ITERATION,
};

/**
 * Narrow execution boundary. Receives only validated input and an abort
 * signal — never provider clients, UI state, or unrestricted host access.
 */
export type ToolRunnerRequest = {
  /** Captured by the live attempt, never decoded from model arguments. */
  readonly delegation?: {
    readonly route: import("../../../providers/configuration/policy.ts").RoleRoute;
    readonly binding: import("../../../domain/orchestration/child-admission.ts").ChildProviderBinding;
    readonly effects: readonly import("../../../domain/orchestration/work.ts").EffectClass[];
    readonly capabilities: readonly string[];
  };
  /** Native delegation and peer actions wait after their metadata reservation has released. */
  readonly afterAdmission?: (run: (signal: AbortSignal) => Promise<ToolInvocationOutcome>) => void;
  readonly composition?: CompositionProvenance;
  /** Trusted composition consumer; never serialized or supplied by a provider. */
  readonly captureExactOutput?: (value: Readonly<Record<string, unknown>>) => void;
  /** Product-owned parent allowance for composition; never supplied by a model. */
  readonly taskResources?: ProductTaskResources;
  /** Gateway-owned task lineage and commit-before-receipt lifetime transfer. */
  readonly processTask?: {
    readonly owner: import("../../../domain/orchestration/process-task.ts").ProcessTaskOwner;
    readonly deadline?: number;
    /** Resolves after the native runner and its post-effect observers finish. */
    readonly finished?: Promise<void>;
    reportTermination?(terminated: boolean): void;
    publishReceipt(outcome: ToolInvocationOutcome): boolean;
  };
  readonly invocationId: InvocationId;
  readonly toolCallId: string;
  readonly toolName: string;
  readonly capabilityId: BoundToolInvocation["descriptor"]["id"];
  readonly version: number;
  readonly effect: BoundToolInvocation["descriptor"]["effect"];
  readonly input: Readonly<Record<string, unknown>>;
  readonly signal: AbortSignal;
};

export type ToolRunnerPort = {
  hasBinding?(id: BoundToolInvocation["descriptor"]["id"]): boolean;
  executeBatch?(
    batch: readonly BoundToolInvocation[],
    signal: AbortSignal,
    maxConcurrent: number,
  ): Promise<readonly ToolInvocationRecord[]>;
  execute(request: ToolRunnerRequest): Promise<ToolInvocationOutcome>;
};

/** Explicit no-effect runtime fallback edges selected before provider inference. */
export type ToolFallbackPolicy = {
  readonly maxTransitions: number;
  readonly transitions: readonly {
    readonly fromToolName: string;
    readonly toToolNames: readonly string[];
  }[];
};

export type ToolCallLoopOptions = {
  readonly coordinator: TurnCoordinator;
  readonly catalog: ToolCatalog;
  readonly runner: ToolRunnerPort;
  readonly limits?: Partial<ToolCallLoopLimits>;
  readonly fallbackPolicy?: ToolFallbackPolicy;
};

export type ContinueModelContext = {
  readonly turnId: TurnId;
  readonly iteration: number;
  readonly results: readonly ToolInvocationRecord[];
  readonly signal: AbortSignal;
};

export type ContinueModelResult =
  | { readonly kind: "stop" }
  | { readonly kind: "continue"; readonly proposals: readonly ToolProposal[] };

export type RunToolCallLoopInput = {
  readonly turnId: TurnId;
  readonly configurationGeneration: ConfigurationGeneration;
  /** Proposals from stream assembly (#43) or a prior continue-model step. */
  readonly proposals: readonly ToolProposal[] | readonly AssembledToolProposal[];
  readonly signal: AbortSignal;
  /**
   * How abort settles when the signal fires. Defaults to `cancel`.
   * Timeout uses the same cleanup-before-report path.
   */
  readonly abortAs?: "cancel" | "timeout" | (() => "cancel" | "timeout");
  /** Stable attempt lineage used to avoid invocation-id collisions on retry. */
  readonly invocationIdPrefix?: string;
  /**
   * After an iteration's tools settle, optionally produce another proposal
   * batch (next model step). Omitted or `stop` ends the loop.
   */
  readonly continueModel?: (context: ContinueModelContext) => Promise<ContinueModelResult>;
};

export type ToolCallLoopBound =
  | "max-iterations"
  | "max-concurrent-tools"
  | "max-tool-calls-per-iteration";

export type ToolCallLoopOutcome =
  | {
      readonly kind: "completed";
      readonly iterations: number;
      readonly results: readonly ToolInvocationRecord[];
      readonly turn: TurnSnapshot;
      readonly foldedEffect: EffectCertainty;
    }
  | {
      readonly kind: "cancelled";
      readonly iterations: number;
      readonly results: readonly ToolInvocationRecord[];
      readonly turn: TurnSnapshot;
      readonly effect: EffectCertainty;
    }
  | {
      readonly kind: "timed-out";
      readonly iterations: number;
      readonly results: readonly ToolInvocationRecord[];
      readonly turn: TurnSnapshot;
      readonly effect: EffectCertainty;
    }
  | {
      readonly kind: "failed";
      readonly iterations: number;
      readonly results: readonly ToolInvocationRecord[];
      readonly turn: TurnSnapshot;
      readonly effect: EffectCertainty;
      readonly reason: string;
    }
  | {
      readonly kind: "uncertain";
      readonly iterations: number;
      readonly results: readonly ToolInvocationRecord[];
      readonly turn: TurnSnapshot;
      readonly recoveryHint: string;
    }
  | {
      readonly kind: "denied";
      readonly iterations: number;
      readonly results: readonly ToolInvocationRecord[];
      readonly turn: TurnSnapshot;
      readonly reason: string;
    }
  | {
      readonly kind: "malformed";
      readonly iterations: number;
      readonly results: readonly ToolInvocationRecord[];
      readonly turn: TurnSnapshot;
      readonly reason: string;
      readonly bindError: ToolBindError | null;
    }
  | {
      readonly kind: "unavailable";
      readonly iterations: number;
      readonly results: readonly ToolInvocationRecord[];
      readonly turn: TurnSnapshot;
      readonly reason: string;
    }
  | {
      readonly kind: "partial";
      readonly iterations: number;
      readonly results: readonly ToolInvocationRecord[];
      readonly turn: TurnSnapshot;
      readonly effect: EffectCertainty;
      readonly reason: string;
    }
  | {
      readonly kind: "bound-exceeded";
      readonly bound: ToolCallLoopBound;
      readonly maximum: number;
      readonly attempted: number;
      readonly iterations: number;
      readonly results: readonly ToolInvocationRecord[];
      readonly turn: TurnSnapshot | null;
    }
  | {
      readonly kind: "turn-error";
      readonly error: TurnCoordinatorError;
      readonly iterations: number;
      readonly results: readonly ToolInvocationRecord[];
      readonly turn: TurnSnapshot | null;
    };

export type ToolCallLoop = {
  run(input: RunToolCallLoopInput): Promise<ToolCallLoopOutcome>;
};
