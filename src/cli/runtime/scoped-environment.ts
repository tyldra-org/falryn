import { randomUUID } from "node:crypto";
import { dirname, resolve } from "node:path";
import {
  createScopedEnvironment,
  type EnvironmentPlan,
  type EnvironmentStage,
} from "../../application/configuration/scoped-environment.ts";
import type { ConfigurationGenerationRecord } from "../../domain/configuration/index.ts";
import {
  type EnvironmentEdits,
  environmentEditsSchema,
  forbiddenEnvironmentName,
} from "../../domain/process/environment.ts";
import { createHostCommandRunner } from "../../integrations/process/host-commands.ts";
import { inspectEnvironmentSource } from "../../integrations/process/host-environment-preparation.ts";
import type { OwnedProcessRegistry } from "../../integrations/process/host-owned-process-registry.ts";
import { createProductSandbox } from "./sandbox-configuration.ts";
import type { Services } from "./services.ts";

/** Host paths, inherited bytes and source authority never enter inspect projections. */
export function productScopedEnvironment(
  graph: Services,
  sessionId: string,
  ownedProcesses?: OwnedProcessRegistry,
) {
  let requiredProject = false;
  const ports = {
    identity: randomUUID,
    async plan(
      record: ConfigurationGenerationRecord,
      signal: AbortSignal,
    ): Promise<EnvironmentPlan> {
      const home = await graph.configurationHomeForRead(signal);
      if (!("root" in home)) throw new Error("environment-home-unavailable");
      const layers = (record.environmentLayers ?? []).map((layer) => ({
        ...layer,
        edits: environmentEditsSchema.parse(layer.value),
      }));
      const user = layers.filter((layer) => layer.source.kind === "user-file");
      const profiles = layers.filter((layer) => layer.source.kind === "profile");
      const project = layers.filter((layer) =>
        ["project-file", "private-project-file"].includes(layer.source.kind),
      );
      const authority: EnvironmentEdits = {};
      for (const layer of [...user, ...profiles]) Object.assign(authority, layer.edits);
      for (const layer of project) {
        if (
          layer.edits.inheritedNames ||
          layer.edits.operationNames ||
          layer.edits.allowProject !== undefined
        )
          throw new Error("project-environment-authority-denied");
        if (layer.edits.preparation?.source && layer.edits.preparation.source !== "env.zsh")
          throw new Error("project-environment-source-denied");
      }
      const allowProject = authority.allowProject ?? true;
      if (requiredProject && allowProject && graph.workspaceTrust.current().status !== "accepted")
        throw new Error("environment-project-untrusted");
      const nextRequiredProject =
        allowProject && project.some((layer) => layer.edits.preparation?.required);
      const trust =
        project.length && allowProject ? await graph.workspaceTrust.project(signal) : null;
      const projectGeneration = trust?.report.inventory?.generation;
      if (trust && trust.report.status !== "accepted")
        throw new Error("environment-project-untrusted");
      const base: Record<string, string> = {};
      for (const name of authority.inheritedNames ?? []) {
        const value = graph.environment.raw
          ? graph.environment.raw(name)
          : graph.environment.get(name);
        if (value !== null && !forbiddenEnvironmentName(name)) base[name] = value;
      }
      const policyOf = (selected: typeof record | null) => {
        const policy: EnvironmentEdits = {};
        for (const layer of selected?.environmentLayers ?? []) {
          if (layer.source.kind !== "user-file" && layer.source.kind !== "profile") continue;
          Object.assign(policy, environmentEditsSchema.parse(layer.value));
        }
        return JSON.stringify({
          inheritedNames: policy.inheritedNames ?? [],
          operationNames: policy.operationNames ?? [],
          allowProject: policy.allowProject ?? true,
          preparation: policy.preparation ?? null,
        });
      };
      const beforePolicy = policyOf(graph.loader.current());
      const proposedPolicy = policyOf(record);
      let activated = false;
      const current = async (abort?: AbortSignal) => {
        if (abort?.aborted) return false;
        const livePolicy = policyOf(graph.loader.current());
        if (livePolicy !== proposedPolicy && (activated || livePolicy !== beforePolicy))
          return false;
        if (!trust) return true;
        const observed = await graph.workspaceTrust.project(abort);
        return (
          observed.report.status === "accepted" &&
          observed.report.inventory?.generation === projectGeneration
        );
      };
      const sandbox = createProductSandbox({
        now: () => Number(graph.clock.now()),
        values: () => graph.loader.current()?.values ?? record.values,
        generation: () => Number(graph.loader.current()?.generation ?? record.generation),
        workspaceRoot: graph.workspaceRoot,
      });
      const commands = createHostCommandRunner({
        sandbox,
        ...(ownedProcesses ? { ownedProcesses } : {}),
      });
      const cwd = String(graph.workspaceRoot ?? home.root);
      const stages: EnvironmentStage[] = [];
      const append = async (
        scope: EnvironmentStage["scope"],
        layer: (typeof layers)[number],
        preparation?: EnvironmentEdits["preparation"],
      ) => {
        const root = scope === "project" ? resolve(cwd, ".falryn") : String(home.root);
        const directory = layer.source.file ? dirname(String(layer.source.file)) : root;
        const separator = process.platform === "win32" ? ";" : ":";
        if (
          [...(layer.edits.pathPrepend ?? []), ...(layer.edits.pathAppend ?? [])].some((path) =>
            path.includes(separator),
          )
        )
          throw new Error("invalid-environment-path-entry");
        const edits = {
          ...layer.edits,
          ...(layer.edits.pathPrepend
            ? { pathPrepend: layer.edits.pathPrepend.map((path) => resolve(directory, path)) }
            : {}),
          ...(layer.edits.pathAppend
            ? { pathAppend: layer.edits.pathAppend.map((path) => resolve(directory, path)) }
            : {}),
        };
        if (!preparation) {
          stages.push({ scope, edits });
          return;
        }
        const inspected = await inspectEnvironmentSource({ root, cwd, preparation, commands });
        stages.push({
          scope,
          ...(scope === "project" ? { preparationNames: authority.inheritedNames ?? [] } : {}),
          edits,
          preparation: {
            required: preparation.required,
            ...(inspected.kind === "unavailable"
              ? { source: null, code: inspected.code }
              : {
                  source: {
                    identity: inspected.identity,
                    current: async () => (await current()) && (await inspected.current()),
                    async run(values, abort) {
                      if (!(await current(abort)))
                        return {
                          kind: "failed",
                          code: "environment-authority-changed",
                          effects: "none",
                        };
                      const result = await sandbox.run(
                        {
                          invocationId: randomUUID(),
                          capabilityId: "environment.prepare",
                          source: "builtin",
                          catalogGeneration: Number(record.generation),
                          policyGeneration: Number(
                            graph.loader.current()?.generation ?? record.generation,
                          ),
                          inputFingerprint: inspected.identity,
                          effect: "local-process",
                          confirmationId: null,
                          resourceTaskId: sessionId,
                          expiresAt: Date.now() + 30_000,
                        },
                        () => inspected.run(values, abort),
                      );
                      return result.value;
                    },
                  },
                }),
          },
        });
      };
      const preparationLayer = [...user, ...profiles].findLast((layer) => layer.edits.preparation);
      const selectedPreparation = preparationLayer?.edits.preparation;
      const userPreparation =
        selectedPreparation?.source && preparationLayer?.source.file
          ? {
              ...selectedPreparation,
              source: resolve(
                dirname(String(preparationLayer.source.file)),
                selectedPreparation.source,
              ),
            }
          : selectedPreparation;
      if (user.length) {
        for (const [index, layer] of user.entries())
          await append("user", layer, index === 0 ? userPreparation : undefined);
      } else if (userPreparation) {
        await append(
          "user",
          { source: { kind: "user-file", file: null, profile: null }, value: {}, edits: {} },
          userPreparation,
        );
      }
      if (allowProject) {
        const preparation = project.findLast((layer) => layer.edits.preparation)?.edits.preparation;
        for (const [index, layer] of project.entries())
          await append("project", layer, index === 0 ? preparation : undefined);
      }
      for (const layer of profiles) await append("profile", layer);
      return {
        base,
        stages,
        current,
        admit: () => {
          requiredProject = nextRequiredProject;
        },
        fresh: async () => {
          for (const { source, outcome } of record.sources) {
            if (
              !source.file ||
              source.kind === "project-file" ||
              source.kind === "private-project-file"
            )
              continue;
            const observed = await graph.fileSystem.stat(source.file);
            if (
              !observed.ok ||
              (outcome === "absent"
                ? observed.value !== null
                : source.revision != null && observed.value?.revision !== source.revision)
            )
              return false;
          }
          for (const name of authority.inheritedNames ?? []) {
            if (forbiddenEnvironmentName(name)) continue;
            const value = graph.environment.raw
              ? graph.environment.raw(name)
              : graph.environment.get(name);
            if (value !== (base[name] ?? null)) return false;
          }
          return (
            (await current()) &&
            (
              await Promise.all(stages.map((stage) => stage.preparation?.source?.current() ?? true))
            ).every(Boolean)
          );
        },
        activate: () => {
          activated = true;
        },
        operationNames: authority.operationNames ?? [],
        separator: process.platform === "win32" ? ";" : ":",
      };
    },
  };
  const environment = createScopedEnvironment(ports);
  return {
    ...environment,
    plan: ports.plan,
    async inspect() {
      const fact = await environment.inspect();
      if (fact.generation || fact.prepared || fact.sources.length) return fact;
      const record = graph.loader.current();
      if (!record) return fact;
      try {
        const plan = await ports.plan(record, new AbortController().signal);
        return {
          ...fact,
          sources: plan.stages.flatMap((stage) =>
            stage.preparation
              ? [
                  {
                    scope: stage.scope,
                    identity: stage.preparation.source?.identity ?? null,
                    required: stage.preparation.required,
                    code: stage.preparation.code ?? "source-selected-not-prepared",
                  },
                ]
              : [],
          ),
        };
      } catch {
        return { ...fact, code: "environment-plan-unavailable" };
      }
    },
  };
}
