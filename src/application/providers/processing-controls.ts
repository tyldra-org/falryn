/** Shared host model-service processing contract. Inspection never admits a request. */
import { z } from "zod";
import {
  PROCESSING_MODES,
  type ProcessingPreference,
  type ProcessingReceipt,
  processingPreferenceSchema,
  resolveProcessingPreference,
} from "../../domain/sessions/model-processing.ts";
import type { RoleRoute } from "../../providers/configuration/policy.ts";
import { DEFAULT_INTENT_ROLE_MAP } from "../../providers/configuration/policy.ts";
import { modelSelectionTargetSchema } from "../../providers/configuration/settings-actions.ts";
import type { ModelCatalog } from "../../providers/index.ts";
import type { ProviderAdapterPort } from "../../providers/protocol/port.ts";
import { resolveModelRoute } from "../../providers/routing/routing.ts";
import { inspectModelProcessing } from "./model-processing.ts";

const processingScopeSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("session"), sessionId: z.string().min(1).max(256).optional() }),
  z.strictObject({
    kind: z.enum(["user", "profile"]),
    target: modelSelectionTargetSchema.optional(),
  }),
]);
const savedRevision = z.string().min(1).nullable();
export const processingRequests = [
  z.strictObject({ kind: z.literal("processing-inspect"), scope: processingScopeSchema }),
  z.strictObject({
    kind: z.literal("processing-set"),
    scope: processingScopeSchema,
    preference: processingPreferenceSchema.extend({ mode: z.enum(PROCESSING_MODES) }),
    expectedRevision: savedRevision.optional(),
  }),
  z.strictObject({
    kind: z.literal("processing-reset"),
    scope: processingScopeSchema,
    expectedRevision: savedRevision.optional(),
  }),
] as const;
export type ProcessingRequest = z.infer<(typeof processingRequests)[number]>;
export type ProcessingInspection = ReturnType<typeof inspectModelProcessing>;
export type ProcessingRouteInspection = {
  readonly route: RoleRoute;
  readonly preference: Required<ProcessingPreference>;
  readonly modes: readonly (
    | ProcessingInspection
    | {
        readonly eligible: false;
        readonly reason: string;
        readonly preference: Required<ProcessingPreference>;
      }
  )[];
};

/** Same exact-route resolver, adapter authority and price owner as request admission. */
export function inspectProcessingRoute(
  adapter: ProviderAdapterPort,
  catalog: ModelCatalog,
  route: RoleRoute,
): ProcessingRouteInspection {
  const preference = resolveProcessingPreference([route.processing]);
  const modes = PROCESSING_MODES.map((mode) => {
    const requested = { ...preference, mode };
    const selected = resolveModelRoute({
      policy: { roles: { default: route }, intents: DEFAULT_INTENT_ROLE_MAP },
      processing: requested,
      catalogs: [
        {
          providerId: adapter.identity.providerId,
          profileId: adapter.identity.profileId,
          adapterKind: adapter.identity.adapterKind,
          destinationId: adapter.identity.destinationId,
          modelTransportCompatibility: adapter.supportedModels.flatMap((modelId) => {
            const plan = adapter.transportCompatibilityFor(modelId);
            return plan === null ? [] : [{ modelId, plan }];
          }),
          requestInputModalities: adapter.requestInputModalities,
          catalog,
        },
      ],
    });
    if (selected.kind !== "selected")
      return {
        eligible: false as const,
        reason:
          selected.kind === "no-eligible-route" || selected.kind === "policy-invalid"
            ? selected.code
            : selected.kind,
        preference: requested,
      };
    const inspection = inspectModelProcessing({
      adapter,
      route: selected.receipt,
      ...(selected.capability.pricing === undefined
        ? {}
        : { pricing: selected.capability.pricing }),
    });
    const unknownPrice =
      inspection.price.inputMicrosPerMillion === null ||
      inspection.price.outputMicrosPerMillion === null;
    return route.budgets.cost !== undefined && unknownPrice
      ? { ...inspection, eligible: false, reason: "processing-price-unknown-for-cost-cap" }
      : inspection;
  });
  return { route, preference, modes };
}

export type ProcessingSessionInspection = {
  readonly kind: "processing-inspection";
  readonly scope: { readonly kind: "session"; readonly sessionId: string };
  readonly override: ProcessingPreference | null;
  readonly selection: ProcessingRouteInspection | null;
  readonly lastServed: ProcessingReceipt | null;
  readonly active: Required<ProcessingPreference> | null;
  readonly fileRevision: null;
};
export type ProcessingSessionControl = {
  inspect(): ProcessingSessionInspection;
  change(
    preference: ProcessingPreference | undefined,
    signal?: AbortSignal,
  ):
    | {
        readonly kind: "processing-changed";
        readonly application: "pending";
        readonly inspection: ProcessingSessionInspection;
      }
    | { readonly kind: "failed"; readonly code: string };
};

/** Process-local, main-only preference; receipts come solely from completed attempts. */
export function createProcessingSessionControl(
  sessionId: string,
  inspect: (preference: ProcessingPreference | undefined) => ProcessingRouteInspection | null,
) {
  let preference: ProcessingPreference | undefined;
  let lastServed: ProcessingReceipt | null = null;
  let active: Required<ProcessingPreference> | null = null;
  const control: ProcessingSessionControl = {
    inspect: () => ({
      kind: "processing-inspection",
      scope: { kind: "session", sessionId },
      override: preference ?? null,
      selection: inspect(preference),
      lastServed,
      active,
      fileRevision: null,
    }),
    change(next, signal) {
      if (signal?.aborted) return { kind: "failed", code: "cancelled" };
      if (next !== undefined) {
        const candidate = inspect(next);
        const selected = candidate?.modes.find(
          (mode) => mode.preference.mode === candidate.preference.mode,
        );
        if (!selected?.eligible)
          return { kind: "failed", code: selected?.reason ?? "processing-model-unavailable" };
      }
      preference = next === undefined ? undefined : Object.freeze({ ...next });
      return { kind: "processing-changed", application: "pending", inspection: control.inspect() };
    },
  };
  return {
    control,
    capture: () => preference,
    started(override?: ProcessingPreference) {
      active =
        inspect(override ?? preference)?.preference ??
        resolveProcessingPreference([override, preference]);
    },
    settled(receipts: readonly ProcessingReceipt[]) {
      active = null;
      lastServed = receipts.at(-1) ?? lastServed;
    },
  };
}
