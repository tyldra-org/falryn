/**
 * Diffing two generations, classifying what changed, and publishing.
 *
 * The classification a change carries is the key's own declared application
 * class, not a judgement made here. A caller asks "may I apply this in place,
 * or must something restart", and the only honest answer is the one the key's
 * author wrote down.
 *
 * A refresh that changes nothing publishes nothing. That is a distinct outcome
 * rather than a publish with an empty diff: allocating a generation per poll
 * would make every consumer that keys off the generation identity re-do work
 * for a configuration that did not move.
 */

import {
  type ConfigurationChange,
  type ConfigurationGenerationRecord,
  type ConfigurationRegistryPort,
  type ConfigurationValue,
  type ConfigurationValues,
  configurationKeyPath,
} from "../../domain/configuration/index.ts";
import type { ConfigurationGeneration } from "../../domain/foundation/index.ts";
import type { ConfigurationApplicationClass } from "../../domain/sessions/index.ts";

/**
 * Strongest-first, so folding a set of changes is a maximum.
 *
 * A refresh that can be applied live for one key and needs a restart for
 * another needs a restart. Reporting the weaker class would tell a caller it
 * could keep running with a setting that is not in effect.
 */
const CLASS_SEVERITY: Readonly<Record<ConfigurationApplicationClass, number>> = {
  live: 0,
  "next-operation": 1,
  "next-turn": 2,
  reconnect: 3,
  "application-restart": 4,
};

/**
 * Compares two composed values key by key.
 *
 * Deep equality by canonical JSON. Values here are plain JSON structures whose
 * key order is fixed by the registry's own iteration, so equal values encode
 * equally — and a structural comparison is what makes a map whose entries were
 * rewritten in the same order compare equal rather than looking changed.
 */
export function diffGenerations(
  registry: ConfigurationRegistryPort,
  before: ConfigurationValues,
  after: ConfigurationValues,
): readonly ConfigurationChange[] {
  const changes: ConfigurationChange[] = [];

  for (const descriptor of registry.keys()) {
    const { path } = descriptor;
    const previous = before[path];
    const next = after[path];
    if (canonical(previous) === canonical(next)) {
      continue;
    }
    changes.push({
      path: configurationKeyPath(path),
      applicationClass: descriptor.applicationClass,
      // Both sides rendered through the key's declared sensitivity, so a diff
      // is exactly as safe to log as a diagnostic is.
      redactedBefore: previous === undefined ? null : registry.render(path, previous),
      redactedAfter: next === undefined ? null : registry.render(path, next),
    });
  }

  return changes;
}

/**
 * A stable string for one value, and a sentinel for absence.
 *
 * The sentinel is written as an escape rather than as a literal control
 * character: a raw NUL in the source makes Git classify this file as binary,
 * which would render the whole module unreviewable in a diff. `JSON.stringify`
 * never produces a leading NUL for a defined value, so nothing can collide
 * with it.
 */
function canonical(value: ConfigurationValue | undefined): string {
  return value === undefined ? "\u0000absent" : JSON.stringify(value);
}

/** The strongest class among a set of changes. */
export function strongestApplicationClass(
  changes: readonly ConfigurationChange[],
): ConfigurationApplicationClass {
  let strongest: ConfigurationApplicationClass = "live";
  for (const change of changes) {
    if (CLASS_SEVERITY[change.applicationClass] > CLASS_SEVERITY[strongest]) {
      strongest = change.applicationClass;
    }
  }
  return strongest;
}

/** The next generation after `current`, or the first one. */
export function nextGeneration(
  current: ConfigurationGenerationRecord | null,
  first: ConfigurationGeneration,
): ConfigurationGeneration {
  return current === null ? first : ((current.generation + 1) as ConfigurationGeneration);
}
