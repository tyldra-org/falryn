// biome-ignore-all lint/suspicious/noTemplateCurlyInString: literal template placeholders are the subject under test.
import { describe, expect, test } from "bun:test";
import {
  expandPromptTemplate,
  PROMPT_TEMPLATE_LIMITS,
  parsePromptInvocation,
  parsePromptTemplateSource,
  renderPromptTemplate,
  splitPromptArguments,
} from "./prompt-templates.ts";

const bytes = (text: string) => new TextEncoder().encode(text);
const source = (text: string) => parsePromptTemplateSource(bytes(text));
const render = (body: string, values: readonly string[]) => {
  const rendered = renderPromptTemplate(body, values);
  return rendered.ok ? rendered.value.text : rendered.error.code;
};
const split = (text: string) => {
  const values = splitPromptArguments(text);
  return values.ok ? values.value : values.error.code;
};
const code = (result: { ok: boolean; error?: { code: string } }) =>
  result.ok ? "ok" : result.error?.code;

describe("prompt template arguments", () => {
  test("split on Unicode whitespace outside quotes with literal backslashes", () => {
    expect(split("a  b\tc\u3000d\u00a0e")).toEqual(["a", "b", "c", "d", "e"]);
    expect(split(String.raw`"one two" 'three four' x\y`)).toEqual([
      "one two",
      "three four",
      "x\\y",
    ]);
    expect(split(`a"b c"'d'e`)).toEqual(["ab cde"]);
    expect(split(`"" '' x ""`)).toEqual(["x"]);
    expect(split(`"it's"`)).toEqual(["it's"]);
    expect(split("")).toEqual([]);
    expect(split(`"open`)).toBe("unterminated-quote");
    expect(split("'open")).toBe("unterminated-quote");
  });

  test("enforce argument count, per-argument and total ceilings at the byte boundary", () => {
    expect(split(Array(64).fill("x").join(" "))).toHaveLength(64);
    expect(split(Array(65).fill("x").join(" "))).toBe("argument-count");
    // 1,365 three-byte scalars plus one byte is exactly 4 KiB.
    const exact = "\u20ac".repeat(1_365) + "a";
    expect(split(exact)).toEqual([exact]);
    expect(split(exact + "a")).toBe("argument-limit");
    const total = "a".repeat(PROMPT_TEMPLATE_LIMITS.argumentTextBytes);
    expect(split(total)).toBe("argument-limit");
    expect(split(total + " ")).toBe("argument-text-limit");
  });
});

