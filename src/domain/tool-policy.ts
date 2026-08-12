/**
 * Policy, effect classification, and focused confirmation before dispatch (#50).
 *
 * Consumes {@link DispatchReadyInvocation} from #49. Classifies the declared
 * effect class, decides allow / deny / require focused confirmation, and gates
 * consequential work on an explicit confirmation bound to normalized input.
 * Observed confirmation outcomes are reported separately from requested intent.
 * Fail closed. Does not schedule or execute tools (#51).
 *
 * Effect classes remain the closed set from `work.ts` (#44 / #48); this module
 * extends that classification for confirmation posture rather than forking it.
 */

import type { CapabilityId, InvocationId } from "./identity.ts";
import { assertNever } from "./result.ts";
import type { DispatchReadyInvocation } from "./tool-invocation.ts";
import { type EffectClass, isEffectClass } from "./work.ts";

/** Schema version this build writes for policy-authorized invocations. */
export const TOOL_POLICY_SCHEMA_VERSION = 1;

/**
 * Whether the effect class requires focused confirmation by default.
 *
 * Observation is allowed without confirmation. Mutation, external, and
 * interactive work is consequential and waits for an explicit confirm.
 */
export type ConfirmationPosture = "none" | "focused";

export type EffectClassification = {
  readonly effectClass: EffectClass;
  readonly consequential: boolean;
  readonly confirmationPosture: ConfirmationPosture;
};

/**
 * Deny reasons before any executor runs. Always carry no effect.
 */
export type ToolPolicyDenyReason =
  | { readonly code: "denied-by-name"; readonly name: string }
  | { readonly code: "denied-by-capability"; readonly capabilityId: CapabilityId }
  | { readonly code: "denied-by-effect"; readonly effectClass: EffectClass }
  | { readonly code: "invalid-effect"; readonly effect: string }
  | {
      readonly code: "confirmation-refused";
      readonly confirmationId: string;
    }
  | {
      readonly code: "confirmation-mismatch";
      readonly expected: string;
      readonly confirmed: string;
    }
  | {
      readonly code: "confirmation-stale";
      readonly expected: string;
      readonly current: string;
    };

/**
 * Exhaustive policy outcomes for one dispatch-ready invocation.
 *
 * `require-confirmation` is not authorization: dispatch must wait until
 * {@link resolveFocusedConfirmation} accepts an exact confirmation, or the
 * call is denied. Pre-dispatch deny always reports `effect: "none"`.
 */
export type ToolPolicyDecision =
  | {
      readonly decision: "allow";
      readonly classification: EffectClassification;
      readonly invocation: DispatchReadyInvocation;
    }
  | {
      readonly decision: "deny";
      readonly reason: ToolPolicyDenyReason;
      readonly classification: EffectClassification | null;
      readonly invocation: DispatchReadyInvocation;
      readonly effect: "none";
    }
  | {
      readonly decision: "require-confirmation";
      readonly classification: EffectClassification;
      readonly invocation: DispatchReadyInvocation;
      readonly confirmation: FocusedConfirmationRequest;
    };

/**
 * Requested intent shown at the confirmation gate.
 *
 * Carries normalized input (not raw proposal text) so confirmation rebinds when
 * material arguments change.
 */
export type FocusedConfirmationRequest = {
  readonly confirmationId: string;
  readonly invocationId: InvocationId;
  readonly toolName: string;
  readonly capabilityId: CapabilityId;
  readonly effectClass: EffectClass;
  readonly title: string;
  readonly normalizedInput: Readonly<Record<string, unknown>>;
  /** Stable fingerprint of capability + normalized input for rebinding. */
  readonly inputFingerprint: string;
};

/** Explicit user/agent confirmation for one exact request identity. */
export type FocusedConfirmation = {
  readonly confirmationId: string;
};

/**
 * Observed confirmation outcome — separate from the caller's requested intent.
 *
 * `accepted` authorizes later schedule/execute stages. All other statuses leave
 * effect as `none` (nothing ran).
 */
