import { describe, expect, test } from "bun:test";

import { DIAGNOSTICS_OWNERSHIP } from "../application/index.ts";
import { CONFIGURATION_OWNERSHIP } from "../config/index.ts";
import {
  createInMemoryFileSystem,
  createStaticEnvironment,
  type InMemoryNode,
  localPath,
  OUT_OF_SCOPE_CATEGORIES,
  type OwnershipRegistration,
  type RemovalPlan,
  type RootLayout,
} from "../domain/index.ts";
import {
  CREDENTIAL_REFERENCE_OWNERSHIP,
  createOwnershipRegistry,
  TEMPORARY_INGEST_OWNERSHIP,
} from "./ownership.ts";
import {
  computePlanId,
  executeRemoval,
  type PlanInputs,
  planReset,
  planUninstall,
} from "./removal.ts";
import { resolveRoots } from "./roots.ts";

/** Roots placed at short paths so a fixture tree is readable. */
const OVERRIDES = {
  FALRYN_CONFIG_DIR: "/d/config",
  FALRYN_STATE_DIR: "/d/state",
  FALRYN_CACHE_DIR: "/d/cache",
  FALRYN_LOG_DIR: "/d/logs",
  FALRYN_TEMP_DIR: "/d/tmp",
  FALRYN_ARTIFACT_DIR: "/d/artifacts",
  FALRYN_EXPORT_DIR: "/d/exports",
};

const EXPORTS_OWNERSHIP: OwnershipRegistration = {
  ownershipClass: "exports",
  owner: "export",
  durability: "user-created",
  removalPosture: "never-implicit",
  roots: ["exports"],
  external: false,
};

function layoutFor(): RootLayout {
  return resolveRoots({
    platform: "darwin",
    home: localPath("/Users/example"),
    environment: createStaticEnvironment(OVERRIDES),
  }).layout;
}

/**
 * A tree containing Falryn's roots plus the things uninstall must never touch:
 * a project, a shell startup file, a package-manager directory, and a user
 * export.
 */
const TREE: Readonly<Record<string, InMemoryNode>> = {
  "/d": { kind: "directory" },
  "/d/config": { kind: "directory" },
  "/d/config/settings.jsonc": { kind: "file", byteLength: 120 },
  "/d/logs": { kind: "directory" },
  "/d/logs/today": { kind: "directory" },
  "/d/logs/today/run.log": { kind: "file", byteLength: 400 },
  "/d/logs/old.log": { kind: "file", byteLength: 100 },
  "/d/tmp": { kind: "directory" },
  "/d/tmp/ingest-1.part": { kind: "file", byteLength: 50 },
  "/d/exports": { kind: "directory" },
  "/d/exports/session.zip": { kind: "file", byteLength: 900 },

  "/Users/example": { kind: "directory" },
  "/Users/example/project": { kind: "directory" },
  "/Users/example/project/src.ts": { kind: "file", byteLength: 30 },
  "/Users/example/.zshrc": { kind: "file", byteLength: 20 },
  "/Users/example/.bun": { kind: "directory" },
  "/Users/example/.bun/install": { kind: "file", byteLength: 40 },
  "/Users/example/Documents": { kind: "directory" },
  "/Users/example/Documents/falryn-export.zip": { kind: "file", byteLength: 700 },
};

function inputsFor(
  fileSystem: ReturnType<typeof createInMemoryFileSystem>,
  registrations: readonly OwnershipRegistration[],
): PlanInputs {
  const registry = createOwnershipRegistry();
  for (const registration of registrations) {
    registry.register(registration);
  }
  return {
    fileSystem,
    layout: layoutFor(),
    registrations: registry.registrations(),
    unregistered: registry.unregistered(),
  };
}

const ALL_V0_1 = [
  CONFIGURATION_OWNERSHIP,
  CREDENTIAL_REFERENCE_OWNERSHIP,
  DIAGNOSTICS_OWNERSHIP,
  TEMPORARY_INGEST_OWNERSHIP,
  EXPORTS_OWNERSHIP,
];

function entryFor(plan: RemovalPlan, ownershipClass: string) {
  return plan.classes.find((entry) => entry.ownershipClass === ownershipClass);
}

