import { z } from "zod";
import { MAX_COMMAND_ENVIRONMENT_BYTES, MAX_COMMAND_ENVIRONMENT_ENTRIES } from "./process.ts";

export const ENVIRONMENT_PREPARATION_MS = 30_000;
export const ENVIRONMENT_KEY = "execution.environment";
const name = z
  .string()
  .regex(/^[A-Za-z_][A-Za-z0-9_]*$/)
  .max(256)
  .refine((value) => !["__proto__", "constructor", "prototype"].includes(value));
const names = z
  .array(name)
  .max(MAX_COMMAND_ENVIRONMENT_ENTRIES)
  .refine((values) => new Set(values).size === values.length);
const text = z.string().refine((value) => !value.includes("\0"));
const paths = z.array(text.min(1)).max(MAX_COMMAND_ENVIRONMENT_ENTRIES);

export const environmentPreparationSchema = z
  .object({
    source: text.min(1).max(1024).optional(),
    interpreter: text.min(1).max(1024),
    exports: names,
    required: z.boolean(),
  })
  .strict();

/** Missing fields inherit; empty child values and explicit removals are distinct. */
export const environmentEditsSchema = z
  .object({
    set: z
      .preprocess(
        (value, context) => {
          if (value && typeof value === "object" && Object.hasOwn(value, "__proto__"))
            context.addIssue({ code: "custom", message: "Invalid environment name." });
          return value;
        },
        z.record(name, text),
      )
      .optional(),
    unset: names.optional(),
    pathPrepend: paths.optional(),
    pathAppend: paths.optional(),
    inheritedNames: names.optional(),
    operationNames: names.optional(),
    allowProject: z.boolean().optional(),
    preparation: environmentPreparationSchema.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if ((value.unset ?? []).some((key) => Object.hasOwn(value.set ?? {}, key)))
      context.addIssue({ code: "custom", message: "A name cannot be both set and unset." });
    if (environmentError(value.set ?? {}, false))
      context.addIssue({ code: "custom", message: "Environment values exceed their bounds." });
  });

export type EnvironmentEdits = z.infer<typeof environmentEditsSchema>;
export type EnvironmentPreparation = z.infer<typeof environmentPreparationSchema>;
export type EnvironmentMap = Readonly<Record<string, string>>;
export type EnvironmentDelta = {
  readonly set: EnvironmentMap;
  readonly unset: readonly string[];
};

/** A consumer cannot opt out of executable-injection restrictions. */
export function forbiddenEnvironmentName(key: string): boolean {
  return /^(?:BASH_ENV|ENV|ZDOTDIR|SHELLOPTS|BASHOPTS|NODE_OPTIONS|BUN_OPTIONS|LD_.*|DYLD_.*|FALRYN_ENV_INTERNAL_.*)$/i.test(
    key,
  );
}

export function environmentError(values: EnvironmentMap, windows: boolean): string | null {
  const entries = Object.entries(values);
  if (entries.length > MAX_COMMAND_ENVIRONMENT_ENTRIES) return "environment-too-large";
  const seen = new Set<string>();
  let bytes = 0;
  for (const [key, value] of entries) {
    if (!name.safeParse(key).success || typeof value !== "string" || value.includes("\0"))
      return "invalid-environment";
    const identity = windows ? key.toUpperCase() : key;
    if (seen.has(identity)) return "ambiguous-environment-name";
    seen.add(identity);
    bytes += new TextEncoder().encode(`${key}=${value}`).length;
  }
  return bytes > MAX_COMMAND_ENVIRONMENT_BYTES ? "environment-too-large" : null;
}

export function applyEnvironmentEdits(
  base: EnvironmentMap,
  edits: EnvironmentEdits,
  separator: ":" | ";",
): Record<string, string> {
  const values = { ...base };
  for (const key of edits.unset ?? []) {
    const actual =
      separator === ";"
        ? Object.keys(values).find((name) => name.toUpperCase() === key.toUpperCase())
        : key;
    if (actual !== undefined) delete values[actual];
  }
  Object.assign(values, edits.set);
  if (edits.pathPrepend?.length || edits.pathAppend?.length) {
    const key =
      separator === ";"
        ? (Object.keys(values).find((key) => key.toUpperCase() === "PATH") ?? "PATH")
        : "PATH";
    values[key] = [
      ...(edits.pathPrepend ?? []),
      ...(values[key] ? [values[key]] : []),
      ...(edits.pathAppend ?? []),
    ].join(separator);
  }
  return values;
}

/** Parse an exact NUL frame. No diagnostics, shell syntax or partial output is accepted. */
export function parseEnvironmentFrame(
  frame: string,
  identity: string,
  declared: readonly string[],
): EnvironmentDelta | null {
  const fields = frame.split("\0");
  if (fields.shift() !== identity || fields.pop() !== "" || fields.pop() !== "END") return null;
  const set: Record<string, string> = Object.create(null);
  const unset: string[] = [];
  const seen = new Set<string>();
  while (fields.length) {
    const kind = fields.shift();
    const key = fields.shift();
    if (!key || !declared.includes(key) || seen.has(key)) return null;
    seen.add(key);
    if (kind === "S") {
      const value = fields.shift();
      if (value === undefined) return null;
      set[key] = value;
    } else if (kind === "U") unset.push(key);
    else return null;
  }
  return seen.size === declared.length && !environmentError(set, false) ? { set, unset } : null;
}
