import { expect, test } from "bun:test";
import type { ModelDefinition } from "../../providers/configuration/model-selection.ts";
import {
  EMPTY_MODEL_PREFERENCES,
  type ModelPreferences,
  roleRouteBaseSchema,
} from "../../providers/configuration/policy-schema.ts";
import { createModelSettingsService, type ModelSettingsStore } from "./model-settings.ts";
import { modelSettingsLines } from "./model-settings-format.ts";

const route = (modelId: string) =>
  roleRouteBaseSchema.parse({ providerProfileId: "account", providerId: "test", modelId });
function fixture(definitions: readonly ModelDefinition[] = []) {
  let preferences: ModelPreferences = structuredClone(EMPTY_MODEL_PREFERENCES);
  let fileRevision: string | null = null;
  let failWrite = false;
  let failBackup = false;
  const events: string[] = [];
  const backups: unknown[] = [];
  const store: ModelSettingsStore = {
    async read() {
      return {
        preferences,
        fileRevision,
        generation: 1,
        scope: "user",
        main: route("main"),
        definitions,
      };
    },
    async validateRoute(selected) {
      return selected.reasoning === "max"
        ? { ok: false, code: "unsupported-thinking" }
        : { ok: true };
    },
    async write(candidate, expected, signal) {
      events.push("write");
      if (signal?.aborted) return { kind: "cancelled", code: "cancelled" };
      if (expected !== fileRevision) return { kind: "stale", code: "stale" };
      if (failWrite) return { kind: "failed", code: "write-failed" };
      preferences = candidate;
      fileRevision = `revision-${candidate.revision}`;
      return { kind: "written", revision: fileRevision };
    },
    async backup(original) {
      events.push("backup");
      if (failBackup) return { ok: false, code: "backup-failed" };
      backups.push(original);
      return { ok: true, location: "recovery.json" };
    },
  };
  return {
    store,
    service: createModelSettingsService(store),
    events,
    backups,
    get: () => preferences,
    failWrite: (value: boolean) => {
      failWrite = value;
    },
    failBackup: (value: boolean) => {
      failBackup = value;
    },
  };
}
test("inspect and configure do not launch anything; stale edits and unsupported thinking fail", async () => {
  const f = fixture();
  const inspection = await f.service.execute({ kind: "inspect" });
  expect(inspection.kind).toBe("inspection");
  expect(f.events).toEqual([]);
  const edit = {
    kind: "edit",
    edit: { kind: "configure", target: { kind: "role", role: "fast" }, route: route("cheap") },
    expectedRevision: null,
  };
  expect((await f.service.execute(edit)).kind).toBe("written");
  expect(await f.service.execute(edit)).toEqual({ kind: "failed", code: "stale-settings" });
  expect(
    await f.service.execute({
      ...edit,
      expectedRevision: "revision-1",
      edit: { ...edit.edit, route: { ...route("bad"), reasoning: "max" } },
    }),
  ).toEqual({ kind: "failed", code: "unsupported-thinking" });
  expect(String(f.get().roles.fast?.default?.modelId)).toBe("cheap");
});

