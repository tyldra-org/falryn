/** Public contracts for turn retry, fallback, and terminal policy. */

import type {
  AttemptAction,
  AttemptClassification,
  AttemptFact,
  AttemptIdentity,
  BriefReceipt,
  BriefRequest,
  CapabilityId,
  ClockPort,
  ConfigurationGeneration,
  EffectCertainty,
  EffectiveExecutionPolicy,
  ModelAttemptId,
  ModelCapabilityBrief,
  RetryBackoff,
  RetryPolicy,
  TurnId,
  TurnSnapshot,
} from "../../domain/index.ts";
import type {
  ModelBudgets,
  ModelMessage,
  ModelPolicy,
  ModelToolDefinition,
  OutputContract,
  PromptCachePolicy,
  PromptCacheSeed,
  ResolveRouteInput,
  RoutedCatalogEntry,
  RoutingReceipt,
  UsageUnits,
  WorkIntent,
} from "../../providers/index.ts";
import type { TurnCoordinator, TurnCoordinatorError } from "../turn-coordinator.ts";
import type { TurnEventJournalPort } from "../turn-event-journal.ts";

/** Immutable provider input shared by every retry/fallback for one turn. */
export type AttemptModelInput = {
  readonly messages: readonly ModelMessage[];
  readonly tools: readonly ModelToolDefinition[];
  readonly output: OutputContract;
  readonly budgets: ModelBudgets;
  readonly promptCache?: PromptCacheSeed;
  /** Immutable execution-profile/effect snapshot for this turn. */
  /** Absent only for pre-profile test/adapter inputs; product turns always bind one. */
  readonly executionPolicy?: EffectiveExecutionPolicy;
  /** Mutable response policy inputs; the provider conversation remains on one lineage. */
  readonly brief?: {
    readonly request: BriefRequest;
    readonly receipt: BriefReceipt;
    readonly sectionSource: string;
    /** Full provider-neutral prompt fallback. */
    readonly fallbackGuidance: string;
    /** Guidance retained alongside a provider-native density control. */
    readonly semanticGuidance: string;
    /** Caller/provider ceiling before Brief selects the current turn budget. */
    readonly maxOutputTokensCeiling?: number;
  };
  /** Registry generation and concrete names visible to this attempt. */
  readonly disclosure: {
    readonly catalogGeneration: ConfigurationGeneration;
    readonly toolNames: readonly string[];
    readonly discoveryHandle: string;
    readonly opportunityPlan?: ModelCapabilityBrief;
    /** Compact non-secret inventory facts; exact schemas stay in `tools`. */
    readonly capabilityCatalog?: {
      readonly total: number;
      readonly counts: Readonly<Record<string, number>>;
      readonly cards: readonly {
        readonly capabilityId: CapabilityId;
        readonly kind: string;
        readonly family: string | null;
        readonly source: string;
        readonly version: number;
        readonly costClass: string;
        readonly latencyClass: string;
        readonly available: boolean;
        readonly executable: boolean;
        readonly disclosed: boolean;
        readonly health?: string;
        readonly selected?: boolean;
        readonly projected?: boolean;
        readonly diagnosticCodes?: readonly string[];
      }[];
    };
    readonly families: readonly {
      readonly family: string;
      readonly available: boolean;
      readonly reason: string | null;
    }[];
    readonly tools: readonly {
      readonly name: string;
      readonly capabilityId: CapabilityId;
      readonly version: number;
      readonly schemaDigest: string;
      readonly schemaBytes: number;
      readonly schemaTokensEstimated: number;
    }[];
    readonly omitted: readonly { readonly name: string; readonly reason: string }[];
    readonly schemaBytes: number;
    readonly schemaTokensEstimated: number;
  };
};

export type AttemptRunnerRequest = {
  readonly turnId: TurnId;
  readonly identity: AttemptIdentity;
  readonly receipt: RoutingReceipt;
  /** Immutable configuration/policy snapshot selected for the whole turn. */
  readonly boundConfigurationGeneration: ConfigurationGeneration;
  /** Current turn-machine generation, which may advance during recovery. */
  readonly configurationGeneration: ConfigurationGeneration;
  readonly signal: AbortSignal;
  readonly modelInput: AttemptModelInput | null;
  readonly promptCache?: PromptCachePolicy;
};

export type AttemptRunnerResult = {
  readonly fact: AttemptFact;
  /** Turn after the attempt; may already be terminal when the runner settles. */
  readonly turn: TurnSnapshot | null;
  /** Model-facing output retained by the product entrypoint, never by retry policy. */
  readonly output?: {
    readonly text: string;
    readonly reasoning: string;
    readonly toolResults: number;
    readonly providerRequests?: number;
    readonly usage?: UsageUnits | null;
    readonly briefReceipt?: BriefReceipt | null;
    /** Secret-safe provider receipts for diagnostics and replay inspection. */
    readonly providerMetadata?: Readonly<Record<string, string>>;
  };
};