describe("prompt template rendering", () => {
  const args = ["alpha", "beta", "gamma"];

  test("substitute positions and all-argument forms without identifier boundaries", () => {
    expect(render("$1 and $2", args)).toBe("alpha and beta");
    expect(render("$1x", args)).toBe("alphax");
    expect(render("$ARGUMENTSX", args)).toBe("alpha beta gammaX");
    expect(render("[$@]", args)).toBe("[alpha beta gamma]");
    expect(render("$$1", args)).toBe("$alpha");
    expect(render("$ cost $x $", args)).toBe("$ cost $x $");
    expect(render("$9", args)).toBe("");
    expect(render("$0001", args)).toBe("alpha");
    expect(
      render(
        "$12",
        Array.from({ length: 12 }, (_, i) => "v" + (i + 1)),
      ),
    ).toBe("v12");
  });

  test("apply defaults only when the selected value is missing or empty", () => {
    expect(render("${1:-none}", args)).toBe("alpha");
    expect(render("${4:-none}", args)).toBe("none");
    expect(render("${4:-}", args)).toBe("");
    expect(render("${@:-all}", [])).toBe("all");
    expect(render("${ARGUMENTS:-all}", [])).toBe("all");
    expect(render("${ARGUMENTS:-all}", args)).toBe("alpha beta gamma");
    expect(render("${1:-a $2 b}", [])).toBe("a $2 b");
  });

  test("slice with bounded start and length", () => {
    expect(render("${@:2}", args)).toBe("beta gamma");
    expect(render("${@:2:1}", args)).toBe("beta");
    expect(render("${@:2:0}", args)).toBe("");
    expect(render("${@:3:99}", args)).toBe("gamma");
    expect(render("${@:4}", args)).toBe("");
    expect(render("${@:2147483647:2147483647}", args)).toBe("");
  });

  test("insert argument text verbatim and never reparse it", () => {
    expect(render("run $1", ["$2 ${@} `rm -rf`"])).toBe("run $2 ${@} `rm -rf`");
    expect(render("  keep\n\n  $1  \n", ["x"])).toBe("  keep\n\n  x  \n");
  });

  test("reject zero, overflow and malformed braced forms", () => {
    expect(render("$0", args)).toBe("zero-position");
    expect(render("${0:-x}", args)).toBe("zero-position");
    expect(render("${@:0}", args)).toBe("zero-position");
    expect(render("$2147483647", args)).toBe("");
    expect(render("$2147483648", args)).toBe("numeric-overflow");
    expect(render("${@:1:2147483648}", args)).toBe("numeric-overflow");
    expect(render("$" + "9".repeat(40), args)).toBe("numeric-overflow");
    for (const body of ["${1}", "${HOME}", "${@:-a", "${@:1:}", "${-1:-x}", "${}"])
      expect(render(body, args)).toBe("malformed-placeholder");
  });

  test("bound substitutions and rendered bytes exactly at the limit", () => {
    expect(render("$1".repeat(1_024), [""])).toBe("");
    expect(render("$1".repeat(1_025), [""])).toBe("substitution-limit");
    const exact = "\u20ac".repeat(43_690) + "ab";
    expect(new TextEncoder().encode(exact).byteLength).toBe(PROMPT_TEMPLATE_LIMITS.renderedBytes);
    expect(render(exact, [])).toBe(exact);
    expect(render(exact + "$1", ["c"])).toBe("rendered-limit");
    expect(render("$1$1$1", ["a".repeat(50_000)])).toBe("rendered-limit");
  });

  test("expand parses arguments then renders once", () => {
    const parsed = source("---\ndescription: Review\n---\nReview $1 with ${@:2}.");
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(expandPromptTemplate(parsed.value, `src/app.ts "extra care"`)).toEqual({
      ok: true,
      value: {
        text: "Review src/app.ts with extra care.",
        argumentCount: 2,
        substitutions: 2,
        renderedBytes: 34,
      },
    });
    expect(code(expandPromptTemplate(parsed.value, `"open`))).toBe("unterminated-quote");
  });
});

