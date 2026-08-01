/**
 * The configuration as a caller may display it.
 *
 * A data structure, never text: human, plain, JSON, and JSONL rendering belong
 * to the surfaces, and a projection that formatted anything would force every
 * surface to agree with one of them.
 *
 * Every value here is already rendered through its key's declared sensitivity,
 * and every overridden value was redacted when its provenance was recorded. The
 * projection therefore cannot leak by omission — there is no path through it
 * that reaches a raw byte, so a new surface cannot forget to redact.
 */

import type {
  ConfigurationGenerationRecord,
  ConfigurationInspection,
  ConfigurationRegistryPort,
  InspectedValue,
  OverriddenValue,
} from "../domain/index.ts";

/**
 * Projects one generation.
 *
 * Keys are emitted in canonical path order rather than in the order any layer
 * set them, so two inspections of the same configuration are comparable and a
 * surface can diff them without sorting first.
 */
export function inspectGeneration(
  registry: ConfigurationRegistryPort,
  record: ConfigurationGenerationRecord,
): ConfigurationInspection {
  const overriddenByPath = new Map<string, OverriddenValue[]>();
  for (const overridden of record.overridden) {
    const existing = overriddenByPath.get(overridden.path) ?? [];
    existing.push(overridden);
    overriddenByPath.set(overridden.path, existing);
  }

  const values: InspectedValue[] = [];
  for (const provenance of [...record.provenance].sort((left, right) =>
    left.path.localeCompare(right.path),
  )) {
    const raw = record.values[provenance.path];
    if (raw === undefined) {
      continue;
    }
    values.push({
      path: provenance.path,
      // Rendered through the declared sensitivity, so a sensitive key shows its
      // placeholder here exactly as it does everywhere else.
      value: registry.render(provenance.path, raw),
      source: provenance.source,
      scope: provenance.scope,
      overriddenBy: overriddenByPath.get(provenance.path) ?? [],
    });
  }

  return {
    generation: record.generation,
    values,
    sources: record.sources,
    issues: record.issues,
  };
}
