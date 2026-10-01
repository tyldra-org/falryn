/**
 * Validated, immutable command registry generations (#790).
 *
 * A registry is built once from its entries and never mutated. Invalid entries,
 * colliding slash forms and malformed argument schemas fail here, with one
 * diagnostic each, instead of surfacing later as a command that silently does
 * the wrong thing.
 */

import { createHash } from "node:crypto";
import { err, ok, type Result } from "../foundation/result.ts";
import {
  COMMAND_BEHAVIORS,
  COMMAND_CALLERS,
  COMMAND_EFFECTS,
  COMMAND_REGISTRY_LIMITS,
  COMMAND_REGISTRY_SCHEMA_VERSION,
  COMMAND_TIMINGS,
  type CommandSpec,
} from "./command-spec.ts";

export type CommandRegistryDiagnosticCode =
  | "too-many-entries"
  | "id-invalid"
  | "id-duplicate"
  | "text-invalid"
  | "slash-form-invalid"
  | "slash-collision"
  | "fixed-argument-invalid"
  | "argument-invalid"
  | "timing-invalid"
  | "classification-invalid"
  | "status-invalid";

export type CommandRegistryDiagnostic = {
  readonly code: CommandRegistryDiagnosticCode;
  /** The entry the diagnostic names, or `null` for the registry as a whole. */
  readonly commandId: string | null;
  readonly message: string;
};

/** One slash spelling resolved to its entry. */
export type RegisteredSlashForm<T extends CommandSpec = CommandSpec> = {
  readonly form: string;
  /** Lowercase words of the form, including the leading `/name`. */
  readonly words: readonly string[];
  readonly fixedArgument: string | null;
  readonly canonical: boolean;
  /** Declaration order across the registry, for listing forms the way they were written. */
  readonly order: number;
  readonly entry: T;
};

export type CommandRegistry<T extends CommandSpec = CommandSpec> = {
  readonly schemaVersion: typeof COMMAND_REGISTRY_SCHEMA_VERSION;
  /** Content-derived identity: equal entries give an equal generation. */
  readonly generation: string;
  /** Entries in declaration order, which is also the tie-break order of search. */
  readonly entries: readonly T[];
  /** Every slash form, longest first so `/model routes` wins over `/model`. */
  readonly forms: readonly RegisteredSlashForm<T>[];
  entry(id: string): T | undefined;
};

const ID = /^[a-z][a-zA-Z0-9-]*(?:\.[a-z][a-zA-Z0-9-]*)+$/u;
const FORM = /^\/[a-z][a-z0-9-]*(?: [a-z][a-z0-9-]*)*$/u;
const OPTION_VALUE = /^[a-z][a-z0-9-]*$/u;
const OWNER = /^#[1-9][0-9]*$/u;
// biome-ignore lint/suspicious/noControlCharactersInRegex: rejecting control characters is the point.
const CONTROL = /[\u0000-\u001f\u007f]/u;

/**
 * Build one registry generation, or every reason it cannot be built.
 *
 * Generic over the entry type so a host keeps its own fields (key bindings,
 * live availability) on the same objects the registry returns.
 */
