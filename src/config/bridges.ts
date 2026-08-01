/**
 * The two layers that read no file.
 *
 * **The environment bridge reads only keys that declare a mapping.** It does
 * not scan the environment for anything that looks like a Falryn setting, and a
 * variable whose key declares no mapping is ignored rather than guessed at —
 * a process environment is full of values that resemble configuration and are
 * not, and adopting one silently is how a CI runner's unrelated variable
 * changes a user's settings.
 *
 * Both bridges take strings, because that is all a shell or an argument vector
 * can carry, and coerce them to the JSON shape each key declares. Coercion is
 * narrow and refuses rather than guessing: `"yes"` is not a boolean here.
 *
 * Neither bridge copies a value into a durable record. What they produce is a
 * layer, and a layer is composed and discarded.
 */

import {
  type ConfigurationIssue,
  type ConfigurationKeyDescriptor,
  type ConfigurationRegistryPort,
  type ConfigurationValue,
  type ConfigurationValues,
  type EnvironmentPort,
  UNLIMITED,
} from "../domain/index.ts";

export type BridgeResult = {
  readonly values: ConfigurationValues;
  readonly issues: readonly ConfigurationIssue[];
  /** Variables that were set but map to no key. Reported, never applied. */
  readonly ignored: readonly string[];
};

/**
 * Reads every key that declares an environment variable.
 *
 * Driven by the registry rather than by the environment: the set of variables
 * consulted is exactly the set the catalog declares, so adding a variable is a
 * deliberate declaration and never an accident of naming.
 */
export function readEnvironmentLayer(
  registry: ConfigurationRegistryPort,
  environment: EnvironmentPort,
): BridgeResult {
  const values: Record<string, ConfigurationValue> = {};
  const issues: ConfigurationIssue[] = [];

  for (const descriptor of registry.keys()) {
    if (descriptor.environmentVariable === null) {
      continue;
    }
    const raw = environment.get(descriptor.environmentVariable);
    if (raw === null) {
      continue;
    }
    const coerced = coerce(raw, descriptor);
    if (coerced === null) {
      issues.push(invalidFor(descriptor));
      continue;
    }
    values[descriptor.path] = coerced;
  }

  return { values, issues, ignored: [] };
}

/**
 * Applies an already-parsed map of key path to raw string.
 *
 * yargs parsing belongs to the command owner, so this takes the map rather than
 * an argument vector. A path nothing declares is reported as an unknown key —
 * a mistyped flag must not be silently ignored, for the same reason a mistyped
 * key in a file must not be.
 */
export function readOverrideLayer(
  registry: ConfigurationRegistryPort,
  overrides: Readonly<Record<string, string>>,
): BridgeResult {
  const values: Record<string, ConfigurationValue> = {};
  const issues: ConfigurationIssue[] = [];
  const ignored: string[] = [];

  for (const [path, raw] of Object.entries(overrides)) {
    const resolution = registry.resolve(path);
    if (resolution.kind === "unknown") {
      issues.push({ kind: "unknown-key", severity: "error", path });
      ignored.push(path);
      continue;
    }
    const { descriptor } = resolution;
    const coerced = coerce(raw, descriptor);
    if (coerced === null) {
      issues.push(invalidFor(descriptor));
      continue;
    }
    values[descriptor.path] = coerced;
  }

  return { values, issues, ignored };
}

function invalidFor(descriptor: ConfigurationKeyDescriptor): ConfigurationIssue {
  return descriptor.valueType === "integer" || descriptor.valueType === "limit"
    ? {
        kind: "out-of-range",
        severity: "error",
        path: descriptor.path,
        unit: descriptor.unit,
        minimum: descriptor.minimum,
        maximum: descriptor.maximum,
      }
    : {
        kind: "invalid-value",
        severity: "error",
        path: descriptor.path,
        allowed: descriptor.allowedValues ?? [],
      };
}

/**
 * Narrows a string onto the shape a key declares.
 *
 * Returns `null` when the text is not that shape. Nothing is guessed: a
 * boolean accepts `true` and `false` and nothing else, because a shell that
 * exports `FALRYN_SOMETHING=0` means something the author has to state rather
 * than something this code should infer.
 *
 * A `map`, `array`, or `object` key is not settable from a string at all. Those
 * shapes exist in files; a flat variable cannot express one, and accepting
 * embedded JSON here would make a shell variable a second configuration format.
 */
function coerce(raw: string, descriptor: ConfigurationKeyDescriptor): ConfigurationValue | null {
  const text = raw.trim();
  switch (descriptor.valueType) {
    case "string":
      return text.length === 0 ? null : text;
    case "boolean":
      return text === "true" ? true : text === "false" ? false : null;
    case "enum":
      return descriptor.allowedValues?.includes(text) === true ? text : null;
    case "integer":
      return integerOrNull(text);
    case "limit":
      return text === UNLIMITED ? UNLIMITED : integerOrNull(text);
    case "map":
    case "array":
    case "object":
      return null;
  }
}

function integerOrNull(text: string): number | null {
  if (!/^-?\d+$/.test(text)) {
    return null;
  }
  const value = Number(text);
  return Number.isSafeInteger(value) ? value : null;
}
