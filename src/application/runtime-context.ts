/**
 * Nested immutable runtime contexts.
 *
 * A context is what an operation is handed instead of reaching for global
 * state: which scope it belongs to, which configuration generation it started
 * under, how it learns it should stop, and when it expires. Deriving a child
 * produces a new value rather than mutating the parent, so in-flight work stays
 * bound to the generation and deadline it began with even when configuration
 * changes underneath it.
 *
 * Budgets are named in the runtime design but are not carried here yet: the
 * scheduling owner defines them, and inventing a second budget shape would be
 * the duplication this layering exists to prevent.
 */

import type {
  ConfigurationGeneration,
  Deadline,
  Result,
  ScopeError,
  ScopeId,
  ScopeKind,
  SessionId,
  TraceId,
  TurnId,
  WorkspaceId,
} from "../domain/index.ts";
import { deriveDeadline, enlargesDeadline } from "../domain/index.ts";
import type { DeriveScopeOptions, ScopeHandle, ScopeTree } from "./scope-tree.ts";

export type RuntimeContext = {
  readonly scopeId: ScopeId;
  readonly configurationGeneration: ConfigurationGeneration;
  /** Aborts when this scope or any ancestor begins cancelling. */
  readonly cancellation: AbortSignal;
  readonly deadline: Deadline | null;
};

export type TurnContext = RuntimeContext & {
  readonly workspaceId: WorkspaceId;
  readonly sessionId: SessionId;
  readonly turnId: TurnId;
  readonly traceId: TraceId;
};

export function contextFromScope(
  handle: ScopeHandle,
  configurationGeneration: ConfigurationGeneration,
): RuntimeContext {
  return {
    scopeId: handle.scopeId,
    configurationGeneration,
    cancellation: handle.signal,
    deadline: handle.deadline,
  };
}

export type DeriveContextOptions = {
  readonly kind: ScopeKind;
  /** Narrowed by the parent's deadline; a looser request is capped, not honoured. */
  readonly deadline?: Deadline | null;
  readonly scopeId?: ScopeId;
};

export type DerivedContext = {
  readonly context: RuntimeContext;
  readonly scope: ScopeHandle;
  /** True when the requested deadline was looser than what the parent allowed. */
  readonly deadlineCapped: boolean;
};

/**
 * Derives a child context under a new scope.
 *
 * The child keeps its parent's configuration generation: a generation change
 * applies to work that starts afterwards, never to a child of work already in
 * flight.
 */
export function deriveContext(
  tree: ScopeTree,
  parent: RuntimeContext,
  options: DeriveContextOptions,
): Result<DerivedContext, ScopeError> {
  const requested = options.deadline ?? null;
  const scopeOptions: DeriveScopeOptions =
    options.scopeId === undefined
      ? { kind: options.kind, deadline: requested }
      : { kind: options.kind, deadline: requested, scopeId: options.scopeId };

  const derived = tree.derive(parent.scopeId, scopeOptions);
  if (!derived.ok) {
    return derived;
  }
  return {
    ok: true,
    value: {
      context: contextFromScope(derived.value, parent.configurationGeneration),
      scope: derived.value,
      deadlineCapped: enlargesDeadline(parent.deadline, requested),
    },
  };
}

/** The deadline a child would run under, without creating a scope. */
export function effectiveChildDeadline(
  parent: RuntimeContext,
  requested: Deadline | null,
): Deadline | null {
  return deriveDeadline(parent.deadline, requested);
}

export type TurnIdentity = {
  readonly workspaceId: WorkspaceId;
  readonly sessionId: SessionId;
  readonly turnId: TurnId;
  readonly traceId: TraceId;
};

export function toTurnContext(context: RuntimeContext, identity: TurnIdentity): TurnContext {
  return { ...context, ...identity };
}
