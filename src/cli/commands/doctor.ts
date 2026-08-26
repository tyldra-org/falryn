/** Read-only environment and storage diagnostics command. */

import { fromUnknown } from "../../application/index.ts";
import {
  probeStorage,
  rootChild,
  type StorageProbe,
  sqliteDatabasePath,
} from "../../data/index.ts";
import {
  blocksLocalData,
  LOCAL_DATA_ROOTS,
  type LocalDataRoot,
  type LocalPath,
  type OwnershipClass,
  type RootInspection,
  type RootViability,
} from "../../domain/index.ts";
import { openBunSqlite } from "../../integrations/index.ts";
import type { CommandResultOf } from "../result.ts";
import type { ServiceProvider } from "../services.ts";
import { resultFor } from "./shared.ts";

export type DoctorStorage =
  | StorageProbe
  | { readonly kind: "undetermined"; readonly reason: "state-root-not-viable" };

export type DoctorPayload = {
  /**
   * Every declared root, where it would be, and whether it can hold data.
   *
   * `resolved` and `viability` are separate because they answer different
   * questions. `resolved` is whether the layout produced a path at all;
   * `viability` is whether that path can hold data. The field this replaced was
   * called `usable` and measured only the first, which is how a state root that
   * was a regular file was reported as healthy.
   */
  readonly roots: readonly {
    readonly root: LocalDataRoot;
    readonly path: string | null;
    readonly resolved: boolean;
    readonly viability: RootViability;
    readonly code: string | null;
  }[];
  /** Overrides the layout could not use, with the reason each was rejected. */
  readonly rootIssues: readonly string[];
  /** Where the database would live. Named whether or not one exists. */
  readonly databasePath: string | null;
  /** Whether any finding means Falryn cannot hold data here. */
  readonly blocked: boolean;
  /**
   * What the database on disk reports about itself.
   *
   * Read with `create: false`, so asking whether a database exists never
   * creates one. `absent` is a normal answer on a machine that has not run
   * Falryn yet — but only when the state root could actually be reached.
   */
  readonly storage: DoctorStorage;
  /** Ownership classes with an owner, and those still unregistered. */
  readonly registeredClasses: readonly OwnershipClass[];
  readonly unregisteredClasses: readonly OwnershipClass[];
  readonly build: { readonly platform: string; readonly architecture: string };
};

/**
 * Bounded, read-only environment and storage diagnostics.
 *
 * It reports where each root *would* be and whether it is usable, and it does
 * not call `prepareRoots`: creating a directory as a side effect of describing
 * it is exactly the mutation `reference/CLI.md` forbids diagnostics from doing.
 * The database is named, not opened, for the same reason — opening it creates
 * it.
 */
export async function runDoctor(
  services: ServiceProvider,
): Promise<CommandResultOf<"doctor", DoctorPayload>> {
  try {
    const { localData } = services();
    const layout = localData.layout;

    // Read-only throughout: this probes what is there and creates nothing, so
    // a root that does not exist stays a root that does not exist.
    const inspections = await localData.inspectRoots();
    const byRoot = new Map<LocalDataRoot, RootInspection>(
      inspections.map((inspection) => [inspection.root, inspection]),
    );

    const roots = LOCAL_DATA_ROOTS.map((root) => {
      const inspection = byRoot.get(root);
      return {
        root,
        path: rootChild(layout, root),
        // An unresolved root produced no path to inspect, so its viability is
        // genuinely unknown rather than blocked — nothing was probed.
        resolved: inspection !== undefined,
        viability: inspection?.viability ?? ("unknown" as RootViability),
        code: inspection === undefined ? "unresolved" : inspection.code,
      };
    });

    const stateRoot = rootChild(layout, "state");
    const databasePath = stateRoot === null ? null : sqliteDatabasePath(stateRoot);
    const state = byRoot.get("state");
    const storage = await storageFor(databasePath, state);

    const blocked =
      inspections.some(blocksLocalData) ||
      roots.some((entry) => !entry.resolved) ||
      storage.kind === "unreadable" ||
      storage.kind === "undetermined";

    return resultFor(
      "doctor",
      {
        roots,
        rootIssues: localData.resolutionIssues.map((issue) => issue.code),
        databasePath,
        blocked,
        storage,
        registeredClasses: localData.registrations().map((entry) => entry.ownershipClass),
        unregisteredClasses: localData.unregistered(),
        build: { platform: process.platform, architecture: process.arch },
      },
      [],
      // A blocking finding is the diagnosis, not a failure of the command, so
      // it carries no error — but it must reach the exit status, because
      // `reference/CLI.md` makes the verdict of a diagnostic its exit code and
      // an unconditional `0` leaves that verdict carried by nothing. The effect
      // is `none`: diagnosing changed nothing.
      blocked ? { kind: "failed", effect: "none" } : undefined,
    );
  } catch (error) {
    return resultFor<"doctor", DoctorPayload>("doctor", null, [
      fromUnknown(error, { operation: "collect diagnostics" }),
    ]);
  }
}

/**
 * What the database reports, or why `doctor` did not ask.
 *
 * A state root that cannot hold data would make `probeStorage` report `absent`,
 * because the driver's `cannot-open` covers both "no file yet" and "no path at
 * all". Rather than teach the probe a distinction it has no way to draw, the
 * command declines to run it and says so.
 */
async function storageFor(
  databasePath: LocalPath | null,
  state: RootInspection | undefined,
): Promise<DoctorStorage> {
  if (databasePath === null) {
    return { kind: "unreadable", code: "unresolved-path" };
  }
  if (state !== undefined && blocksLocalData(state)) {
    return { kind: "undetermined", reason: "state-root-not-viable" };
  }
  return probeStorage({ open: openBunSqlite, databasePath });
}

/* -------------------------------------------------------------------------- */
/* export                                                                      */
/* -------------------------------------------------------------------------- */