/**
 * One model attempt. Implementations typically wrap the stream consumer and
 * optional tool-call loop; tests inject deterministic scripts.
 */
export type AttemptRunnerPort = {
  run(request: AttemptRunnerRequest): Promise<AttemptRunnerResult>;
};

export type TurnAttemptPolicyOptions = {
  readonly clock: ClockPort;
  readonly coordinator: TurnCoordinator;
  readonly runner: AttemptRunnerPort;
  readonly policy: ModelPolicy;
  readonly catalogs: readonly RoutedCatalogEntry[];
  readonly retryPolicy?: RetryPolicy;
  readonly backoff?: RetryBackoff;
  /** Injected for deterministic backoff tests. Defaults to 0 (no jitter). */
  readonly jitter?: () => number;
  /** Allocates a branded attempt id. Defaults to `attempt-<n>`. */
  readonly allocateAttemptId?: (attemptNumber: number) => ModelAttemptId;
  /**
   * Optional durable journal (#46). When set, attempt/turn terminals are
   * recorded as facts; replay never re-enters the runner.
   */
  readonly journal?: TurnEventJournalPort;
  /**
   * False when an enclosing product producer owns turn.started/turn.completed.
   * Model-attempt facts still use the journal.
   */
  readonly persistTurnLifecycle?: boolean;
};

export type RunTurnAttemptPolicyInput = {
  readonly turnId: TurnId;
  readonly configurationGeneration: ConfigurationGeneration;
  readonly signal: AbortSignal;
  readonly modelInput?: AttemptModelInput;
  readonly intent?: WorkIntent;
  readonly role?: ResolveRouteInput["role"];
  readonly explicit?: ResolveRouteInput["explicit"];
  readonly required?: ResolveRouteInput["required"];
  /**
   * Elapsed budget across all attempts (ms), or `null` for unbounded.
   * Defaults to `null`.
   */
  readonly elapsedBudgetMs?: number | null;
};

export type AttemptRecord = {
  readonly identity: AttemptIdentity;
  readonly receipt: RoutingReceipt;
  readonly fact: AttemptFact;
  readonly classification: AttemptClassification;
  readonly action: AttemptAction;
  readonly output: AttemptRunnerResult["output"] | null;
};

export type TurnAttemptPolicyOutcome =
  | {
      readonly kind: "completed";
      readonly attempts: readonly AttemptRecord[];
      readonly turn: TurnSnapshot;
    }
  | {
      readonly kind: "refusal";
      readonly source: "model" | "policy" | "provider-safety";
      readonly reason: string;
      readonly effect: EffectCertainty;
      readonly attempts: readonly AttemptRecord[];
      readonly turn: TurnSnapshot | null;
    }
  | {
      readonly kind: "partial";
      readonly reason: string;
      readonly effect: EffectCertainty;
      readonly attempts: readonly AttemptRecord[];
      readonly turn: TurnSnapshot;
    }
  | {
      readonly kind: "failed";
      readonly effect: EffectCertainty;
      readonly message: string;
      readonly attempts: readonly AttemptRecord[];
      readonly turn: TurnSnapshot;
    }
  | {
      readonly kind: "cancelled";
      readonly effect: EffectCertainty;
      readonly attempts: readonly AttemptRecord[];
      readonly turn: TurnSnapshot;
    }
  | {
      readonly kind: "timed-out";
      readonly effect: EffectCertainty;
      readonly attempts: readonly AttemptRecord[];
      readonly turn: TurnSnapshot;
    }
  | {
      readonly kind: "uncertain";
      readonly effect: "uncertain";
      readonly attempts: readonly AttemptRecord[];
      readonly turn: TurnSnapshot;
    }
  | {
      readonly kind: "exhausted";
      readonly reason: string;
      readonly attempts: readonly AttemptRecord[];
      readonly turn: TurnSnapshot | null;
    }
  | {
      readonly kind: "routing-refused";
      readonly code: string;
      readonly detail: string;
      readonly attempts: readonly AttemptRecord[];
      readonly turn: TurnSnapshot | null;
    }
  | {
      readonly kind: "turn-error";
      readonly error: TurnCoordinatorError;
      readonly attempts: readonly AttemptRecord[];
      readonly turn: TurnSnapshot | null;
    };

export type TurnAttemptPolicy = {
  run(input: RunTurnAttemptPolicyInput): Promise<TurnAttemptPolicyOutcome>;
};