export type FocusedConfirmationOutcome =
  | {
      readonly status: "accepted";
      readonly confirmationId: string;
      readonly requestedIntent: FocusedConfirmationRequest;
      readonly observed: "confirmed";
      readonly effect: "none";
    }
  | {
      readonly status: "missing";
      readonly confirmationId: string;
      readonly requestedIntent: FocusedConfirmationRequest;
      readonly observed: "not-confirmed";
      readonly effect: "none";
    }
  | {
      readonly status: "mismatch";
      readonly expected: string;
      readonly confirmed: string;
      readonly requestedIntent: FocusedConfirmationRequest;
      readonly observed: "not-confirmed";
      readonly effect: "none";
    }
  | {
      readonly status: "stale";
      readonly expected: string;
      readonly current: string;
      readonly requestedIntent: FocusedConfirmationRequest;
      readonly observed: "not-confirmed";
      readonly effect: "none";
    }
  | {
      readonly status: "refused";
      readonly confirmationId: string;
      readonly requestedIntent: FocusedConfirmationRequest;
      readonly observed: "refused";
      readonly effect: "none";
    };

/**
 * Immutable record that later schedule/execute stages may consume.
 *
 * Presence of this record means policy allowed the invocation (either because
 * confirmation was not required, or because focused confirmation was accepted).
 * It is not an execution receipt.
 */
export type PolicyAuthorizedInvocation = {
  readonly schemaVersion: typeof TOOL_POLICY_SCHEMA_VERSION;
  readonly invocation: DispatchReadyInvocation;
  readonly classification: EffectClassification;
  readonly confirmation:
    | { readonly required: false }
    | {
        readonly required: true;
        readonly confirmationId: string;
        readonly observed: "confirmed";
      };
};

export type ToolPolicyProfile = {
  /** Catalog names that are always denied. */
  readonly deniedNames?: ReadonlySet<string>;
  /** Capability ids that are always denied. */
  readonly deniedCapabilityIds?: ReadonlySet<CapabilityId>;
  /** Effect classes that are always denied. */
  readonly deniedEffects?: ReadonlySet<EffectClass>;
  /**
   * Effect classes that skip focused confirmation even when consequential.
   * Use sparingly; default profile requires confirmation for all consequential
   * classes.
   */
  readonly autoAllowEffects?: ReadonlySet<EffectClass>;
  /**
   * Effect classes forced to require confirmation even when classification
   * says otherwise (e.g. treating a sensitive observation as focused).
   */
  readonly forceConfirmationEffects?: ReadonlySet<EffectClass>;
};

export const DEFAULT_TOOL_POLICY_PROFILE: ToolPolicyProfile = Object.freeze({});

const TOOL_POLICY_DENY_CODES = [
  "denied-by-name",
  "denied-by-capability",
  "denied-by-effect",
  "invalid-effect",
  "confirmation-refused",
  "confirmation-mismatch",
  "confirmation-stale",
] as const;

export type ToolPolicyDenyCode = (typeof TOOL_POLICY_DENY_CODES)[number];

export function isToolPolicyDenyCode(value: unknown): value is ToolPolicyDenyCode {
  return typeof value === "string" && (TOOL_POLICY_DENY_CODES as readonly string[]).includes(value);
}

/**
 * Classify a declared effect class for confirmation posture.
 *
 * Unknown values fail closed at the policy boundary via {@link evaluateToolPolicy}.
 */
export function classifyEffectForPolicy(effect: EffectClass): EffectClassification {
  switch (effect) {
    case "observation":
      return {
        effectClass: effect,
        consequential: false,
        confirmationPosture: "none",
      };
    case "mutation":
    case "external":
    case "interactive":
      return {
        effectClass: effect,
        consequential: true,
        confirmationPosture: "focused",
      };
    default:
      return assertNever(effect, "unhandled effect class for policy");
  }
}

/** Default profile: deny lists empty; consequential effects require confirmation. */
export function evaluateToolPolicy(
  invocation: DispatchReadyInvocation,
  profile: ToolPolicyProfile = DEFAULT_TOOL_POLICY_PROFILE,
): ToolPolicyDecision {
  const declared = invocation.entry.manifest.effect;
  if (!isEffectClass(declared)) {
    return {
      decision: "deny",
      reason: { code: "invalid-effect", effect: String(declared) },
      classification: null,
      invocation,
      effect: "none",
    };
  }

  const classification = classifyEffectForPolicy(declared);
  const name = invocation.entry.manifest.name;
  const capabilityId = invocation.entry.manifest.capabilityId;

  if (profile.deniedNames?.has(name) === true) {
    return {
      decision: "deny",
      reason: { code: "denied-by-name", name },
      classification,
      invocation,
      effect: "none",
    };
  }
  if (profile.deniedCapabilityIds?.has(capabilityId) === true) {
    return {
      decision: "deny",
      reason: { code: "denied-by-capability", capabilityId },
      classification,
      invocation,
      effect: "none",
    };
  }
  if (profile.deniedEffects?.has(classification.effectClass) === true) {
    return {
      decision: "deny",
      reason: { code: "denied-by-effect", effectClass: classification.effectClass },
      classification,
      invocation,
      effect: "none",
    };
  }

  const forceConfirm = profile.forceConfirmationEffects?.has(classification.effectClass) === true;
  const autoAllow = profile.autoAllowEffects?.has(classification.effectClass) === true;
  const needsConfirmation =
    forceConfirm || (classification.confirmationPosture === "focused" && !autoAllow);

  if (!needsConfirmation) {
    return {
      decision: "allow",
      classification,
      invocation,
    };
  }

  return {
    decision: "require-confirmation",
    classification,
    invocation,
    confirmation: createFocusedConfirmationRequest(invocation, classification),
  };
}

