import { join } from "node:path";
import { createPackageLifecycleRepository } from "../../data/extensions/package-lifecycle-repository.ts";
import { rootChild } from "../../data/index.ts";
import { ExtensionInputError } from "../../domain/extensions/canonical.ts";
import type { InstalledVersion } from "../../domain/extensions/lifecycle.ts";
import type { PackageSnapshot } from "../../domain/extensions/package-source.ts";
import { createHostPackageCache } from "../../integrations/extensions/host-package-cache.ts";
import type { ServiceProvider } from "../runtime/services.ts";
import { openSessionStore } from "./storage.ts";

/** A local package directory, or an installed package read back from its exact cached bytes. */
export type ExtensionTarget = string | { readonly installed: string };

export type InstalledPackageSnapshot =
  | {
      readonly ok: true;
      readonly snapshot: PackageSnapshot;
      readonly dependencies: InstalledVersion["dependencies"];
    }
  | { readonly ok: false; readonly code: string };

/**
 * One installed version read back from its exact cached bytes under the state root. Shared by every
 * reader of an installed package so they address the identity that was installed.
 */
export async function readInstalledVersion(
  stateRoot: string,
  version: InstalledVersion,
  signal: AbortSignal,
): Promise<InstalledPackageSnapshot> {
  try {
    const snapshot = await createHostPackageCache(join(stateRoot, "packages")).read(
      version,
      signal,
    );
    return { ok: true, snapshot, dependencies: version.dependencies };
  } catch (error) {
    if (signal.aborted) return { ok: false, code: "cancelled" };
    return {
      ok: false,
      code: error instanceof ExtensionInputError ? error.code : "package-cache-unreadable",
    };
  }
}

/**
 * The current installed version of a package, read back from its exact cached bytes with the
 * source the lifecycle recorded. Inspection, trust and notices that target an installed package
 * therefore address the identity that was installed, including one acquired from a listing, which
 * has no local path. Reads only: it never creates the database and never contacts a source.
 */
export async function readInstalledPackage(
  services: ServiceProvider,
  packageId: string,
  signal: AbortSignal = new AbortController().signal,
): Promise<InstalledPackageSnapshot> {
  const opened = await openSessionStore(services, signal);
  if (!opened.ok) return { ok: false, code: "package-store-unavailable" };
  if (opened.kind === "absent") return { ok: false, code: "not-installed" };
  try {
    const current = createPackageLifecycleRepository(opened.store).current(packageId);
    if (!current.ok) return { ok: false, code: "package-store-unavailable" };
    const version = current.value.current;
    if (version === null) return { ok: false, code: "not-installed" };
    const stateRoot = rootChild(services().localData.layout, "state");
    if (stateRoot === null) return { ok: false, code: "package-root-unavailable" };
    return await readInstalledVersion(stateRoot, version, signal);
  } catch (error) {
    if (signal.aborted) return { ok: false, code: "cancelled" };
    return {
      ok: false,
      code: error instanceof ExtensionInputError ? error.code : "package-cache-unreadable",
    };
  } finally {
    await opened.store.close();
  }
}
