/** Version-two field inheritance. Concrete route identity and reasoning move together. */
import { z } from "zod";
import { namedRouteReferenceSchema } from "./named-route.ts";
import {
  advisorRoleRouteSchema,
  agentPreferenceSchema,
  boundedRecord,
  contributionIdentitySchema,
  fastRoleSettingsSchema,
  MAX_MODEL_DEFINITIONS,
  MAX_WORKFLOW_MODEL_STEPS,
  modelPreferencesSchema,
  modelRoleSettingsSchema,
  nodeIdentitySchema,
  roleRouteBaseSchema,
  subagentRoleSettingsSchema,
  visionRoleRouteSchema,
  workflowPreferenceSchema,
  workflowRoleSettingsSchema,
} from "./policy-schema.ts";
import { FAST_OPTIONS, SUBAGENT_PRESETS } from "./roles.ts";

const route = z.union([
  roleRouteBaseSchema.partial(),
  roleRouteBaseSchema.partial().extend({ kind: z.literal("concrete") }),
  namedRouteReferenceSchema,
]);
const agent = agentPreferenceSchema.extend({ route: route.optional() });
const workflow = workflowPreferenceSchema.extend({
  default: route.optional(),
  steps: boundedRecord(nodeIdentitySchema, route, MAX_WORKFLOW_MODEL_STEPS).optional(),
});
export const workingModelPreferencesSchema = modelPreferencesSchema.partial().extend({
  intents: modelPreferencesSchema.shape.intents.unwrap().partial().optional(),
  roles: modelRoleSettingsSchema
    .extend({
      default: route.optional(),
      plan: route.optional(),
      vision: z
        .union([
          visionRoleRouteSchema.partial(),
          visionRoleRouteSchema.partial().extend({ kind: z.literal("concrete") }),
          namedRouteReferenceSchema.extend({ use: visionRoleRouteSchema.shape.use.optional() }),
        ])
        .optional(),
      advisor: z
        .union([
          advisorRoleRouteSchema.partial(),
          advisorRoleRouteSchema.partial().extend({ kind: z.literal("concrete") }),
          namedRouteReferenceSchema.extend({ use: advisorRoleRouteSchema.shape.use.optional() }),
        ])
        .optional(),
      fast: fastRoleSettingsSchema
        .extend({
          default: route.optional(),
          options: z.partialRecord(z.enum(FAST_OPTIONS), route).optional(),
        })
        .optional(),
      subagents: subagentRoleSettingsSchema
        .extend({
          default: route.optional(),
          presets: z.partialRecord(z.enum(SUBAGENT_PRESETS), route).optional(),
          agents: boundedRecord(
            contributionIdentitySchema,
            agent,
            MAX_MODEL_DEFINITIONS,
          ).optional(),
        })
        .optional(),
      workflows: workflowRoleSettingsSchema
        .extend({
          default: route.optional(),
          definitions: boundedRecord(
            contributionIdentitySchema,
            workflow,
            MAX_MODEL_DEFINITIONS,
          ).optional(),
        })
        .optional(),
    })
    .optional(),
});

type RecordValue = Record<string, unknown>;
function record(value: unknown): RecordValue {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as RecordValue)
    : {};
}
function mergeRoute(base: unknown, incoming: unknown): unknown {
  const previous = record(base),
    next = record(incoming);
  if (next.kind === "route" && (previous.kind !== "route" || next.routeId !== previous.routeId))
    return next;
  if (
    previous.kind === "route" &&
    (next.kind === "concrete" || next.modelId !== undefined || next.providerProfileId !== undefined)
  )
    return next;
  const changed = ["modelId", "providerId", "providerProfileId"].some(
    (key) => next[key] !== undefined && next[key] !== previous[key],
  );
  return {
    ...previous,
    ...next,
    ...(next.processing === undefined
      ? {}
      : { processing: { ...record(previous.processing), ...record(next.processing) } }),
    ...(changed && next.reasoning === undefined ? { reasoning: "provider-default" } : {}),
  };
}
function mergeEntries(
  base: unknown,
  incoming: unknown,
  fold: (a: unknown, b: unknown) => unknown,
): RecordValue {
  const result = { ...record(base) };
  for (const [key, value] of Object.entries(record(incoming)))
    result[key] = fold(result[key], value);
  return result;
}
function mergeGroup(base: unknown, incoming: unknown, maps: readonly string[]): RecordValue {
  const previous = record(base),
    next = record(incoming);
  const result = { ...previous, ...next };
  if (next.default !== undefined) result.default = mergeRoute(previous.default, next.default);
  for (const key of maps)
    if (next[key] !== undefined) result[key] = mergeEntries(previous[key], next[key], mergeRoute);
  return result;
}

export function foldWorkingModelPreferences(base: unknown, incoming: unknown): unknown {
  const previous = record(base),
    next = record(incoming);
  const roles = { ...record(previous.roles), ...record(next.roles) };
  for (const [key, value] of Object.entries(record(next.roles))) {
    const old = record(previous.roles)[key];
    if (["default", "plan", "vision", "advisor"].includes(key)) roles[key] = mergeRoute(old, value);
    if (key === "fast") {
      roles.fast = {
        ...mergeGroup(old, value, ["options"]),
        ...(record(value).use === undefined
          ? {}
          : { use: { ...record(record(old).use), ...record(record(value).use) } }),
      };
    }
    if (key === "subagents") {
      const group = mergeGroup(old, value, ["presets"]);
      if (record(value).agents !== undefined)
        group.agents = mergeEntries(record(old).agents, record(value).agents, (a, b) => ({
          ...record(a),
          ...record(b),
          ...(record(b).route === undefined
            ? {}
            : { route: mergeRoute(record(a).route, record(b).route) }),
        }));
      roles.subagents = group;
    }
    if (key === "workflows") {
      const group = mergeGroup(old, value, []);
      if (record(value).definitions !== undefined)
        group.definitions = mergeEntries(
          record(old).definitions,
          record(value).definitions,
          (a, b) => mergeGroup(a, b, ["steps"]),
        );
      roles.workflows = group;
    }
  }
  return {
    ...previous,
    ...next,
    roles,
    ...(next.processing === undefined
      ? {}
      : { processing: { ...record(previous.processing), ...record(next.processing) } }),
    ...(next.intents === undefined
      ? {}
      : { intents: { ...record(previous.intents), ...record(next.intents) } }),
  };
}