/**
 * Build a focused confirmation request bound to normalized input.
 *
 * The confirmation id is derived from capability identity and the normalized
 * input fingerprint so a material argument change expires the prior confirm.
 */
export function createFocusedConfirmationRequest(
  invocation: DispatchReadyInvocation,
  classification: EffectClassification = classifyEffectForPolicy(invocation.entry.manifest.effect),
): FocusedConfirmationRequest {
  const capabilityId = invocation.entry.manifest.capabilityId;
  const inputFingerprint = confirmationInputFingerprint(
    capabilityId,
    invocation.input,
    classification.effectClass,
  );
  const confirmationId = focusedConfirmationId(invocation.invocationId, inputFingerprint);
  return {
    confirmationId,
    invocationId: invocation.invocationId,
    toolName: invocation.entry.manifest.name,
    capabilityId,
    effectClass: classification.effectClass,
    title: invocation.entry.manifest.title,
    normalizedInput: invocation.input,
    inputFingerprint,
  };
}

/**
 * Resolve an explicit confirmation against the current request.
 *
 * Recomputes the fingerprint from the live invocation so stale normalized
 * input cannot authorize a different effect. Observed status is always
 * reported separately from the request's intended operation.
 */
export function resolveFocusedConfirmation(options: {
  readonly request: FocusedConfirmationRequest;
  readonly invocation: DispatchReadyInvocation;
  readonly confirmation: FocusedConfirmation | null;
  readonly refused?: boolean;
}): FocusedConfirmationOutcome {
  const { request, invocation, confirmation, refused = false } = options;
  const liveFingerprint = confirmationInputFingerprint(
    invocation.entry.manifest.capabilityId,
    invocation.input,
    invocation.entry.manifest.effect,
  );
  const liveConfirmationId = focusedConfirmationId(invocation.invocationId, liveFingerprint);

  if (
    liveConfirmationId !== request.confirmationId ||
    liveFingerprint !== request.inputFingerprint
  ) {
    return {
      status: "stale",
      expected: request.confirmationId,
      current: liveConfirmationId,
      requestedIntent: request,
      observed: "not-confirmed",
      effect: "none",
    };
  }

  if (refused) {
    return {
      status: "refused",
      confirmationId: request.confirmationId,
      requestedIntent: request,
      observed: "refused",
      effect: "none",
    };
  }

  if (confirmation === null) {
    return {
      status: "missing",
      confirmationId: request.confirmationId,
      requestedIntent: request,
      observed: "not-confirmed",
      effect: "none",
    };
  }

  if (confirmation.confirmationId !== request.confirmationId) {
    return {
      status: "mismatch",
      expected: request.confirmationId,
      confirmed: confirmation.confirmationId,
      requestedIntent: request,
      observed: "not-confirmed",
      effect: "none",
    };
  }

  return {
    status: "accepted",
    confirmationId: request.confirmationId,
    requestedIntent: request,
    observed: "confirmed",
    effect: "none",
  };
}

/**
 * Evaluate policy and optionally apply a focused confirmation in one step.
 *
 * Returns a {@link PolicyAuthorizedInvocation} only when dispatch is allowed.
 * Confirmation still required, denied, or refused outcomes fail closed with
 * `effect: "none"`.
 */
