/**
 * The six ordered layers, folded into one effective configuration.
 *
 * Precedence is declared data — `CONFIGURATION_LAYER_ORDER` — rather than the
 * order a function happens to call things in, so it can be asserted directly.
 *
 * Three rules worth stating:
 *
 * - **Merging is schema-defined, never generic.** Each key folds by the
 *   behavior it declares, using the same fold the registry applies between a
 *   document and the defaults. There is no deep merge anywhere in this file.
 * - **A folded value is rechecked.** A fold can produce a value neither layer
 *   stated — an identified list at its maximum folded onto a non-empty one is
 *   longer than both — so per-layer validation proves nothing about the result.
 * - **Every effective value keeps provenance, and every loser is kept too.**
 *   Inspection has to answer "where did this come from, and what did it beat"
 *   without re-reading a single file.
 */

import {
  CONFIGURATION_LAYER_ORDER,
  type ConfigurationIssue,
  type ConfigurationKeyPath,
  type ConfigurationRegistryPort,
  type ConfigurationScope,
  type ConfigurationSource,
  type ConfigurationValue,
  type ConfigurationValues,
  configurationKeyPath,
  type OverriddenValue,
  type SensitiveValueRedactor,
  type ValueProvenance,
} from "../domain/index.ts";
import type { ConfigurationKeyDeclaration } from "./declaration.ts";
import { foldDeclaredValue } from "./registry.ts";
import { CONFIGURATION_SCHEMA_VERSION } from "./schema-family.ts";

/** One layer's already-validated contribution. */
export type LayerInput = {
  readonly source: ConfigurationSource;
  /** `null` only for built-in defaults, which no scope set. */
  readonly scope: ConfigurationScope | null;
  readonly values: ConfigurationValues;
};

export type CompositionInputs = {
  readonly registry: ConfigurationRegistryPort;
  readonly declarations: readonly ConfigurationKeyDeclaration[];
  readonly redactor: SensitiveValueRedactor;
  /** File and supplied layers, in any order; precedence is applied here. */
  readonly layers: readonly LayerInput[];
};

export type Composition = {
  readonly values: ConfigurationValues;
  readonly provenance: readonly ValueProvenance[];
  readonly overridden: readonly OverriddenValue[];
  readonly issues: readonly ConfigurationIssue[];
};

/**
 * Folds every layer in declared precedence order.
 *
 * The defaults layer is synthesized here rather than supplied, because a caller
 * that could omit it would produce a configuration missing keys nobody set —
 * and "absent" is not a value any consumer is prepared for.
 */
export function composeLayers(inputs: CompositionInputs): Composition {
  const byPath = new Map<string, ConfigurationKeyDeclaration>();
  for (const declaration of inputs.declarations) {
    byPath.set(declaration.descriptor.path, declaration);
  }

  const values: Record<string, ConfigurationValue> = { ...inputs.registry.defaults() };
  const provenance = new Map<string, ValueProvenance>();
  const overridden: OverriddenValue[] = [];
  const issues: ConfigurationIssue[] = [];

  const defaultsSource: ConfigurationSource = {
    kind: "built-in-default",
    file: null,
    profile: null,
  };
  for (const path of Object.keys(values)) {
    provenance.set(path, {
      path: configurationKeyPath(path),
      source: defaultsSource,
      scope: null,
      layerIndex: 0,
      schemaVersion: CONFIGURATION_SCHEMA_VERSION,
      redactedOriginal: inputs.registry.render(path, values[path] as ConfigurationValue),
    });
  }

  for (const [layerIndex, kind] of CONFIGURATION_LAYER_ORDER.entries()) {
    if (kind === "built-in-default") {
      continue;
    }
    for (const layer of inputs.layers.filter((candidate) => candidate.source.kind === kind)) {
      applyLayer(layer, layerIndex, {
        byPath,
        values,
        provenance,
        overridden,
        issues,
        registry: inputs.registry,
        redactor: inputs.redactor,
      });
    }
  }

  return {
    values,
    provenance: [...provenance.values()].sort((left, right) => left.path.localeCompare(right.path)),
    overridden,
    issues,
  };
}

type ApplyContext = {
  readonly byPath: ReadonlyMap<string, ConfigurationKeyDeclaration>;
  readonly values: Record<string, ConfigurationValue>;
  readonly provenance: Map<string, ValueProvenance>;
  readonly overridden: OverriddenValue[];
  readonly issues: ConfigurationIssue[];
  readonly registry: ConfigurationRegistryPort;
  readonly redactor: SensitiveValueRedactor;
};

function applyLayer(layer: LayerInput, layerIndex: number, context: ApplyContext): void {
  for (const [path, incoming] of Object.entries(layer.values)) {
    const declaration = context.byPath.get(path);
    if (declaration === undefined) {
      continue;
    }

    const previous = context.provenance.get(path);
    if (previous !== undefined && previous.source.kind !== "built-in-default") {
      // Kept rather than discarded: inspection shows what a value beat, which
      // is how a user discovers that their project file lost to a CLI flag.
      context.overridden.push({
        path: previous.path,
        source: previous.source,
        redactedOriginal: previous.redactedOriginal,
      });
    }

    const folded = foldDeclaredValue(declaration.descriptor.merge, context.values[path], incoming);

    // A fold can produce a value neither layer stated, so the result is checked
    // against the declaration that bounds it rather than assumed valid.
    const rechecked = declaration.validate(folded);
    if (!rechecked.ok) {
      context.issues.push(...rechecked.error);
      continue;
    }

    context.values[path] = rechecked.value;
    context.provenance.set(path, {
      path: configurationKeyPath(path),
      source: layer.source,
      scope: layer.scope,
      layerIndex,
      schemaVersion: CONFIGURATION_SCHEMA_VERSION,
      redactedOriginal: context.registry.render(path, incoming),
    });
  }
}

/** The keys one layer contributed, for its source report. */
export function declaredKeysOf(values: ConfigurationValues): readonly ConfigurationKeyPath[] {
  return Object.keys(values)
    .sort()
    .map((path) => configurationKeyPath(path));
}
