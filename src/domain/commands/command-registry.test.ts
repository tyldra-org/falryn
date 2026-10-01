import { describe, expect, test } from "bun:test";
import { commandSpec, SAMPLE_SPECS, sampleRegistry } from "./command.fixtures.ts";
import {
  type CommandRegistryDiagnosticCode,
  createCommandRegistry,
  describeCommandRegistryDiagnostics,
} from "./command-registry.ts";
import { COMMAND_REGISTRY_LIMITS, type CommandSpec } from "./command-spec.ts";

function codes(specs: readonly CommandSpec[]): readonly CommandRegistryDiagnosticCode[] {
  const built = createCommandRegistry(specs);
  return built.ok ? [] : built.error.map((diagnostic) => diagnostic.code);
}

describe("command registry generations", () => {
  test("publishes an immutable generation with every form resolvable to its entry", () => {
    const registry = sampleRegistry();
    expect(registry.schemaVersion).toBe(1);
    expect(registry.generation).toMatch(/^commands-v1:[0-9a-f]{16}$/);
    expect(registry.entry("mode.select")?.title).toBe("Select execution mode");
    expect(registry.entry("missing.entry")).toBeUndefined();
    expect(Object.isFrozen(registry)).toBe(true);
    expect(Object.isFrozen(registry.entries)).toBe(true);
    expect(registry.forms.find((form) => form.form === "/plan")).toMatchObject({
      fixedArgument: "plan",
      canonical: false,
      entry: { id: "mode.select" },
    });
  });

  test("orders forms so a longer form wins over its prefix", () => {
    const order = sampleRegistry().forms.map((form) => form.form);
    expect(order.indexOf("/model routes")).toBeLessThan(order.indexOf("/model"));
    expect(order.indexOf("/workspace load")).toBeLessThan(order.indexOf("/route"));
  });

  test("derives the generation from the contract alone", () => {
    const first = createCommandRegistry(SAMPLE_SPECS);
    const withHostField = createCommandRegistry(
      SAMPLE_SPECS.map((spec) => ({ ...spec, availability: () => "host-only" })),
    );
    const changed = createCommandRegistry(
      SAMPLE_SPECS.map((spec) =>
        spec.id === "app.help" ? { ...spec, description: "Different words." } : spec,
      ),
    );
    if (!first.ok || !withHostField.ok || !changed.ok) throw new Error("expected valid registries");
    expect(withHostField.value.generation).toBe(first.value.generation);
    expect(changed.value.generation).not.toBe(first.value.generation);
  });

  test("keeps host fields on the returned entries", () => {
    const built = createCommandRegistry([{ ...commandSpec({ id: "app.help" }), binding: "?" }]);
    if (!built.ok) throw new Error("expected a valid registry");
    expect(built.value.entry("app.help")?.binding).toBe("?");
  });
});