export function authorizeToolInvocation(options: {
  readonly invocation: DispatchReadyInvocation;
  readonly profile?: ToolPolicyProfile;
  readonly confirmation?: FocusedConfirmation | null;
  readonly refused?: boolean;
}):
  | { readonly ok: true; readonly value: PolicyAuthorizedInvocation }
  | {
      readonly ok: false;
      readonly decision: Extract<ToolPolicyDecision, { decision: "deny" | "require-confirmation" }>;
      readonly confirmationOutcome: FocusedConfirmationOutcome | null;
    } {
  const profile = options.profile ?? DEFAULT_TOOL_POLICY_PROFILE;
  const decision = evaluateToolPolicy(options.invocation, profile);

  switch (decision.decision) {
    case "allow":
      return {
        ok: true,
        value: {
          schemaVersion: TOOL_POLICY_SCHEMA_VERSION,
          invocation: decision.invocation,
          classification: decision.classification,
          confirmation: { required: false },
        },
      };
    case "deny":
      return { ok: false, decision, confirmationOutcome: null };
    case "require-confirmation": {
      const confirmationOutcome = resolveFocusedConfirmation({
        request: decision.confirmation,
        invocation: options.invocation,
        confirmation: options.confirmation ?? null,
        ...(options.refused === undefined ? {} : { refused: options.refused }),
      });
      switch (confirmationOutcome.status) {
        case "accepted":
          return {
            ok: true,
            value: {
              schemaVersion: TOOL_POLICY_SCHEMA_VERSION,
              invocation: decision.invocation,
              classification: decision.classification,
              confirmation: {
                required: true,
                confirmationId: confirmationOutcome.confirmationId,
                observed: "confirmed",
              },
            },
          };
        case "missing":
          return {
            ok: false,
            decision,
            confirmationOutcome,
          };
        case "mismatch":
          return {
            ok: false,
            decision: {
              decision: "deny",
              reason: {
                code: "confirmation-mismatch",
                expected: confirmationOutcome.expected,
                confirmed: confirmationOutcome.confirmed,
              },
              classification: decision.classification,
              invocation: decision.invocation,
              effect: "none",
            },
            confirmationOutcome,
          };
        case "stale":
          return {
            ok: false,
            decision: {
              decision: "deny",
              reason: {
                code: "confirmation-stale",
                expected: confirmationOutcome.expected,
                current: confirmationOutcome.current,
              },
              classification: decision.classification,
              invocation: decision.invocation,
              effect: "none",
            },
            confirmationOutcome,
          };
        case "refused":
          return {
            ok: false,
            decision: {
              decision: "deny",
              reason: {
                code: "confirmation-refused",
                confirmationId: confirmationOutcome.confirmationId,
              },
              classification: decision.classification,
              invocation: decision.invocation,
              effect: "none",
            },
            confirmationOutcome,
          };
        default:
          return assertNever(confirmationOutcome, "unhandled focused confirmation outcome");
      }
    }
    default:
      return assertNever(decision, "unhandled tool policy decision");
  }
}

/** Stable fingerprint over capability, effect, and normalized input. */
export function confirmationInputFingerprint(
  capabilityId: CapabilityId,
  normalizedInput: Readonly<Record<string, unknown>>,
  effectClass: EffectClass,
): string {
  return JSON.stringify([capabilityId, effectClass, canonicalizeJson(normalizedInput)]);
}

function focusedConfirmationId(invocationId: InvocationId, inputFingerprint: string): string {
  return JSON.stringify(["tool-confirm", invocationId, inputFingerprint]);
}

/**
 * Deterministic JSON for confirmation binding. Object keys are sorted; arrays
 * keep order. Never used as a security hash — only for equality of normalized
 * intent between prompt and confirm.
 */
export function canonicalizeJson(value: unknown): unknown {
  if (value === null || typeof value !== "object") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => canonicalizeJson(entry));
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  const out: Record<string, unknown> = {};
  for (const key of keys) {
    out[key] = canonicalizeJson(record[key]);
  }
  return out;
}

/** Exhaustiveness helper for callers switching on deny reasons. */
export function describeToolPolicyDenyReason(reason: ToolPolicyDenyReason): string {
  switch (reason.code) {
    case "denied-by-name":
      return "denied-by-name";
    case "denied-by-capability":
      return "denied-by-capability";
    case "denied-by-effect":
      return "denied-by-effect";
    case "invalid-effect":
      return "invalid-effect";
    case "confirmation-refused":
      return "confirmation-refused";
    case "confirmation-mismatch":
      return "confirmation-mismatch";
    case "confirmation-stale":
      return "confirmation-stale";
    default:
      return assertNever(reason, "unhandled tool policy deny reason");
  }
}
