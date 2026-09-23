/**
 * Align reviewed direct-dependency version pins with an updated manifest.
 *
 * Dependabot bumps `package.json` and `bun.lock` but not the version pins in
 * `repository-integrity.ts` or Biome's schema URL. This rewrites only those
 * version strings. License, repository, and install-hook admission stay with
 * the integrity check, which still fails when a new version changes them.
 *
 * It imports nothing from `node_modules`: the Dependabot workflow runs it
 * without installing, so no package code executes beside a writable token.
 */

import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

type DependencyGroup = "dependencies" | "devDependencies";

export type PinSyncResult = Readonly<{
  integritySource: string;
  biomeSource: string;
  changed: readonly string[];
}>;

const EXACT_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const POLICY_ENTRY =
  /(\{\s*name: ")([^"]+)(",\s*group: ")(dependencies|devDependencies)(",\s*version: ")([^"]+)(")/g;
const BIOME_SCHEMA = /(https:\/\/biomejs\.dev\/schemas\/)([^/]+)(\/schema\.json)/;

function declaredVersions(manifest: unknown): ReadonlyMap<string, Map<string, string>> {
  if (typeof manifest !== "object" || manifest === null) {
    throw new Error("package manifest is not an object");
  }
  const groups = new Map<string, Map<string, string>>();
  for (const group of ["dependencies", "devDependencies"] as const) {
    const entries = (manifest as Record<string, unknown>)[group] ?? {};
    if (typeof entries !== "object" || entries === null) {
      throw new Error(`package manifest ${group} is not an object`);
    }
    groups.set(
      group,
      new Map(
        Object.entries(entries).map(([name, version]) => {
          if (typeof version !== "string") {
            throw new Error(`${name} has a non-string version`);
          }
          return [name, version];
        }),
      ),
    );
  }
  return groups;
}

/** Pure rewrite. Throws before returning anything when a pin cannot be derived. */
export function syncDependencyPins(input: {
  readonly manifest: unknown;
  readonly integritySource: string;
  readonly biomeSource: string;
}): PinSyncResult {
  const groups = declaredVersions(input.manifest);
  const policyGroups = new Map(
    [...input.integritySource.matchAll(POLICY_ENTRY)].map((entry) => [entry[2], entry[4]]),
  );
  if (policyGroups.size === 0) {
    throw new Error("no direct-dependency policy entries were found");
  }
  // Admitting a new package or moving it between groups is a review decision.
  for (const [group, versions] of groups) {
    for (const name of versions.keys()) {
      const policyGroup = policyGroups.get(name);
      if (policyGroup === undefined) {
        throw new Error(`${name} has no reviewed policy entry`);
      }
      if (policyGroup !== group) {
        throw new Error(`${name} is declared in ${group} but reviewed for ${policyGroup}`);
      }
    }
  }

  const changed: string[] = [];
  const integritySource = input.integritySource.replace(
    POLICY_ENTRY,
    (entry, open, name, afterName, group: DependencyGroup, afterGroup, pin, close) => {
      const declared = groups.get(group)?.get(name);
      if (declared === undefined || declared === pin) {
        return entry;
      }
      if (!EXACT_VERSION.test(declared)) {
        throw new Error(`${name} declares ${declared}, not an exact version`);
      }
      changed.push(`${name} ${pin} -> ${declared}`);
      return `${open}${name}${afterName}${group}${afterGroup}${declared}${close}`;
    },
  );

  let biomeSource = input.biomeSource;
  const biome = groups.get("devDependencies")?.get("@biomejs/biome");
  const schema = BIOME_SCHEMA.exec(biomeSource);
  if (biome !== undefined && schema !== null && schema[2] !== biome) {
    if (!EXACT_VERSION.test(biome)) {
      throw new Error(`@biomejs/biome declares ${biome}, not an exact version`);
    }
    biomeSource = biomeSource.replace(BIOME_SCHEMA, `$1${biome}$3`);
    changed.push(`biome.json schema ${schema[2]} -> ${biome}`);
  }

  return { integritySource, biomeSource, changed };
}

async function main(): Promise<void> {
  const root = dirname(dirname(dirname(import.meta.path)));
  const integrityPath = join(root, "tools/quality/repository-integrity.ts");
  const biomePath = join(root, "biome.json");
  try {
    const [manifest, integritySource, biomeSource] = await Promise.all([
      readFile(join(root, "package.json"), "utf8").then(JSON.parse),
      readFile(integrityPath, "utf8"),
      readFile(biomePath, "utf8"),
    ]);
    const result = syncDependencyPins({ manifest, integritySource, biomeSource });
    if (result.integritySource !== integritySource) {
      await writeFile(integrityPath, result.integritySource);
    }
    if (result.biomeSource !== biomeSource) {
      await writeFile(biomePath, result.biomeSource);
    }
    console.log(
      result.changed.length === 0
        ? "dependency pins already match package.json"
        : result.changed.map((change) => `pinned ${change}`).join("\n"),
    );
  } catch (error) {
    console.error(`dependency pin sync refused: ${(error as Error).message}`);
    process.exitCode = 1;
  }
}

if (import.meta.main) {
  await main();
}