describe("command registry validation", () => {
  test("rejects malformed and duplicate identities", () => {
    expect(codes([commandSpec({ id: "Help" })])).toEqual(["id-invalid"]);
    expect(codes([commandSpec({ id: "app.help" }), commandSpec({ id: "app.help" })])).toEqual([
      "id-duplicate",
    ]);
  });

  test("names both owners of a colliding slash form", () => {
    const built = createCommandRegistry([
      commandSpec({ id: "app.help", slash: [{ form: "/help" }] }),
      commandSpec({ id: "app.manual", slash: [{ form: "/help" }] }),
    ]);
    expect(built.ok).toBe(false);
    if (built.ok) return;
    expect(built.error).toEqual([
      {
        code: "slash-collision",
        commandId: "app.manual",
        message: "/help is claimed by both app.help and app.manual",
      },
    ]);
    expect(describeCommandRegistryDiagnostics(built.error)).toBe(
      "app.manual: /help is claimed by both app.help and app.manual (slash-collision)",
    );
  });

  test("rejects malformed forms and a form listed twice by one entry", () => {
    expect(codes([commandSpec({ id: "app.help", slash: [{ form: "help" }] })])).toEqual([
      "slash-form-invalid",
    ]);
    expect(codes([commandSpec({ id: "app.help", slash: [{ form: "/Help" }] })])).toEqual([
      "slash-form-invalid",
    ]);
    expect(codes([commandSpec({ id: "app.help", slash: [{ form: "/model  routes" }] })])).toEqual([
      "slash-form-invalid",
    ]);
    expect(
      codes([commandSpec({ id: "app.help", slash: [{ form: "/help" }, { form: "/help" }] })]),
    ).toEqual(["slash-collision"]);
  });

  test("rejects a fixed argument the entry cannot accept", () => {
    expect(
      codes([commandSpec({ id: "app.help", slash: [{ form: "/help", fixedArgument: "all" }] })]),
    ).toEqual(["fixed-argument-invalid"]);
    const profile = SAMPLE_SPECS.find((spec) => spec.id === "profile.inspect");
    if (profile === undefined) throw new Error("fixture missing");
    expect(codes([{ ...profile, slash: [{ form: "/use", fixedArgument: "use" }] }])).toEqual([
      "fixed-argument-invalid",
    ]);
    expect(codes([{ ...profile, slash: [{ form: "/drop", fixedArgument: "drop" }] }])).toEqual([
      "fixed-argument-invalid",
    ]);
  });

  test("rejects invalid argument schemas", () => {
    expect(
      codes([
        commandSpec({ id: "app.help", argument: { kind: "options", hint: "x", options: [] } }),
      ]),
    ).toEqual(["argument-invalid"]);
    expect(
      codes([
        commandSpec({
          id: "app.help",
          argument: {
            kind: "options",
            hint: "x",
            options: [
              { value: "on", operand: null },
              { value: "on", operand: null },
            ],
          },
        }),
      ]),
    ).toEqual(["argument-invalid"]);
    expect(
      codes([
        commandSpec({
          id: "app.help",
          argument: { kind: "text", hint: "x", maxBytes: 0, required: false },
        }),
      ]),
    ).toEqual(["argument-invalid"]);
    expect(
      codes([
        commandSpec({
          id: "app.help",
          argument: {
            kind: "text",
            hint: "x",
            maxBytes: COMMAND_REGISTRY_LIMITS.textArgumentBytes + 1,
            required: false,
          },
        }),
      ]),
    ).toEqual(["argument-invalid"]);
  });

  test("refuses an entry whose timing is not declared", () => {
    expect(
      codes([commandSpec({ id: "app.help", timing: "later" as unknown as "immediate" })]),
    ).toEqual(["timing-invalid"]);
    expect(
      codes([
        commandSpec({
          id: "app.help",
          argument: {
            kind: "options",
            hint: "x",
            options: [{ value: "on", operand: null, timing: "soon" as unknown as "queued" }],
          },
        }),
      ]),
    ).toEqual(["timing-invalid"]);
  });

  test("rejects empty callers, unknown classes and an ownerless planned entry", () => {
    expect(codes([commandSpec({ id: "app.help", callers: [] })])).toEqual([
      "classification-invalid",
    ]);
    expect(
      codes([commandSpec({ id: "app.help", effect: "magic" as unknown as "mutation" })]),
    ).toEqual(["classification-invalid"]);
    expect(
      codes([
        commandSpec({ id: "app.help", status: { kind: "planned", owner: "792", reason: "x" } }),
      ]),
    ).toEqual(["status-invalid"]);
  });

  test("bounds text and the number of entries", () => {
    expect(codes([commandSpec({ id: "app.help", title: "" })])).toEqual(["text-invalid"]);
    expect(codes([commandSpec({ id: "app.help", description: "line\nbreak" })])).toEqual([
      "text-invalid",
    ]);
    const many = Array.from({ length: COMMAND_REGISTRY_LIMITS.entries + 1 }, (_, index) =>
      commandSpec({ id: `bulk.entry${index}` }),
    );
    expect(codes(many)).toEqual(["too-many-entries"]);
  });
});