describe("planning a reset", () => {
  test("names each class, its exact paths, and its counts", async () => {
    const fileSystem = createInMemoryFileSystem({ nodes: TREE });
    const plan = await planReset(inputsFor(fileSystem, ALL_V0_1), { classes: ["logs"] });

    const logs = entryFor(plan, "logs");
    expect(logs).toMatchObject({
      action: "delete",
      reason: "selected",
      owner: "diagnostics",
      paths: [localPath("/d/logs")],
      itemCount: 3,
      byteCount: 500,
    });
    expect(plan.totalBytes).toBe(500);
    expect(plan.totalItems).toBe(3);
  });

  test("preserves everything that was not selected", async () => {
    const fileSystem = createInMemoryFileSystem({ nodes: TREE });
    const plan = await planReset(inputsFor(fileSystem, ALL_V0_1), { classes: ["logs"] });

    expect(entryFor(plan, "configuration")).toMatchObject({
      action: "preserve",
      reason: "not-selected",
    });
  });

  test("names credentials as out of scope rather than omitting them", async () => {
    const fileSystem = createInMemoryFileSystem({ nodes: TREE });
    const plan = await planReset(inputsFor(fileSystem, ALL_V0_1), { classes: ["logs"] });

    expect(entryFor(plan, "credentials")).toMatchObject({
      action: "out-of-scope",
      reason: "external-store",
      paths: [],
    });
  });

  test("names a class no owner registered, so the gap is visible", async () => {
    const fileSystem = createInMemoryFileSystem({ nodes: TREE });
    const plan = await planReset(inputsFor(fileSystem, [DIAGNOSTICS_OWNERSHIP]), {
      classes: ["logs"],
    });

    expect(entryFor(plan, "artifacts")).toMatchObject({
      action: "out-of-scope",
      reason: "no-owner-registered",
      owner: null,
    });
  });

  test("selecting a class no owner registered removes nothing", async () => {
    const fileSystem = createInMemoryFileSystem({ nodes: TREE });
    const inputs = inputsFor(fileSystem, [DIAGNOSTICS_OWNERSHIP]);
    const plan = await planReset(inputs, { classes: ["artifacts"] });

    expect(entryFor(plan, "artifacts")?.action).toBe("out-of-scope");
    expect(plan.classes.some((entry) => entry.action === "delete")).toBe(false);
  });
});

describe("planning an uninstall", () => {
  test("selects every registered class that owns bytes here", async () => {
    const fileSystem = createInMemoryFileSystem({ nodes: TREE });
    const plan = await planUninstall(inputsFor(fileSystem, ALL_V0_1));

    expect(entryFor(plan, "configuration")?.action).toBe("delete");
    expect(entryFor(plan, "logs")?.action).toBe("delete");
    expect(entryFor(plan, "temporaryIngest")?.action).toBe("delete");
  });

  test("never removes a user's own exports", async () => {
    const fileSystem = createInMemoryFileSystem({ nodes: TREE });
    const plan = await planUninstall(inputsFor(fileSystem, ALL_V0_1));

    expect(entryFor(plan, "exports")).toMatchObject({
      action: "out-of-scope",
      reason: "user-created",
    });
  });

  test("states its blast radius rather than leaving it to be inferred", async () => {
    const fileSystem = createInMemoryFileSystem({ nodes: TREE });
    const plan = await planUninstall(inputsFor(fileSystem, ALL_V0_1));

    expect(plan.outOfScope).toEqual([...OUT_OF_SCOPE_CATEGORIES]);
    const planned = plan.classes.flatMap((entry) => entry.paths.map(String));
    for (const untouchable of [
      "/Users/example/project",
      "/Users/example/.zshrc",
      "/Users/example/.bun",
      "/Users/example/Documents/falryn-export.zip",
    ]) {
      expect(planned.some((path) => untouchable.startsWith(path))).toBe(false);
    }
  });
});

