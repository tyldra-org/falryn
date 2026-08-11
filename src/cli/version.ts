/**
 * What `--version` reports.
 *
 * It names the build rather than printing a bare number, because the first
 * question a bug report has to answer is which Falryn ran: a source run from a
 * checkout and a standalone executable are different artifacts and fail
 * differently.
 *
 * It reads no configuration, opens no database, and starts no integration.
 * `reference/CLI.md` requires that, and a negative control proves it by running
 * this against a service factory that throws if constructed.
 */

/**
 * The version this build reports.
 *
 * Declared here rather than read from `package.json` at runtime: a compiled
 * executable has no `package.json` beside it, and `rootDir` keeps the manifest
 * out of the module graph. `src/cli/version.test.ts` asserts this matches the
 * manifest, so the duplication cannot drift silently.
 */
export const FALRYN_VERSION = "0.0.0";

/** Whether this process is a standalone executable rather than a source run. */
export const RUN_MODES = ["source", "compiled"] as const;

export type RunMode = (typeof RUN_MODES)[number];

/**
 * The virtual roots `bun build --compile` mounts a standalone executable's
 * modules under. A source run resolves to a real `file://` path instead, so the
 * prefix is the one signal that does not depend on how the binary was named or
 * where it was copied.
 *
 * There is more than one because Bun names the root per host. Everywhere except
 * Windows it is `/$bunfs/`. Windows needs a drive letter for a file URL to be
 * valid at all, so it mounts `~BUN` on a `B:` drive, and the three properties
 * that expose it disagree on spelling — observed from a compiled binary on a
 * `windows-latest` runner:
 *
 * - `import.meta.url`  → `file:///B:/%7EBUN/root/falryn`
 * - `import.meta.path` → `B:\~BUN\root\falryn`
 * - `Bun.main`         → `B:/~BUN/root/falryn`
 *
 * The percent-escape is the detail that matters: a literal `~` never appears in
 * the URL form, so matching one is what made a compiled Windows binary report
 * itself as a source build. The input is decoded and case-folded first, and all
 * three separators are then accepted, so any of these properties may be passed.
 */
const COMPILED_MODULE_ROOTS = ["/$bunfs/", "b:/~bun/", "b:\\~bun\\"] as const;

/**
 * Percent-escapes resolved, case folded.
 *
 * A malformed escape makes `decodeURIComponent` throw, and a build identity is
 * not worth crashing a run over, so an undecodable value is matched as it
 * arrived rather than rethrown.
 */
function normalizeModuleReference(moduleUrl: string): string {
  try {
    return decodeURIComponent(moduleUrl).toLowerCase();
  } catch {
    return moduleUrl.toLowerCase();
  }
}

export type BuildIdentity = {
  readonly version: string;
  /** The Bun this process is running on. */
  readonly bun: string;
  /** `darwin`, `linux`, or `win32`, and the architecture beside it. */
  readonly platform: string;
  readonly architecture: string;
  readonly mode: RunMode;
};

/** How this module decides, exposed so a test can drive both branches. */
export function runModeFor(moduleUrl: string): RunMode {
  const reference = normalizeModuleReference(moduleUrl);
  return COMPILED_MODULE_ROOTS.some((root) => reference.includes(root)) ? "compiled" : "source";
}

/** What this process is. */
export function buildIdentity(): BuildIdentity {
  return {
    version: FALRYN_VERSION,
    bun: Bun.version,
    platform: process.platform,
    architecture: process.arch,
    mode: runModeFor(import.meta.url),
  };
}

/**
 * One line per fact, in a stable order.
 *
 * Returned as text rather than written, so the caller sends it through the
 * result stream and nothing here touches a handle.
 */
export function versionText(identity: BuildIdentity = buildIdentity()): string {
  return [
    `falryn ${identity.version}`,
    `bun ${identity.bun}`,
    `${identity.platform} ${identity.architecture}`,
    `${identity.mode} build`,
  ].join("\n");
}
