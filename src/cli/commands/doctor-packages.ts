/**
 * The `doctor` package section (#1280): every installed package's standing, notice counts and
 * latest evaluation, read from the owners `package standing`, `extension notices --installed` and
 * `package evaluate` use, so diagnostics and those commands agree for the same cause.
 *
 * It reads an existing database at this build's schema only: it never creates the file, applies a
 * migration, acknowledges a notice or changes a hold. Package state is advisory, like skill
 * findings: it describes those packages, not whether Falryn can hold data here.
 */
import { createPackageLifecycleRepository } from "../../data/extensions/package-lifecycle-repository.ts";
import {
  openSqliteStore,
  PRODUCT_SCHEMA_VERSION,
  PRODUCTION_MIGRATIONS,
  rootChild,
  type StorageProbe,
} from "../../data/index.ts";
import { createEvaluationRepository } from "../../data/security/evaluation-repository.ts";
import type { EvaluationDecision } from "../../domain/security/package-evaluation.ts";
import type { StandingReason, StandingState } from "../../domain/security/package-standing.ts";
import { DEFAULT_BUSY_TIMEOUT_MS } from "../../domain/storage/index.ts";
import type { LocalPath } from "../../domain/workspace/index.ts";
import { openBunSqlite } from "../../integrations/index.ts";
import { composePackageStanding } from "../runtime/package-standing.ts";
import type { ServiceProvider } from "../runtime/services.ts";
import { installedVersionNotices } from "./extension-notices.ts";
import { readInstalledVersion } from "./installed-package.ts";

/** At most this many installed packages per run; the rest are counted as `omitted`. */
export const DOCTOR_PACKAGE_LIMIT = 256;

type Unavailable = { readonly status: "unavailable"; readonly code: string };

export type DoctorPackage = {
  readonly packageId: string;
  /** `null` when the installed record itself could not be read. */
  readonly revision: number | null;
  readonly standing:
    | {
        readonly status: "read";
        readonly state: StandingState;
        readonly reason: StandingReason | null;
      }
    | Unavailable;
  readonly notices:
    | {
        readonly status: "counted";
        readonly blocking: number;
        readonly warning: number;
        readonly suppressed: number;
      }
    | Unavailable;
  readonly evaluation:
    | {
        readonly status: "recorded";
        readonly decision: EvaluationDecision;
        readonly evaluator: string;
        readonly recordedAt: number;
        /** Recorded for a different identity than the current version. */
        readonly stale: boolean;
      }
    | null
    | Unavailable;
};

export type DoctorPackages =
  /** No database exists, so nothing is installed. A normal answer. */
  | { readonly status: "absent" }
  | Unavailable
  | {
      readonly status: "inspected";
      readonly packages: readonly DoctorPackage[];
      readonly omitted: number;
    };

const cancelled: Unavailable = { status: "unavailable", code: "cancelled" };
const stateUnavailable: Unavailable = { status: "unavailable", code: "package-state-unavailable" };

/** Installed package state, read without creating or migrating the database. */
export async function inspectDoctorPackages(
  services: ServiceProvider,
  /** What doctor's storage probe found; `undetermined` when the state root cannot hold data. */
  storage: StorageProbe | { readonly kind: "undetermined" },
  databasePath: LocalPath | null,
  signal: AbortSignal,
): Promise<DoctorPackages> {
  if (signal.aborted) return cancelled;
  if (storage.kind === "absent") return { status: "absent" };
  // Another schema version is reported by the storage section; reading it would mean migrating it.
  if (storage.kind !== "present" || !storage.current || databasePath === null)
    return stateUnavailable;
  const resolved = services();
  const stateRoot = rootChild(resolved.localData.layout, "state");
  if (stateRoot === null) return stateUnavailable;
  const opened = await openSqliteStore(
    {
      open: openBunSqlite,
      clock: resolved.clock,
      databasePath,
      backupDirectory: stateRoot,
      migrations: PRODUCTION_MIGRATIONS,
      busyTimeoutMs: DEFAULT_BUSY_TIMEOUT_MS,
      create: false,
      applyMigrations: false,
    },
    signal,
  );
  if (!opened.ok) return signal.aborted ? cancelled : stateUnavailable;
  const store = opened.value;
  try {
    // A migration that landed between the probe and this open is still not ours to read.
    if (store.report.schemaVersion !== PRODUCT_SCHEMA_VERSION) return stateUnavailable;
    return await inspect(services, stateRoot, store, signal);
  } catch {
    return signal.aborted
      ? cancelled
      : { status: "unavailable", code: "package-store-unavailable" };
  } finally {
    await store.close();
  }
}

async function inspect(
  services: ServiceProvider,
  stateRoot: string,
  store: Parameters<typeof createPackageLifecycleRepository>[0],
  signal: AbortSignal,
): Promise<DoctorPackages> {
  const resolved = services();
  const lifecycle = createPackageLifecycleRepository(store);
  const listed = lifecycle.installed(DOCTOR_PACKAGE_LIMIT);
  if (!listed.ok) return { status: "unavailable", code: listed.error.code };
  const standing = composePackageStanding(resolved, stateRoot, store);
  const evaluations = createEvaluationRepository(store);
  const packages: DoctorPackage[] = [];
  for (const packageId of listed.value.packageIds) {
    if (signal.aborted) return cancelled;
    const installed = lifecycle.current(packageId);
    if (!installed.ok) {
      // One damaged record describes that package; it must not hide the others.
      const unreadable: Unavailable = { status: "unavailable", code: installed.error.code };
      packages.push({
        packageId,
        revision: null,
        standing: unreadable,
        notices: unreadable,
        evaluation: unreadable,
      });
      continue;
    }
    const current = installed.value.current;
    // Removed after it was listed: it is no longer installed, so it is not reported.
    if (current === null) continue;
    const read = standing.standing(packageId);
    const notices = await installedVersionNotices(
      store,
      await readInstalledVersion(stateRoot, current, signal),
      Number(resolved.clock.now()),
      signal,
    ).catch(() => ({ status: "failed" as const, code: "notices-unavailable" }));
    const history = evaluations.history(packageId, 1);
    const latest = history.ok ? (history.value[0] ?? null) : null;
    packages.push({
      packageId,
      revision: installed.value.revision,
      standing: read.ok
        ? { status: "read", state: read.value.state, reason: read.value.reason }
        : { status: "unavailable", code: read.error.code },
      notices:
        notices.status === "failed"
          ? { status: "unavailable", code: notices.code }
          : {
              status: "counted",
              blocking: notices.notices.filter((entry) => entry.notice.severity === "blocking")
                .length,
              warning: notices.notices.filter((entry) => entry.notice.severity === "warning")
                .length,
              suppressed: notices.suppressed,
            },
      evaluation: !history.ok
        ? { status: "unavailable", code: history.error.code }
        : latest === null
          ? null
          : {
              status: "recorded",
              decision: latest.report.decision,
              evaluator: latest.report.evaluator.kind,
              recordedAt: latest.recordedAt,
              stale: latest.identityDigest !== current.identityDigest,
            },
    });
  }
  if (signal.aborted) return cancelled;
  return { status: "inspected", packages, omitted: listed.value.omitted };
}