describe("confirming a plan", () => {
  test("executes only the plan that was confirmed", async () => {
    const fileSystem = createInMemoryFileSystem({ nodes: TREE });
    const inputs = inputsFor(fileSystem, ALL_V0_1);
    const plan = await planReset(inputs, { classes: ["logs"] });

    const outcome = await executeRemoval(fileSystem, inputs.layout, plan, {
      planId: plan.planId,
    });

    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.value.effect).toBe("completed");
    }
  });

  test("refuses a confirmation for a different plan", async () => {
    const fileSystem = createInMemoryFileSystem({ nodes: TREE });
    const inputs = inputsFor(fileSystem, ALL_V0_1);
    const reset = await planReset(inputs, { classes: ["logs"] });
    const uninstall = await planUninstall(inputs);

    const outcome = await executeRemoval(fileSystem, inputs.layout, reset, {
      planId: uninstall.planId,
    });

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.error.code).toBe("plan-mismatch");
    }
    expect(fileSystem.paths()).toContain(localPath("/d/logs/old.log"));
  });

  test("refuses a plan whose identity was edited to match a confirmation", async () => {
    const fileSystem = createInMemoryFileSystem({ nodes: TREE });
    const inputs = inputsFor(fileSystem, ALL_V0_1);
    const plan = await planReset(inputs, { classes: ["logs"] });

    // Swapping in a different class list while keeping the confirmed id is the
    // attack the re-derivation exists to stop.
    const tampered: RemovalPlan = {
      ...plan,
      classes: plan.classes.map((entry) =>
        entry.ownershipClass === "configuration" ? { ...entry, action: "delete" as const } : entry,
      ),
    };

    const outcome = await executeRemoval(fileSystem, inputs.layout, tampered, {
      planId: plan.planId,
    });

    expect(outcome.ok).toBe(false);
    expect(fileSystem.paths()).toContain(localPath("/d/config/settings.jsonc"));
  });

  test("a plan identity is stable for the same plan and differs for another", async () => {
    const fileSystem = createInMemoryFileSystem({ nodes: TREE });
    const inputs = inputsFor(fileSystem, ALL_V0_1);
    const first = await planReset(inputs, { classes: ["logs"] });
    const again = await planReset(inputs, { classes: ["logs"] });
    const other = await planReset(inputs, { classes: ["configuration"] });

    expect(first.planId).toBe(again.planId);
    expect(first.planId).not.toBe(other.planId);
    expect(computePlanId(first.kind, first.classes)).toBe(first.planId);
  });

  test("cancellation refuses before anything is removed", async () => {
    const fileSystem = createInMemoryFileSystem({ nodes: TREE });
    const inputs = inputsFor(fileSystem, ALL_V0_1);
    const plan = await planReset(inputs, { classes: ["logs"] });
    const controller = new AbortController();
    controller.abort();

    const outcome = await executeRemoval(
      fileSystem,
      inputs.layout,
      plan,
      { planId: plan.planId },
      controller.signal,
    );

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.error.code).toBe("cancelled");
    }
    expect(fileSystem.paths()).toContain(localPath("/d/logs/old.log"));
  });
});

describe("executing a removal", () => {
  test("deletes the selected class and nothing else", async () => {
    const fileSystem = createInMemoryFileSystem({ nodes: TREE });
    const inputs = inputsFor(fileSystem, ALL_V0_1);
    const plan = await planReset(inputs, { classes: ["logs"] });

    const outcome = await executeRemoval(fileSystem, inputs.layout, plan, {
      planId: plan.planId,
    });

    expect(outcome.ok).toBe(true);
    const survivors = fileSystem.paths();
    expect(survivors).not.toContain(localPath("/d/logs"));
    expect(survivors).not.toContain(localPath("/d/logs/today/run.log"));
    expect(survivors).toContain(localPath("/d/config/settings.jsonc"));
    expect(survivors).toContain(localPath("/d/exports/session.zip"));
  });

  test("preserves every project, shell file, package-manager path, and export", async () => {
    const fileSystem = createInMemoryFileSystem({ nodes: TREE });
    const inputs = inputsFor(fileSystem, ALL_V0_1);
    const plan = await planUninstall(inputs);

    await executeRemoval(fileSystem, inputs.layout, plan, { planId: plan.planId });

    const survivors = fileSystem.paths();
    expect(survivors).toContain(localPath("/Users/example/project/src.ts"));
    expect(survivors).toContain(localPath("/Users/example/.zshrc"));
    expect(survivors).toContain(localPath("/Users/example/.bun/install"));
    expect(survivors).toContain(localPath("/Users/example/Documents/falryn-export.zip"));
    expect(survivors).toContain(localPath("/d/exports/session.zip"));
  });

  test("reports what it preserved and why", async () => {
    const fileSystem = createInMemoryFileSystem({ nodes: TREE });
    const inputs = inputsFor(fileSystem, ALL_V0_1);
    const plan = await planReset(inputs, { classes: ["logs"] });

    const outcome = await executeRemoval(fileSystem, inputs.layout, plan, {
      planId: plan.planId,
    });

    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.value.retained).toContainEqual({
        path: localPath("/d/config"),
        reason: "preserved-by-plan",
      });
      expect(outcome.value.retained).toContainEqual({
        path: localPath("/d/exports"),
        reason: "out-of-scope",
      });
    }
  });

  test("re-running a completed removal converges instead of failing", async () => {
    const fileSystem = createInMemoryFileSystem({ nodes: TREE });
    const inputs = inputsFor(fileSystem, ALL_V0_1);
    const plan = await planReset(inputs, { classes: ["logs"] });

    const first = await executeRemoval(fileSystem, inputs.layout, plan, { planId: plan.planId });
    const second = await executeRemoval(fileSystem, inputs.layout, plan, { planId: plan.planId });

    expect(first.ok && first.value.deleted.length).toBeGreaterThan(0);
    expect(second.ok).toBe(true);
    if (second.ok) {
      expect(second.value.deleted).toEqual([]);
      expect(second.value.failed).toEqual([]);
      // Nothing was deleted this time, so nothing happened. That is `none`, not
      // a second success.
      expect(second.value.effect).toBe("none");
    }
  });

  test("a partial failure is reported as partial, not as success", async () => {
    const fileSystem = createInMemoryFileSystem({
      nodes: {
        ...TREE,
        // The subdirectory refuses removal of its child, so one file survives.
        "/d/logs/today": { kind: "directory", writable: false },
      },
    });
    const inputs = inputsFor(fileSystem, ALL_V0_1);
    const plan = await planReset(inputs, { classes: ["logs"] });

    const outcome = await executeRemoval(fileSystem, inputs.layout, plan, {
      planId: plan.planId,
    });

    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.value.deleted.length).toBeGreaterThan(0);
      expect(outcome.value.failed.length).toBeGreaterThan(0);
      expect(outcome.value.effect).toBe("partial");
      expect(outcome.value.failed[0]?.code).toBe("permission-denied");
    }
    expect(fileSystem.paths()).toContain(localPath("/d/logs/today/run.log"));
  });
});

