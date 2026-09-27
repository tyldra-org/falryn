import { describe, expect, test } from "bun:test";
import { contributionDeclarationSchema } from "./manifest.ts";
import {
  checkPromptVariableValue,
  describePromptVariableType,
  PROMPT_VARIABLE_LIMITS,
  type PromptVariable,
  parsePromptVariableText,
  promptVariablesSchema,
  renderPromptVariableValue,
} from "./prompt-variables.ts";

const declare = (entries: readonly unknown[], extra: Record<string, unknown> = {}) =>
  promptVariablesSchema.safeParse({ version: 1, entries, ...extra });
const issues = (entries: readonly unknown[]) => {
  const parsed = declare(entries);
  return parsed.success ? [] : parsed.error.issues.map((issue) => issue.message);
};
const variable = (type: unknown, rest: Record<string, unknown> = {}): PromptVariable => {
  const parsed = declare([{ name: "v", type, ...rest }]);
  if (!parsed.success) throw new Error(parsed.error.message);
  const [first] = parsed.data.entries;
  if (first === undefined) throw new Error("no variable");
  return first;
};
const read = (type: unknown, text: string) => {
  const parsed = parsePromptVariableText(variable(type), text);
  return parsed.ok ? renderPromptVariableValue(parsed.value) : parsed.error.code;
};

describe("prompt variable declarations", () => {
  test("apply defaults and accept every version-1 type", () => {
    const parsed = declare([
      { name: "file", type: { kind: "string", maxLength: 80 }, required: true },
      {
        name: "depth",
        type: { kind: "number", integer: true, minimum: 1, maximum: 5 },
        default: 2,
      },
      { name: "strict", type: { kind: "boolean" }, default: false },
      { name: "tone", type: { kind: "enum", values: ["calm", "blunt"] } },
      { name: "tags", type: { kind: "array", items: { kind: "string" }, maxItems: 3 } },
      {
        name: "scope",
        type: {
          kind: "object",
          properties: [
            {
              name: "paths",
              type: { kind: "array", items: { kind: "string" }, maxItems: 4 },
              required: true,
            },
          ],
        },
      },
      { name: "token", type: { kind: "string" }, sensitive: true, description: "API token" },
    ]);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.additional).toBe(false);
    expect(parsed.data.entries[0]).toEqual({
      name: "file",
      type: { kind: "string", maxLength: 80 },
      required: true,
      sensitive: false,
      description: "",
    });
    expect(parsed.data.entries[5]?.type).toMatchObject({ kind: "object", additional: false });
  });

  test("reject contradictory, invalid or unsupported declarations", () => {
    const string = { kind: "string" };
    expect(
      issues([
        { name: "a", type: string },
        { name: "a", type: string },
      ]),
    ).toContain("duplicate-prompt-variable");
    expect(issues([{ name: "a", type: string, required: true, default: "x" }])).toContain(
      "required-prompt-variable-default",
    );
    expect(issues([{ name: "a", type: string, sensitive: true, default: "x" }])).toContain(
      "sensitive-prompt-variable-default",
    );
    expect(issues([{ name: "a", type: { kind: "number" }, default: "2" }])).toContain(
      "invalid-prompt-variable-default",
    );
    expect(issues([{ name: "a", type: { kind: "number", minimum: 5, maximum: 1 } }])).toContain(
      "prompt-variable-bounds",
    );
    expect(issues([{ name: "a", type: { kind: "enum", values: ["x", "x"] } }])).toContain(
      "duplicate-enum-value",
    );
    const nested = (depth: number): unknown =>
      depth === 1 ? string : { kind: "array", items: nested(depth - 1), maxItems: 2 };
    expect(issues([{ name: "a", type: nested(PROMPT_VARIABLE_LIMITS.depth) }])).toEqual([]);
    expect(issues([{ name: "a", type: nested(PROMPT_VARIABLE_LIMITS.depth + 1) }])).toContain(
      "prompt-variable-depth",
    );
    for (const name of ["ARGUMENTS", "1st", "has-dash", "x".repeat(65), ""])
      expect(declare([{ name, type: string }]).success).toBe(false);
    expect(declare([{ name: "a", type: { kind: "date" } }]).success).toBe(false);
    expect(declare([{ name: "a", type: string, format: "x" }]).success).toBe(false);
    expect(
      promptVariablesSchema.safeParse({ version: 2, entries: [{ name: "a", type: string }] })
        .success,
    ).toBe(false);
    expect(declare([]).success).toBe(false);
    expect(
      declare(
        Array.from({ length: PROMPT_VARIABLE_LIMITS.variables + 1 }, (_, i) => ({
          name: "v" + i,
          type: string,
        })),
      ).success,
    ).toBe(false);
  });

  test("only prompt manifest entries may declare variables", () => {
    const entry = (kind: string) => ({
      kind,
      namespace: "kit",
      id: "x",
      path: "x.md",
      description: "",
      authority: {
        effects: [],
        permissions: [],
        roots: [],
        destinations: [],
        secretReferences: [],
        localData: [],
      },
      variables: { version: 1, entries: [{ name: "a", type: { kind: "string" } }] },
    });
    expect(contributionDeclarationSchema.safeParse(entry("prompt")).success).toBe(true);
    const skill = contributionDeclarationSchema.safeParse(entry("skill"));
    expect(skill.success).toBe(false);
    expect(skill.error?.issues.map((issue) => issue.message)).toContain("cross-kind-variables");
  });
});