export function createCommandRegistry<T extends CommandSpec>(
  specs: readonly T[],
): Result<CommandRegistry<T>, readonly CommandRegistryDiagnostic[]> {
  const diagnostics: CommandRegistryDiagnostic[] = [];
  const report = (
    code: CommandRegistryDiagnosticCode,
    commandId: string | null,
    message: string,
  ): void => {
    diagnostics.push({ code, commandId, message });
  };

  if (specs.length > COMMAND_REGISTRY_LIMITS.entries) {
    report(
      "too-many-entries",
      null,
      `${specs.length} entries exceed the limit of ${COMMAND_REGISTRY_LIMITS.entries}`,
    );
  }

  const byId = new Map<string, T>();
  const formOwners = new Map<string, string>();
  const forms: RegisteredSlashForm<T>[] = [];

  for (const spec of specs) {
    const id = spec.id;
    if (!ID.test(id)) {
      report("id-invalid", id, `"${id}" is not a dotted lowercase action id`);
    } else if (byId.has(id)) {
      report("id-duplicate", id, `"${id}" is declared more than once`);
    } else {
      byId.set(id, spec);
    }

    validateText(spec, report);
    validateClassification(spec, report);
    validateArgument(spec, report);

    if (spec.slash.length > COMMAND_REGISTRY_LIMITS.formsPerEntry) {
      report(
        "slash-form-invalid",
        id,
        `${spec.slash.length} slash forms exceed the limit of ${COMMAND_REGISTRY_LIMITS.formsPerEntry}`,
      );
    }
    spec.slash.forEach((slash, index) => {
      if (!FORM.test(slash.form)) {
        report(
          "slash-form-invalid",
          id,
          `"${slash.form}" must be "/" then lowercase words separated by single spaces`,
        );
        return;
      }
      const owner = formOwners.get(slash.form);
      if (owner !== undefined) {
        report(
          "slash-collision",
          id,
          owner === id
            ? `${slash.form} is listed twice for ${id}`
            : `${slash.form} is claimed by both ${owner} and ${id}`,
        );
        return;
      }
      formOwners.set(slash.form, id);
      const fixedArgument = slash.fixedArgument ?? null;
      if (fixedArgument !== null) validateFixedArgument(spec, slash.form, fixedArgument, report);
      forms.push({
        form: slash.form,
        words: slash.form.split(" "),
        fixedArgument,
        canonical: index === 0,
        order: forms.length,
        entry: spec,
      });
    });
  }

  if (diagnostics.length > 0) return err(diagnostics);

  // More words first, then longer text: `/model routes` must be tried before `/model`.
  forms.sort((a, b) => b.words.length - a.words.length || b.form.length - a.form.length);

  const entries = Object.freeze([...specs]);
  return ok(
    Object.freeze({
      schemaVersion: COMMAND_REGISTRY_SCHEMA_VERSION,
      generation: generationOf(entries),
      entries,
      forms: Object.freeze(forms),
      entry: (id: string) => byId.get(id),
    }),
  );
}

/** Explain a failed build in one line per diagnostic. */
export function describeCommandRegistryDiagnostics(
  diagnostics: readonly CommandRegistryDiagnostic[],
): string {
  return diagnostics
    .map((d) => `${d.commandId === null ? "registry" : d.commandId}: ${d.message} (${d.code})`)
    .join("\n");
}

type Report = (
  code: CommandRegistryDiagnosticCode,
  commandId: string | null,
  message: string,
) => void;

function boundedText(value: string, limit: number): boolean {
  return value.trim() !== "" && value.length <= limit && !CONTROL.test(value);
}

function validateText(spec: CommandSpec, report: Report): void {
  if (!boundedText(spec.title, COMMAND_REGISTRY_LIMITS.titleCharacters)) {
    report("text-invalid", spec.id, "title must be 1-80 printable characters");
  }
  if (!boundedText(spec.description, COMMAND_REGISTRY_LIMITS.descriptionCharacters)) {
    report("text-invalid", spec.id, "description must be 1-400 printable characters");
  }
  if (
    spec.keywords.some((keyword) => !boundedText(keyword, COMMAND_REGISTRY_LIMITS.hintCharacters))
  ) {
    report("text-invalid", spec.id, "keywords must be short printable words");
  }
}

function validateClassification(spec: CommandSpec, report: Report): void {
  if (!(COMMAND_TIMINGS as readonly string[]).includes(spec.timing)) {
    report("timing-invalid", spec.id, `timing "${String(spec.timing)}" is not declared`);
  }
  if (!(COMMAND_EFFECTS as readonly string[]).includes(spec.effect)) {
    report("classification-invalid", spec.id, `effect "${String(spec.effect)}" is unknown`);
  }
  if (!(COMMAND_BEHAVIORS as readonly string[]).includes(spec.behavior)) {
    report("classification-invalid", spec.id, `behavior "${String(spec.behavior)}" is unknown`);
  }
  if (spec.confirmation !== "none" && spec.confirmation !== "focused") {
    report(
      "classification-invalid",
      spec.id,
      `confirmation "${String(spec.confirmation)}" is unknown`,
    );
  }
  if (
    spec.callers.length === 0 ||
    new Set(spec.callers).size !== spec.callers.length ||
    spec.callers.some((caller) => !(COMMAND_CALLERS as readonly string[]).includes(caller))
  ) {
    report(
      "classification-invalid",
      spec.id,
      "callers must be a non-empty set of interactive, headless and model",
    );
  }
  if (
    spec.status.kind === "planned" &&
    (!OWNER.test(spec.status.owner) || !boundedText(spec.status.reason, 200))
  ) {
    report("status-invalid", spec.id, "a planned entry needs an owning #issue and a reason");
  }
}