describe("a removal that stops before it finishes", () => {
  /** Aborts once `trigger` has been removed, so the abort lands between calls. */
  function abortingAfter(
    fileSystem: ReturnType<typeof createInMemoryFileSystem>,
    controller: AbortController,
    trigger: string,
  ): ReturnType<typeof createInMemoryFileSystem> {
    const remove = fileSystem.removeEntry.bind(fileSystem);
    return Object.assign(fileSystem, {
      removeEntry: async (path: Parameters<typeof remove>[0], signal?: AbortSignal) => {
        const result = await remove(path, signal);
        if (path === localPath(trigger)) {
          controller.abort();
        }
        return result;
      },
    });
  }

  test("reports partial, never completed, when a class is left untouched", async () => {
    const fileSystem = createInMemoryFileSystem({ nodes: TREE });
    const inputs = inputsFor(fileSystem, ALL_V0_1);
    const plan = await planReset(inputs, { classes: ["configuration", "logs"] });
    const controller = new AbortController();
    abortingAfter(fileSystem, controller, "/d/config");

    const outcome = await executeRemoval(
      fileSystem,
      inputs.layout,
      plan,
      { planId: plan.planId },
      controller.signal,
    );

    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      // The log class was selected and is still on disk. Saying `completed`
      // here would tell a user their logs are gone when they are not.
      expect(outcome.value.effect).toBe("partial");
      expect(outcome.value.completeness).toBe("partial");
    }
    expect(fileSystem.paths()).toContain(localPath("/d/logs/old.log"));
  });

  test("marks what it never reached as not-reached, not as out of scope", async () => {
    const fileSystem = createInMemoryFileSystem({ nodes: TREE });
    const inputs = inputsFor(fileSystem, ALL_V0_1);
    const plan = await planReset(inputs, { classes: ["configuration", "logs"] });
    const controller = new AbortController();
    abortingAfter(fileSystem, controller, "/d/config");

    const outcome = await executeRemoval(
      fileSystem,
      inputs.layout,
      plan,
      { planId: plan.planId },
      controller.signal,
    );

    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      // `out-of-scope` means the plan decided this stays. Nothing decided this.
      expect(outcome.value.retained).toContainEqual({
        path: localPath("/d/logs"),
        reason: "not-reached",
      });
      expect(
        outcome.value.retained.filter(
          (entry) => entry.path === localPath("/d/logs") && entry.reason === "out-of-scope",
        ),
      ).toEqual([]);
    }
  });

  test("still reports what it did delete before it stopped", async () => {
    const fileSystem = createInMemoryFileSystem({ nodes: TREE });
    const inputs = inputsFor(fileSystem, ALL_V0_1);
    const plan = await planReset(inputs, { classes: ["configuration", "logs"] });
    const controller = new AbortController();
    abortingAfter(fileSystem, controller, "/d/config");

    const outcome = await executeRemoval(
      fileSystem,
      inputs.layout,
      plan,
      { planId: plan.planId },
      controller.signal,
    );

    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      // A refusal would claim the operation did not happen, and by now some
      // bytes are already gone.
      expect(outcome.value.deleted).toContain(localPath("/d/config/settings.jsonc"));
    }
    expect(fileSystem.paths()).not.toContain(localPath("/d/config"));
  });

  test("an abort landing inside a call is partial too", async () => {
    const fileSystem = createInMemoryFileSystem({ nodes: TREE });
    const inputs = inputsFor(fileSystem, ALL_V0_1);
    const plan = await planReset(inputs, { classes: ["logs"] });
    const controller = new AbortController();
    abortingAfter(fileSystem, controller, "/d/logs/old.log");

    const outcome = await executeRemoval(
      fileSystem,
      inputs.layout,
      plan,
      { planId: plan.planId },
      controller.signal,
    );

    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.value.effect).toBe("partial");
      expect(outcome.value.completeness).toBe("partial");
    }
  });

  test("a completed removal reports complete", async () => {
    const fileSystem = createInMemoryFileSystem({ nodes: TREE });
    const inputs = inputsFor(fileSystem, ALL_V0_1);
    const plan = await planReset(inputs, { classes: ["logs"] });

    const outcome = await executeRemoval(fileSystem, inputs.layout, plan, {
      planId: plan.planId,
    });

    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.value.completeness).toBe("complete");
      expect(outcome.value.effect).toBe("completed");
      expect(outcome.value.retained.some((entry) => entry.reason === "not-reached")).toBe(false);
    }
  });
});

