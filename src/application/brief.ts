/**
 * Application boundary for Brief response-style projection (#102).
 *
 * Redacts untrusted style notes, then projects through the domain Brief
 * contract and maps the result onto the prompt-composition `brief` section.
 * Does not choose evidence, call providers, or persist events.
 */

import {
  type BriefError,
  type BriefPolicy,
  type BriefProjection,
  type BriefRequest,
  err,
  ok,
  type PromptSectionInput,
  projectBrief,
  type Result,
  type TurnId,
} from "../domain/index.ts";
import { containsRedactableSecret, redactText } from "./redaction.ts";

export type BriefComposerError =
  | BriefError
  | { readonly kind: "brief"; readonly code: "turn-mismatch"; readonly field: "turnId" };

export type BriefComposerResult = Result<
  {
    readonly projection: BriefProjection;
    readonly section: PromptSectionInput;
  },
  BriefComposerError
>;

export type BriefComposer = {
  project(request: BriefRequest): BriefComposerResult;
  projectForTurn(turnId: TurnId, request: BriefRequest): BriefComposerResult;
};

export function briefSection(projection: BriefProjection): PromptSectionInput {
  return {
    id: "brief",
    role: "brief",
    source: `brief:${projection.receipt.policySource}`,
    content: projection.guidance,
    required: true,
    available: true,
  };
}

function redactPolicyGuidance(request: BriefRequest): Result<BriefRequest, BriefError> {
  const redactGuidance = (guidance: string): Result<string, BriefError> => {
    if (containsRedactableSecret(guidance)) {
      const redacted = redactText(guidance);
      if (containsRedactableSecret(redacted)) {
        return err({ kind: "brief", code: "secret", field: "guidance" });
      }
      return ok(redacted);
    }
    return ok(guidance);
  };

  const redactLayer = (
    policy: BriefPolicy | undefined,
  ): Result<BriefPolicy | undefined, BriefError> => {
    if (policy === undefined || policy.guidance === undefined) {
      return ok(policy);
    }
    const guidance = redactGuidance(policy.guidance);
    if (!guidance.ok) {
      return guidance;
    }
    return ok({ ...policy, guidance: guidance.value });
  };

  if (request.policy !== undefined) {
    const policy = redactLayer(request.policy);
    if (!policy.ok) {
      return policy;
    }
    return ok(policy.value === undefined ? request : { ...request, policy: policy.value });
  }

  if (request.layers === undefined) {
    return ok(request);
  }

  const user = redactLayer(request.layers.user);
  const session = redactLayer(request.layers.session);
  const iface = redactLayer(request.layers.interface);
  const fallback = redactLayer(request.layers.default);
  if (!user.ok) {
    return user;
  }
  if (!session.ok) {
    return session;
  }
  if (!iface.ok) {
    return iface;
  }
  if (!fallback.ok) {
    return fallback;
  }

  return ok({
    ...request,
    layers: {
      ...(user.value === undefined ? {} : { user: user.value }),
      ...(session.value === undefined ? {} : { session: session.value }),
      ...(iface.value === undefined ? {} : { interface: iface.value }),
      ...(fallback.value === undefined ? {} : { default: fallback.value }),
    },
  });
}

export function createBriefComposer(): BriefComposer {
  const project = (request: BriefRequest): BriefComposerResult => {
    const prepared = redactPolicyGuidance(request);
    if (!prepared.ok) {
      return prepared;
    }
    const projected = projectBrief(prepared.value);
    if (!projected.ok) {
      return projected;
    }
    return ok({
      projection: projected.value,
      section: briefSection(projected.value),
    });
  };

  return {
    project,
    projectForTurn(turnId, request) {
      if (request.turnId !== turnId) {
        return err({ kind: "brief", code: "turn-mismatch", field: "turnId" });
      }
      return project(request);
    },
  };
}
