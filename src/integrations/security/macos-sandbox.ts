import { realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute } from "node:path";
import {
  hasSandboxPathControl,
  type SandboxBoundary,
  type SandboxLaunchRequest,
} from "../../domain/security/sandbox.ts";

export const SEATBELT_EXECUTABLE = "/usr/bin/sandbox-exec";
export const SEATBELT_RUNTIME_READ_ROOTS = [
  "/System/Library",
  "/usr/lib",
  "/Library/Apple",
] as const;

export function canonicalSandboxRoot(path: string): string {
  if (!isAbsolute(path) || path.length > 1_024 || hasSandboxPathControl(path))
    throw new Error("invalid-sandbox-root");
  const canonical = realpathSync(path);
  if (
    canonical.length > 1_024 ||
    hasSandboxPathControl(canonical) ||
    !statSync(canonical).isDirectory()
  )
    throw new Error("invalid-sandbox-root");
  return canonical;
}

/** No imported profiles, shell interpolation, profile files or inherited environment. */
export function seatbeltLaunch(
  request: SandboxLaunchRequest,
  boundary: SandboxBoundary,
  aliases: readonly string[] = [],
): {
  readonly executable: string;
  readonly argv: readonly string[];
} {
  const executable = realpathSync(request.executable);
  if (!isAbsolute(executable) || hasSandboxPathControl(executable))
    throw new Error("invalid-sandbox-executable");
  const quote = (value: string): string => JSON.stringify(value);
  // Confirmed grants use canonical paths. Preserve existence checks through
  // macOS's public /var, /tmp and /etc aliases without granting alias data access.
  const rootAliases = new Set(aliases);
  for (const root of [...boundary.readRoots, ...boundary.writeRoots]) {
    if (/^\/private\/(?:var|tmp|etc)(?:\/|$)/.test(root)) {
      const alias = root.slice("/private".length);
      if (realpathSync(alias) === root) rootAliases.add(alias);
    }
  }
  const ancestors = new Set<string>();
  for (const root of [...boundary.readRoots, ...boundary.writeRoots, ...rootAliases, executable]) {
    let parent = dirname(root);
    while (parent !== dirname(parent)) {
      ancestors.add(parent);
      parent = dirname(parent);
    }
  }
  const rules = [
    // Legacy profiles leave syscall filtering implicit. Version 3 applies the
    // explicit numeric-sysctl/ptrace denial, including reads of another process's
    // initial environment. Runtime hardware queries use the named allowlist.
    "(version 3)",
    "(deny default)",
    "(allow syscall*)",
    "(allow mach-bootstrap)",
    "(allow process-info-pidinfo process-info-codesignature (target self))",
    "(allow system-fcntl (fcntl-command F_GETPATH))",
    "(deny syscall-unix (syscall-number 202 26))",
    '(allow sysctl-read (sysctl-name "hw.memsize" "hw.pagesize" "hw.pagesize_compat" "hw.ncpu" "hw.activecpu" "hw.physicalcpu" "hw.physicalcpu_max" "hw.logicalcpu" "hw.logicalcpu_max" "hw.cputype" "hw.cpusubtype" "kern.osrelease" "kern.osversion" "kern.ostype"))',
    `(allow process-exec (literal ${quote(executable)}))`,
    // The loader opens the root directory; this is a literal, never a subpath grant.
    '(allow file-read* file-test-existence (literal "/"))',
    '(allow file-read* file-test-existence file-write* (literal "/dev/null"))',
    `(allow file-read* file-test-existence file-map-executable (literal ${quote(executable)}))`,
    ...[...rootAliases].map((path) => `(allow file-test-existence (subpath ${quote(path)}))`),
    ...[...ancestors].map(
      (path) => `(allow file-read-metadata file-test-existence (literal ${quote(path)}))`,
    ),
    ...SEATBELT_RUNTIME_READ_ROOTS.map(
      (path) =>
        `(allow file-read* file-test-existence file-map-executable (subpath ${quote(path)}))`,
    ),
    ...boundary.readRoots.map(
      (path) =>
        `(allow file-read* file-test-existence file-map-executable (subpath ${quote(path)}))`,
    ),
    ...boundary.writeRoots.map(
      (path) =>
        `(allow file-read* file-test-existence file-write* file-map-executable (subpath ${quote(path)}))`,
    ),
  ];
  return {
    executable: SEATBELT_EXECUTABLE,
    argv: ["-p", rules.join("\n"), executable, ...request.argv],
  };
}