describe("prompt variable values", () => {
  test("read each type from plain text or JSON and render deterministically", () => {
    expect(read({ kind: "string" }, "  src/ä.ts  ")).toBe("  src/ä.ts  ");
    expect(read({ kind: "number" }, "-1.5e2")).toBe("-150");
    expect(read({ kind: "number", integer: true }, "3")).toBe("3");
    expect(read({ kind: "boolean" }, "true")).toBe("true");
    expect(read({ kind: "enum", values: ["calm", "blunt"] }, "blunt")).toBe("blunt");
    expect(read({ kind: "array", items: { kind: "number" }, maxItems: 3 }, "[3, 1, 2]")).toBe(
      "[3,1,2]",
    );
    const object = {
      kind: "object",
      properties: [
        { name: "b", type: { kind: "boolean" }, required: true },
        { name: "a", type: { kind: "array", items: { kind: "string" }, maxItems: 2 } },
      ],
    };
    expect(read(object, '{"b": true, "a": ["é", "ü"]}')).toBe('{"a":["é","ü"],"b":true}');
    expect(read(object, '{"a": [], "b": false}')).toBe(read(object, '{"b": false, "a": []}'));
  });

  test("give a typed reason for malformed, wrong-type, out-of-bounds, extra and oversized values", () => {
    expect(read({ kind: "number" }, "0x10")).toBe("variable-malformed");
    expect(read({ kind: "number" }, "Infinity")).toBe("variable-malformed");
    expect(read({ kind: "number" }, "+1")).toBe("variable-malformed");
    expect(read({ kind: "boolean" }, "yes")).toBe("variable-malformed");
    expect(read({ kind: "array", items: { kind: "string" }, maxItems: 2 }, "[1")).toBe(
      "variable-malformed",
    );
    expect(read({ kind: "array", items: { kind: "string" }, maxItems: 2 }, '{"a":1}')).toBe(
      "variable-type",
    );
    expect(read({ kind: "array", items: { kind: "string" }, maxItems: 2 }, '["a",1]')).toBe(
      "variable-type",
    );
    expect(read({ kind: "array", items: { kind: "string" }, maxItems: 2 }, '["a","b","c"]')).toBe(
      "variable-constraint",
    );
    expect(read({ kind: "number", integer: true }, "1.5")).toBe("variable-constraint");
    expect(read({ kind: "number", maximum: 5 }, "6")).toBe("variable-constraint");
    expect(read({ kind: "enum", values: ["calm"] }, "Calm")).toBe("variable-constraint");
    // Length counts Unicode scalar values, not UTF-16 units or bytes.
    expect(read({ kind: "string", maxLength: 2 }, "😀😀")).toBe("😀😀");
    expect(read({ kind: "string", maxLength: 2 }, "😀😀😀")).toBe("variable-constraint");
    expect(read({ kind: "string" }, "x".repeat(PROMPT_VARIABLE_LIMITS.valueBytes))).toHaveLength(
      PROMPT_VARIABLE_LIMITS.valueBytes,
    );
    expect(read({ kind: "string" }, "x".repeat(PROMPT_VARIABLE_LIMITS.valueBytes + 1))).toBe(
      "variable-limit",
    );
    const strict = {
      kind: "object",
      properties: [{ name: "a", type: { kind: "number" }, required: true }],
    };
    expect(read(strict, '{"a":1,"b":2}')).toBe("variable-unknown");
    expect(read(strict, "{}")).toBe("variable-missing");
    expect(read({ ...strict, additional: true }, '{"a":1,"b":{"c":[true]}}')).toBe(
      '{"a":1,"b":{"c":[true]}}',
    );
    const deep = JSON.stringify({ a: 1, b: JSON.parse("[".repeat(9) + "]".repeat(9)) });
    expect(read({ ...strict, additional: true }, deep)).toBe("variable-limit");
  });

  test("name the nested path in a failure and never the value", () => {
    const type = {
      kind: "object" as const,
      additional: false,
      properties: [
        {
          name: "items",
          required: true,
          type: { kind: "array" as const, maxItems: 2, items: { kind: "number" as const } },
        },
      ],
    };
    const error = checkPromptVariableValue(type, { items: [1, "hunter2"] }, "scope");
    expect(error).toEqual({
      code: "variable-type",
      message: "variable scope.items[1] has the wrong type",
      variable: "scope.items[1]",
    });
    const parsed = parsePromptVariableText(variable({ kind: "number" }), "hunter2");
    expect(parsed.ok ? "" : JSON.stringify(parsed.error)).not.toContain("hunter2");
  });

  test("describe each type in plain words", () => {
    expect(
      describePromptVariableType({ kind: "number", integer: true, minimum: 1, maximum: 5 }),
    ).toBe("a whole number from 1 to 5");
    expect(describePromptVariableType({ kind: "enum", values: ["a", "b"] })).toBe("one of a, b");
    expect(
      describePromptVariableType({ kind: "array", items: { kind: "string" }, maxItems: 3 }),
    ).toBe("a JSON array of up to 3 items");
  });
});