test("saved definition revisions survive edits, reset removes empty entries, and deterministic nodes reject models", async () => {
  const agent: ModelDefinition = {
    kind: "agent",
    id: "user:agent",
    label: "Agent",
    revision: "v1",
    schemaRevision: 1,
    provenance: "user",
    availability: "available",
    unavailableReason: null,
  };
  const flow: ModelDefinition = {
    ...agent,
    kind: "workflow",
    id: agent.id,
    nodes: [{ kind: "deterministic", key: "join" }],
  };
  const f = fixture([agent, flow]);
  const inspection = await f.service.execute({
    kind: "inspect",
    target: { kind: "workflow", id: flow.id },
  });
  expect(inspection.kind === "inspection" && inspection.rows[0]?.definition?.kind).toBe("workflow");
  expect(
    (
      await f.service.execute({
        kind: "edit",
        edit: {
          kind: "configure",
          target: { kind: "agent", id: agent.id },
          route: route("chosen"),
        },
        expectedRevision: null,
      })
    ).kind,
  ).toBe("written");
  expect(f.get().roles.subagents?.agents?.[agent.id]?.definitionRevision).toBe("v1");
  expect(
    await f.service.execute({
      kind: "edit",
      edit: {
        kind: "configure",
        target: { kind: "step", id: flow.id, key: "join" },
        route: route("never"),
      },
      expectedRevision: "revision-1",
    }),
  ).toEqual({ kind: "failed", code: "deterministic-step-has-no-model" });
  expect(
    (
      await f.service.execute({
        kind: "edit",
        edit: { kind: "reset", target: { kind: "agent", id: agent.id } },
        expectedRevision: "revision-1",
      })
    ).kind,
  ).toBe("written");
  expect(f.get().roles.subagents?.agents?.[agent.id]).toBeUndefined();
});
test("migration preview/cancel/failure/restart preserve settings and backup precedes publication", async () => {
  const f = fixture();
  const original = {
    roles: { default: route("old"), compact: { ...route("helper"), use: "off" } },
  };
  const preview = await f.service.execute({ kind: "preview-migration", original });
  if (preview.kind !== "preview") throw new Error("Expected migration preview");
  expect(f.events).toEqual([]);
  const apply = {
    kind: "apply-migration",
    original,
    candidate: preview.candidate,
    decisions: {},
    expectedRevision: null,
  };
  const controller = new AbortController();
  controller.abort();
  expect(await f.service.execute(apply, controller.signal)).toEqual({
    kind: "failed",
    code: "cancelled",
  });
  f.failBackup(true);
  expect(await f.service.execute(apply)).toEqual({ kind: "failed", code: "backup-failed" });
  expect(f.get()).toEqual(EMPTY_MODEL_PREFERENCES);
  f.failBackup(false);
  f.failWrite(true);
  expect(await f.service.execute(apply)).toEqual({ kind: "failed", code: "write-failed" });
  expect(f.events.slice(-2)).toEqual(["backup", "write"]);
  expect(f.get()).toEqual(EMPTY_MODEL_PREFERENCES);
  f.failWrite(false);
  const restarted = createModelSettingsService(f.store);
  expect((await restarted.execute(apply)).kind).toBe("written");
  expect(f.get().roles.fast?.use?.compaction).toBe("off");
  expect(await restarted.execute(apply)).toEqual({ kind: "failed", code: "stale-settings" });
  expect(f.backups.length).toBe(2);
});
test("changed migration candidates and clear previews cannot overwrite a later revision", async () => {
  const f = fixture();
  const original = { roles: { default: route("old") } };
  expect(
    await f.service.execute({
      kind: "apply-migration",
      original,
      candidate: EMPTY_MODEL_PREFERENCES,
      decisions: {},
      expectedRevision: null,
    }),
  ).toEqual({ kind: "failed", code: "stale-migration-preview" });
  const clear = await f.service.execute({ kind: "preview-clear" });
  if (clear.kind !== "clear-preview") throw new Error("Expected clear preview");
  await f.service.execute({
    kind: "edit",
    edit: { kind: "configure", target: { kind: "preset", preset: "small" }, route: route("small") },
    expectedRevision: null,
  });
  expect(
    await f.service.execute({
      kind: "apply-clear",
      paths: clear.paths,
      expectedRevision: clear.expectedRevision,
    }),
  ).toEqual({ kind: "failed", code: "stale-settings" });
});

test("inspection distinguishes the saved main default from a captured session selection", async () => {
  const f = fixture();
  await f.service.execute({
    kind: "edit",
    edit: {
      kind: "configure",
      target: { kind: "role", role: "default" },
      route: route("next-main"),
    },
    expectedRevision: null,
  });
  const result = await f.service.execute({
    kind: "inspect",
    target: { kind: "role", role: "default" },
  });
  const text = modelSettingsLines(result).join("\n");
  expect(text).toContain("default: account / main");
  expect(text).toContain("saved default: account / next-main");
});
