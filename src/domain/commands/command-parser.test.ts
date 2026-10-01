import { describe, expect, test } from "bun:test";
import { sampleRegistry } from "./command.fixtures.ts";
import { parseSlashCommand, resolveCommandArgument } from "./command-parser.ts";

const registry = sampleRegistry();
const parse = (text: string) => parseSlashCommand(registry, text);

function invocation(text: string) {
  const parsed = parse(text);
  if (parsed.kind !== "command") throw new Error(`expected a command for ${text}: ${parsed.kind}`);
  return {
    id: parsed.entry.id,
    form: parsed.form,
    argument: parsed.argument,
    timing: parsed.timing,
  };
}

function refusal(text: string) {
  const parsed = parse(text);
  if (parsed.kind !== "invalid") throw new Error(`expected a refusal for ${text}: ${parsed.kind}`);
  return { code: parsed.code, message: parsed.message };
}

describe("slash resolution", () => {
  test("leaves text that is not a slash command to its caller", () => {
    expect(parse("explain /mode")).toEqual({ kind: "not-slash" });
    expect(parse("")).toEqual({ kind: "not-slash" });
  });

  test("reports unclaimed slash words as unknown for the caller's next owner", () => {
    expect(parse("/skill:review")).toEqual({ kind: "unknown", name: "/skill:review" });
    expect(parse("/usr/bin/env")).toEqual({ kind: "unknown", name: "/usr/bin/env" });
    expect(parse("/")).toEqual({ kind: "unknown", name: "/" });
    expect(parse("/helpme")).toEqual({ kind: "unknown", name: "/helpme" });
  });

  test("matches forms case-insensitively across Unicode whitespace", () => {
    expect(invocation("  /HELP  ")).toMatchObject({ id: "app.help", form: "/help" });
    expect(invocation("/MODEL Routes")).toMatchObject({ id: "model.routes" });
    expect(invocation("/mode plan")).toMatchObject({ id: "mode.select", argument: "plan" });
  });

  test("prefers the longest registered form", () => {
    expect(invocation("/model routes")).toMatchObject({
      id: "model.routes",
      form: "/model routes",
    });
    expect(invocation("/model roles")).toMatchObject({ id: "model.settings" });
    expect(invocation("/model")).toMatchObject({ id: "model.settings", form: "/model" });
  });

  test("names the subcommands of an incomplete family", () => {
    expect(refusal("/workspace")).toEqual({
      code: "form-incomplete",
      message: "/workspace expects load or show.",
    });
    expect(refusal("/workspace drop x").code).toBe("form-incomplete");
  });

  test("refuses an argument to an entry that takes none, listing its siblings", () => {
    expect(refusal("/help me")).toEqual({
      code: "argument-unexpected",
      message: "/help takes no argument.",
    });
    expect(refusal("/model fast")).toEqual({
      code: "argument-unexpected",
      message: "/model takes no argument. Use /model, /model roles or /model routes.",
    });
  });
});

describe("arguments", () => {
  test("a direct alias supplies its fixed argument and accepts nothing else", () => {
    expect(invocation("/plan")).toEqual({
      id: "mode.select",
      form: "/plan",
      argument: "plan",
      timing: "safe-point",
    });
    expect(refusal("/plan now")).toEqual({
      code: "argument-unexpected",
      message: "/plan takes no argument.",
    });
  });

  test("options accept declared words only, in any case", () => {
    expect(invocation("/mode")).toMatchObject({ argument: null, timing: "immediate" });
    expect(invocation("/mode ASK")).toMatchObject({ argument: "ask", timing: "safe-point" });
    expect(refusal("/mode fast")).toEqual({
      code: "argument-invalid",
      message: "Unsupported value “fast” for /mode. Use /mode ask|plan.",
    });
  });

  test("option operands are required, optional or refused as declared", () => {
    expect(invocation("/profile list")).toMatchObject({ argument: "list", timing: "immediate" });
    expect(refusal("/profile list everything")).toEqual({
      code: "argument-unexpected",
      message: "/profile list takes no value.",
    });
    expect(refusal("/profile use")).toEqual({
      code: "argument-missing",
      message: "/profile use needs profile id.",
    });
    expect(invocation("/profile use work")).toMatchObject({ argument: "use work" });
    expect(invocation('/profile use "work"')).toMatchObject({ argument: "use work" });
    expect(invocation("/profile preview")).toMatchObject({ argument: "preview" });
    expect(refusal("/profile use two words").code).toBe("argument-invalid");
    expect(refusal('/profile use "unterminated').code).toBe("quote-unterminated");
  });

  test("an option can carry its own timing", () => {
    expect(invocation("/profile use work").timing).toBe("immediate");
    expect(invocation("/profile apply candidate-1").timing).toBe("safe-point");
  });

  test("text keeps the rest of the line and unquotes a whole quoted value", () => {
    expect(invocation("/workspace load  my layout ")).toMatchObject({
      argument: "my layout",
      timing: "safe-point",
    });
    expect(invocation("/workspace load")).toMatchObject({ argument: null, timing: "immediate" });
    expect(invocation('/load-workspace "say \\"hi\\" \\\\ there"')).toMatchObject({
      argument: 'say "hi" \\ there',
    });
    expect(invocation("/workspace load 'single'")).toMatchObject({ argument: "single" });
  });

  test("text quoting must cover the whole value and close", () => {
    expect(refusal('/workspace load "open')).toEqual({
      code: "quote-unterminated",
      message: "/workspace load: a quote is not closed.",
    });
    expect(refusal('/workspace load "a" b')).toEqual({
      code: "argument-invalid",
      message: "/workspace load: quote the whole value or none of it.",
    });
  });

  test("`--` takes the rest literally, quotes included", () => {
    expect(invocation('/workspace load -- "quoted"')).toMatchObject({ argument: '"quoted"' });
    expect(invocation("/workspace load --")).toMatchObject({ argument: null });
  });

  test("text is bounded in UTF-8 bytes and may be required", () => {
    expect(refusal(`/workspace load ${"é".repeat(33)}`)).toEqual({
      code: "argument-too-large",
      message: "/workspace load accepts at most 64 bytes.",
    });
    expect(refusal("/advisor")).toEqual({
      code: "argument-missing",
      message: "/advisor needs focus.",
    });
    expect(invocation("/advisor the failing test")).toMatchObject({
      id: "advisor.consult",
      argument: "the failing test",
    });
  });

  test("an argument from the palette or a model resolves exactly as slash text does", () => {
    const mode = registry.entry("mode.select");
    if (mode === undefined) throw new Error("fixture missing");
    expect(resolveCommandArgument(mode, "PLAN")).toMatchObject({
      kind: "command",
      argument: "plan",
      timing: "safe-point",
    });
    expect(resolveCommandArgument(mode, null)).toMatchObject({ kind: "command", argument: null });
    expect(resolveCommandArgument(mode, "fast")).toMatchObject({
      kind: "invalid",
      code: "argument-invalid",
    });
  });
});