describe("symlink safety", () => {
  test("a symlink out of a root is removed as a link, and its target is not", async () => {
    const fileSystem = createInMemoryFileSystem({
      nodes: {
        ...TREE,
        "/d/logs/escape": { kind: "symlink", target: "/Users/example/project" },
      },
    });
    const inputs = inputsFor(fileSystem, ALL_V0_1);
    const plan = await planReset(inputs, { classes: ["logs"] });

    const outcome = await executeRemoval(fileSystem, inputs.layout, plan, {
      planId: plan.planId,
    });

    expect(outcome.ok).toBe(true);
    const survivors = fileSystem.paths();
    expect(survivors).not.toContain(localPath("/d/logs/escape"));
    // The link is gone; what it pointed at is untouched.
    expect(survivors).toContain(localPath("/Users/example/project"));
    expect(survivors).toContain(localPath("/Users/example/project/src.ts"));
  });

  test("a directory that resolves outside its root is retained, not descended", async () => {
    const fileSystem = createInMemoryFileSystem({
      nodes: {
        ...TREE,
        "/d/logs/linked": { kind: "directory" },
      },
    });
    // The directory resolves elsewhere, which is what a bind mount or a
    // replaced path looks like from here.
    fileSystem.put("/d/logs/linked", { kind: "directory" });
    const inputs = inputsFor(fileSystem, ALL_V0_1);
    const plan = await planReset(inputs, { classes: ["logs"] });

    const withEscape = {
      ...fileSystem,
      realPath: async (path: ReturnType<typeof localPath>) =>
        path === localPath("/d/logs/linked")
          ? { ok: true as const, value: localPath("/Users/example/project") }
          : { ok: true as const, value: path },
    };

    const outcome = await executeRemoval(withEscape, inputs.layout, plan, {
      planId: plan.planId,
    });

    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.value.retained).toContainEqual({
        path: localPath("/d/logs/linked"),
        reason: "escapes-registered-root",
      });
    }
    expect(fileSystem.paths()).toContain(localPath("/Users/example/project/src.ts"));
  });

  test("a planned path outside every registered root is refused at delete time", async () => {
    const fileSystem = createInMemoryFileSystem({ nodes: TREE });
    const inputs = inputsFor(fileSystem, ALL_V0_1);
    const plan = await planReset(inputs, { classes: ["logs"] });

    // A plan naming a path outside the layout, with a matching identity: the
    // layout is still the authority, so the path is refused anyway.
    const classes = plan.classes.map((entry) =>
      entry.ownershipClass === "logs"
        ? { ...entry, paths: [localPath("/Users/example/project")] }
        : entry,
    );
    const forged: RemovalPlan = {
      ...plan,
      classes,
      planId: computePlanId(plan.kind, classes),
    };

    const outcome = await executeRemoval(fileSystem, inputs.layout, forged, {
      planId: forged.planId,
    });

    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.value.deleted).toEqual([]);
      expect(outcome.value.retained).toContainEqual({
        path: localPath("/Users/example/project"),
        reason: "escapes-registered-root",
      });
    }
    expect(fileSystem.paths()).toContain(localPath("/Users/example/project/src.ts"));
  });
});
