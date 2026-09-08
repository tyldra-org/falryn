/** Shared model settings actions. Selection is inspectable without admitting work. */
import { z } from "zod";
import type {
  ModelDefinition,
  ModelSelectionTarget,
} from "../../providers/configuration/model-selection.ts";
import {
  modelDefinitionPage,
  resolveModelSelection,
} from "../../providers/configuration/model-selection.ts";
import type { RoleRoute } from "../../providers/configuration/policy.ts";
import { previewModelPolicyMigration } from "../../providers/configuration/policy-migration.ts";
import {
  EMPTY_MODEL_PREFERENCES,
  type ModelPreferences,
  modelPreferencesSchema,
} from "../../providers/configuration/policy-schema.ts";
import {
  FAST_OPTIONS,
  MODEL_ROLES,
  SUBAGENT_PRESETS,
} from "../../providers/configuration/roles.ts";
import {
  editModelPreferences,
  modelSelectionTargetSchema,
  modelSettingsEditSchema,
} from "../../providers/configuration/settings-actions.ts";

const expectedRevisionSchema = z.string().min(1).nullable();
const decisionsSchema = z.record(
  z.string().max(512),
  z.enum(["keep-current", "use-legacy", "normalize"]),
);
export const modelSettingsRequestSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("inspect"),
    target: modelSelectionTargetSchema.optional(),
    search: z.string().max(256).optional(),
    offset: z.number().int().nonnegative().optional(),
    catalog: z.enum(["agent", "workflow"]).optional(),
  }),
  z.strictObject({
    kind: z.literal("edit"),
    edit: modelSettingsEditSchema,
    expectedRevision: expectedRevisionSchema,
  }),
  z.strictObject({
    kind: z.literal("preview-migration"),
    original: z.unknown(),
    decisions: decisionsSchema.optional(),
  }),
  z.strictObject({
    kind: z.literal("apply-migration"),
    original: z.unknown(),
    decisions: decisionsSchema,
    candidate: modelPreferencesSchema,
    expectedRevision: expectedRevisionSchema,
  }),
  z.strictObject({ kind: z.literal("preview-clear") }),
  z.strictObject({
    kind: z.literal("apply-clear"),
    paths: z.array(z.string().max(1024)).max(300_000),
    expectedRevision: expectedRevisionSchema,
  }),
]);
export type ModelSettingsRequest = z.infer<typeof modelSettingsRequestSchema>;
export type ModelSettingsSnapshot = {
  readonly preferences: ModelPreferences;
  readonly fileRevision: string | null;
  readonly generation: number;
  readonly scope: "user" | "profile";
  readonly main: RoleRoute | null;
  readonly definitions: readonly ModelDefinition[];
};
export type ModelSettingsStore = {
  read(signal?: AbortSignal): Promise<ModelSettingsSnapshot>;
  write(
    preferences: ModelPreferences,
    expectedRevision: string | null,
    signal?: AbortSignal,
  ): Promise<
    | { readonly kind: "written"; readonly revision: string }
    | { readonly kind: "stale" | "cancelled" | "failed"; readonly code: string }
  >;
  /** Durable, recoverable original must settle before the new state is published. */
  backup(
    original: unknown,
    expectedRevision: string | null,
    signal?: AbortSignal,
  ): Promise<
    { readonly ok: true; readonly location: string } | { readonly ok: false; readonly code: string }
  >;
  /** Exact provider/account/model validation; never opens a second credential store. */
  validateRoute(
    route: RoleRoute,
    signal?: AbortSignal,
  ): Promise<{ readonly ok: true } | { readonly ok: false; readonly code: string }>;
};
export type ModelSettingsService = ReturnType<typeof createModelSettingsService>;
export function createModelSettingsService(store: ModelSettingsStore) {
  return {
    async execute(raw: unknown, signal?: AbortSignal) {
      const parsed = modelSettingsRequestSchema.safeParse(raw);
      if (!parsed.success) return failure("invalid-model-settings-request");
      if (signal?.aborted) return failure("cancelled");
      const request = parsed.data;
      let snapshot: ModelSettingsSnapshot;
      try {
        snapshot = await store.read(signal);
      } catch {
        return failure("configuration-unavailable");
      }
      const { preferences } = snapshot;
      if (request.kind === "inspect") {
        const targets: ModelSelectionTarget[] =
          request.target !== undefined
            ? [request.target]
            : [
                ...MODEL_ROLES.map((role) => ({ kind: "role" as const, role })),
                ...SUBAGENT_PRESETS.map((preset) => ({ kind: "preset" as const, preset })),
                ...FAST_OPTIONS.map((option) => ({ kind: "fast" as const, option })),
              ];
        const catalog =
          request.catalog === undefined
            ? null
            : modelDefinitionPage({
                preferences,
                definitions: snapshot.definitions,
                kind: request.catalog,
                ...(request.search === undefined ? {} : { search: request.search }),
                ...(request.offset === undefined ? {} : { offset: request.offset }),
              });
        for (const entry of catalog?.entries ?? [])
          targets.push({ kind: request.catalog === "agent" ? "agent" : "workflow", id: entry.id });
        const rows = [];
        for (const target of targets) {
          const selection =
            snapshot.main === null
              ? null
              : resolveModelSelection({
                  preferences,
                  main: snapshot.main,
                  configurationGeneration: snapshot.generation,
                  definitions: snapshot.definitions,
                  target,
                });
          const compatibility =
            selection?.kind === "route" ? await store.validateRoute(selection.route, signal) : null;
          const definition =
            "id" in target
              ? (snapshot.definitions.find((entry) => entry.id === target.id) ?? null)
              : null;
          rows.push({ target, selection, compatibility, definition });
        }
        return {
          kind: "inspection" as const,
          preferences,
          fileRevision: snapshot.fileRevision,
          scope: snapshot.scope,
          configurationGeneration: snapshot.generation,
          catalog,
          rows,
        };
      }
      if (request.kind === "preview-migration")
        return previewModelPolicyMigration(request.original, preferences, request.decisions);
      const paths = [
        ...overridePaths(preferences.roles),
        ...Object.entries(preferences.intents)
          .filter(
            ([key, value]) =>
              EMPTY_MODEL_PREFERENCES.intents[key as keyof typeof preferences.intents] !== value,
          )
          .map(([key]) => `intents.${key}`)
          .sort(),
      ];
      if (request.kind === "preview-clear")
        return { kind: "clear-preview" as const, paths, expectedRevision: snapshot.fileRevision };
      if (request.expectedRevision !== snapshot.fileRevision) return failure("stale-settings");
      let candidate: ModelPreferences;
      let backup: string | null = null;
      if (request.kind === "edit") {
        if (request.edit.kind === "configure") {
          const target = request.edit.target;
          if (
            target.kind === "step" &&
            snapshot.definitions.some(
              (definition) =>
                definition.kind === "workflow" &&
                definition.id === target.id &&
                definition.nodes.some(
                  (node) => node.key === target.key && node.kind === "deterministic",
                ),
            )
          )
            return failure("deterministic-step-has-no-model");
          const validity = await store.validateRoute(request.edit.route, signal);
          if (!validity.ok) return failure(validity.code);
          for (const fallback of request.edit.route.fallbacks) {
            const validity = await store.validateRoute(
              { ...fallback, reasoning: "provider-default", fallbacks: [], budgets: {} },
              signal,
            );
            if (!validity.ok) return failure(`fallback-${validity.code}`);
          }
        }
        try {
          candidate = editModelPreferences(preferences, request.edit);
        } catch {
          return failure("model-preference-limit-exceeded");
        }
        const target =
          request.edit.kind === "membership"
            ? ({ kind: "agent", id: request.edit.id } as const)
            : request.edit.kind === "configure"
              ? request.edit.target
              : null;
        if (target !== null && "id" in target) {
          const definition = snapshot.definitions.find(
            (entry) =>
              entry.id === target.id &&
              entry.kind === (target.kind === "agent" ? "agent" : "workflow"),
          );
          const saved =
            target.kind === "agent"
              ? candidate.roles.subagents?.agents?.[target.id]
              : candidate.roles.workflows?.definitions?.[target.id];
          if (definition !== undefined && saved !== undefined) {
            saved.definitionRevision ??= definition.revision;
            saved.schemaRevision ??= definition.schemaRevision;
          }
        }
      } else if (request.kind === "apply-clear") {
        if (JSON.stringify(paths) !== JSON.stringify(request.paths))
          return failure("stale-clear-preview");
        candidate = { ...EMPTY_MODEL_PREFERENCES, revision: preferences.revision };
      } else {
        const preview = previewModelPolicyMigration(
          request.original,
          preferences,
          request.decisions,
        );
        if (preview.kind !== "preview") return failure("invalid-legacy-policy");
        if (preview.unresolved.length > 0) return failure("migration-conflicts-unresolved");
        if (JSON.stringify(preview.candidate) !== JSON.stringify(request.candidate))
          return failure("stale-migration-preview");
        const saved = await store.backup(
          { original: preview.original, previous: preferences, changes: preview.changes },
          snapshot.fileRevision,
          signal,
        );
        if (!saved.ok) return failure(saved.code);
        backup = saved.location;
        candidate = preview.candidate;
      }
      if (signal?.aborted) return failure("cancelled");
      candidate = modelPreferencesSchema.parse({
        ...candidate,
        revision: preferences.revision + 1,
      });
      const written = await store.write(candidate, snapshot.fileRevision, signal);
      return written.kind === "written"
        ? {
            kind: "written" as const,
            revision: written.revision,
            policyRevision: candidate.revision,
            backup,
          }
        : failure(written.code);
    },
  };
}
function failure(code: string) {
  return { kind: "failed" as const, code };
}
function overridePaths(value: unknown, prefix = "roles"): string[] {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return [prefix];
  const record = value as Record<string, unknown>;
  if (Object.hasOwn(record, "modelId")) return [prefix];
  return Object.keys(record)
    .sort()
    .flatMap((key) => overridePaths(record[key], `${prefix}.${key}`));
}
export type ModelSettingsResult = Awaited<ReturnType<ModelSettingsService["execute"]>>;