function validateArgument(spec: CommandSpec, report: Report): void {
  const argument = spec.argument;
  switch (argument.kind) {
    case "none":
      return;
    case "options": {
      if (!boundedText(argument.hint, COMMAND_REGISTRY_LIMITS.hintCharacters)) {
        report("argument-invalid", spec.id, "options need a short hint");
      }
      if (
        argument.options.length === 0 ||
        argument.options.length > COMMAND_REGISTRY_LIMITS.optionsPerEntry
      ) {
        report(
          "argument-invalid",
          spec.id,
          `options must list 1-${COMMAND_REGISTRY_LIMITS.optionsPerEntry} values`,
        );
      }
      const seen = new Set<string>();
      for (const option of argument.options) {
        if (!OPTION_VALUE.test(option.value) || seen.has(option.value)) {
          report(
            "argument-invalid",
            spec.id,
            `option "${option.value}" must be a unique lowercase word`,
          );
        }
        seen.add(option.value);
        if (
          option.operand !== null &&
          !boundedText(option.operand.hint, COMMAND_REGISTRY_LIMITS.hintCharacters)
        ) {
          report("argument-invalid", spec.id, `option "${option.value}" needs an operand hint`);
        }
        if (
          option.timing !== undefined &&
          !(COMMAND_TIMINGS as readonly string[]).includes(option.timing)
        ) {
          report(
            "timing-invalid",
            spec.id,
            `option "${option.value}" timing "${String(option.timing)}" is not declared`,
          );
        }
      }
      return;
    }
    case "text":
      if (!boundedText(argument.hint, COMMAND_REGISTRY_LIMITS.hintCharacters)) {
        report("argument-invalid", spec.id, "a text argument needs a short hint");
      }
      if (
        !Number.isSafeInteger(argument.maxBytes) ||
        argument.maxBytes < 1 ||
        argument.maxBytes > COMMAND_REGISTRY_LIMITS.textArgumentBytes
      ) {
        report(
          "argument-invalid",
          spec.id,
          `a text argument must allow 1-${COMMAND_REGISTRY_LIMITS.textArgumentBytes} bytes`,
        );
      }
      if (
        argument.timing !== undefined &&
        !(COMMAND_TIMINGS as readonly string[]).includes(argument.timing)
      ) {
        report(
          "timing-invalid",
          spec.id,
          `argument timing "${String(argument.timing)}" is not declared`,
        );
      }
      return;
    default: {
      const unknown: never = argument;
      report("argument-invalid", spec.id, `argument kind ${JSON.stringify(unknown)} is unknown`);
    }
  }
}

function validateFixedArgument(
  spec: CommandSpec,
  form: string,
  fixedArgument: string,
  report: Report,
): void {
  const argument = spec.argument;
  const valid =
    argument.kind === "options"
      ? argument.options.some(
          (option) => option.value === fixedArgument && option.operand?.required !== true,
        )
      : argument.kind === "text" &&
        fixedArgument.trim() !== "" &&
        Buffer.byteLength(fixedArgument, "utf8") <= argument.maxBytes;
  if (!valid) {
    report(
      "fixed-argument-invalid",
      spec.id,
      `${form} supplies "${fixedArgument}", which ${spec.id} does not accept on its own`,
    );
  }
}

function generationOf(entries: readonly CommandSpec[]): string {
  // Host fields such as availability functions drop out of JSON; only the contract counts.
  const contract = entries.map((entry) => ({
    id: entry.id,
    title: entry.title,
    description: entry.description,
    keywords: entry.keywords,
    slash: entry.slash,
    argument: entry.argument,
    timing: entry.timing,
    effect: entry.effect,
    confirmation: entry.confirmation,
    behavior: entry.behavior,
    callers: entry.callers,
    status: entry.status,
  }));
  const digest = createHash("sha256").update(JSON.stringify(contract)).digest("hex");
  return `commands-v${COMMAND_REGISTRY_SCHEMA_VERSION}:${digest.slice(0, 16)}`;
}