describe("prompt template source", () => {
  test("strip one BOM, normalize newlines and trim the body after frontmatter", () => {
    const parsed = parsePromptTemplateSource(
      new Uint8Array([
        0xef,
        0xbb,
        0xbf,
        ...bytes(
          "---\r\ndescription: D\r\nargument-hint: <file>\r\n---\r\n\r\n  Body\r\nline  \r\n",
        ),
      ]),
    );
    expect(parsed).toEqual({
      ok: true,
      value: {
        frontmatter: { description: "D", "argument-hint": "<file>" },
        body: "Body\nline",
        description: "D",
        argumentHint: "<file>",
      },
    });
    const second = parsePromptTemplateSource(
      new Uint8Array([0xef, 0xbb, 0xbf, 0xef, 0xbb, 0xbf, 0x61]),
    );
    expect(second.ok && second.value.body).toBe("\ufeffa");
  });

  test("preserve body whitespace without frontmatter and derive descriptions", () => {
    expect(source("\n\n  First line  \nrest\n")).toEqual({
      ok: true,
      value: {
        frontmatter: {},
        body: "\n\n  First line  \nrest\n",
        description: "First line",
        argumentHint: null,
      },
    });
    const long = "\u00e9".repeat(61);
    const derived = source("---\ndescription: ''\nargument-hint: ''\n---\n" + long);
    expect(derived.ok && derived.value).toMatchObject({
      description: "\u00e9".repeat(60) + "...",
      argumentHint: null,
    });
    const exact = source("\u00e9".repeat(60));
    expect(exact.ok && exact.value.description).toBe("\u00e9".repeat(60));
    const empty = source("---\n---\n");
    expect(empty.ok && empty.value).toMatchObject({ body: "", description: "", frontmatter: {} });
    const dashes = source("--- not frontmatter\n$1");
    expect(dashes.ok && dashes.value.body).toBe("--- not frontmatter\n$1");
  });

  test("reject malformed frontmatter", () => {
    for (const text of ["---\ndescription: D\n", "---", "---\ndescription: D\n----\nbody"])
      expect(code(source(text))).toBe("frontmatter-unclosed");
    for (const frontmatter of [
      "a: 1\na: 2",
      "a: &x 1\nb: *x",
      "a: !custom x",
      "<<: {a: 1}",
      "a: .inf",
      "a: .nan",
      "1: x",
      "- a",
      "description: 3",
      "argument-hint: [a]",
      "a: &x [1]",
    ])
      expect(code(source("---\n" + frontmatter + "\n---\nbody"))).toBe("frontmatter-invalid");
    const nested = source("---\nkeep: {a: [1, {b: true}], c: null, d: !!str x}\n---\nbody");
    expect(nested.ok && nested.value.frontmatter).toEqual({
      keep: { a: [1, { b: true }], c: null, d: "x" },
    });
  });

  test("enforce frontmatter, key, depth, metadata, body and source ceilings", () => {
    const deep = (levels: number) => "a: " + "[".repeat(levels - 1) + "1" + "]".repeat(levels - 1);
    expect(code(source("---\n" + deep(8) + "\n---\n"))).toBe("ok");
    expect(code(source("---\n" + deep(9) + "\n---\n"))).toBe("frontmatter-depth");
    const keys = (count: number) =>
      Array.from({ length: count }, (_, i) => "k" + i + ": 1").join("\n");
    expect(code(source("---\n" + keys(64) + "\n---\n"))).toBe("ok");
    expect(code(source("---\n" + keys(65) + "\n---\n"))).toBe("frontmatter-key-count");
    expect(code(source("---\n" + "k".repeat(128) + ": 1\n---\n"))).toBe("ok");
    expect(code(source("---\n" + "k".repeat(129) + ": 1\n---\n"))).toBe("frontmatter-key-limit");
    const filler = (size: number) => "a: '" + "x".repeat(size - 5) + "'";
    expect(code(source("---\n" + filler(8_192) + "\n---\n"))).toBe("ok");
    expect(code(source("---\n" + filler(8_193) + "\n---\n"))).toBe("frontmatter-limit");
    expect(code(source("---\ndescription: '" + "\u20ac".repeat(170) + "ab'\n---\n"))).toBe("ok");
    expect(code(source("---\ndescription: '" + "\u20ac".repeat(170) + "abc'\n---\n"))).toBe(
      "description-limit",
    );
    expect(code(source("---\nargument-hint: '" + "h".repeat(256) + "'\n---\n"))).toBe("ok");
    expect(code(source("---\nargument-hint: '" + "h".repeat(257) + "'\n---\n"))).toBe("hint-limit");
    expect(code(source("b".repeat(65_536)))).toBe("ok");
    expect(code(source("b".repeat(65_537)))).toBe("body-limit");
    expect(code(parsePromptTemplateSource(new Uint8Array(73_729)))).toBe("source-limit");
    expect(code(parsePromptTemplateSource(new Uint8Array([0x61, 0xff])))).toBe("invalid-utf8");
  });
});

describe("prompt template invocation", () => {
  test("name short or package-qualified aliases and keep raw argument text", () => {
    expect(parsePromptInvocation("/review src/a.ts  now")).toEqual({
      name: "review",
      argumentText: "src/a.ts  now",
    });
    expect(parsePromptInvocation("  /r\u00e9sum\u00e9")).toEqual({
      name: "r\u00e9sum\u00e9",
      argumentText: "",
    });
    expect(parsePromptInvocation("/@acme/kit:review x")).toEqual({
      name: "@acme/kit:review",
      argumentText: "x",
    });
    for (const text of [
      "review",
      "/",
      "/usr/bin tool",
      "/:review",
      "/pkg:",
      "/-x",
      "/a b".slice(0, 1),
    ])
      expect(parsePromptInvocation(text)).toBeNull();
  });
});
