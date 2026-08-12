import { describe, expect, test } from "bun:test";

import {
  type ComposePromptInput,
  composePromptRequest,
  configurationGeneration,
  DEFAULT_PROMPT_COMPOSITION_BUDGETS,
  estimatePromptTokens,
  isPromptExclusionReason,
  isPromptSectionRole,
  PROMPT_COMPOSITION_SCHEMA_VERSION,
  PROMPT_EXCLUSION_REASONS,
  PROMPT_SECTION_ROLES,
  type PromptSectionInput,
  type PromptToolInput,
  promptSectionRoleLabel,
  sessionId,
  turnId,
  workspaceId,
} from "./index.ts";
import { assertNever } from "./result.ts";

const generation = configurationGeneration.from(0);

function baseInput(
  overrides: Partial<ComposePromptInput> & {
    readonly sections?: readonly PromptSectionInput[];
    readonly tools?: readonly PromptToolInput[];
  } = {},
): ComposePromptInput {
  const sections: readonly PromptSectionInput[] = overrides.sections ?? [
    {
      id: "product",
      role: "product-invariant",
      source: "falryn",
      content: "Stay within the workspace.",
      required: true,
      available: true,
    },
    {
      id: "task-1",
      role: "task",
      source: "user",
      content: "List the open issues.",
      required: true,
      available: true,
    },
  ];
  return {
    turnId: turnId.from("turn-1"),
    sessionId: sessionId.from("session-1"),
    workspaceId: workspaceId.from("workspace-1"),
    configurationGeneration: generation,
    sections,
    tools: overrides.tools ?? [],
    ...(overrides.budgets === undefined ? {} : { budgets: overrides.budgets }),
  };
}

describe("prompt composition", () => {
  test("declares every section role and labels them exhaustively", () => {
    expect([...PROMPT_SECTION_ROLES]).toEqual([
      "product-invariant",
      "user-instruction",
      "project-instruction",
      "skill-workflow",
      "task",
      "conversation",
      "memory",
      "evidence",
      "brief",
    ]);
    for (const role of PROMPT_SECTION_ROLES) {
      expect(isPromptSectionRole(role)).toBe(true);
      expect(promptSectionRoleLabel(role)).toBe(role);
    }
    expect(isPromptSectionRole("tool-definition")).toBe(false);
  });

  test("declares every exclusion reason", () => {
    expect([...PROMPT_EXCLUSION_REASONS]).toEqual([
      "missing",
      "empty",
      "oversized",
      "unavailable",
      "budget-exceeded",
      "duplicate",
    ]);
    for (const reason of PROMPT_EXCLUSION_REASONS) {
      expect(isPromptExclusionReason(reason)).toBe(true);
      switch (reason) {
        case "missing":
        case "empty":
        case "oversized":
        case "unavailable":
        case "budget-exceeded":
        case "duplicate":
          break;
        default:
          assertNever(reason, "unhandled exclusion reason");
      }
    }
  });

  test("orders sections by role precedence then id, tools by name", () => {
    const result = composePromptRequest(
      baseInput({
        sections: [
          {
            id: "task-b",
            role: "task",
            source: "user",
            content: "B",
            required: true,
            available: true,
          },
          {
            id: "evidence-z",
            role: "evidence",
            source: "pack",
            content: "z",
            required: false,
            available: true,
          },
          {
            id: "product",
            role: "product-invariant",
            source: "falryn",
            content: "Stay safe.",
            required: true,
            available: true,
          },
          {
            id: "task-a",
            role: "task",
            source: "user",
            content: "A",
            required: true,
            available: true,
          },
          {
            id: "brief",
            role: "brief",
            source: "policy",
            content: "Be concise.",
            required: false,
            available: true,
          },
        ],
        tools: [
          {
            name: "write_file",
            description: "Write",
            parameters: { type: "object" },
            required: false,
            available: true,
          },
          {
            name: "read_file",
            description: "Read",
            parameters: { type: "object" },
            required: false,
            available: true,
          },
        ],
      }),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error("expected compose success");
    }
    expect(result.value.schemaVersion).toBe(PROMPT_COMPOSITION_SCHEMA_VERSION);
    expect(result.value.sections.map((section) => section.id)).toEqual([
      "product",
      "task-a",
      "task-b",
      "evidence-z",
      "brief",
    ]);
    expect(result.value.sections.map((section) => section.order)).toEqual([0, 1, 2, 3, 4]);
    expect(result.value.tools.map((tool) => tool.name)).toEqual(["read_file", "write_file"]);
  });

  test("is deterministic for the same inputs including canonical form", () => {
    const input = baseInput({
      sections: [
        {
          id: "product",
          role: "product-invariant",
          source: "falryn",
          content: "Stay within the workspace.",
          required: true,
          available: true,
        },
        {
          id: "project",
          role: "project-instruction",
          source: "AGENTS.md",
          content: "Prefer Bun.",
          required: false,
          available: true,
        },
        {
          id: "task-1",
          role: "task",
          source: "user",
          content: "List the open issues.",
          required: true,
          available: true,
        },
      ],
      tools: [
        {
          name: "search",
          description: "Search",
          parameters: { type: "object", properties: { q: { type: "string" } } },
          required: false,
          available: true,
        },
      ],
    });

    const first = composePromptRequest(input);
    const second = composePromptRequest(input);
    expect(first).toEqual(second);
    expect(first.ok).toBe(true);
    if (first.ok) {
      expect(first.value.canonicalForm.length).toBeGreaterThan(0);
      expect(first.value.canonicalForm).toContain('"role":"product-invariant"');
    }
  });

  test("sorts nested tool parameter keys in the canonical form", () => {
    const left = composePromptRequest(
      baseInput({
        tools: [
          {
            name: "tool",
            description: "d",
            parameters: { z: 1, a: { y: 2, b: 3 } },
            required: false,
            available: true,
          },
        ],
      }),
    );
    const right = composePromptRequest(
      baseInput({
        tools: [
          {
            name: "tool",
            description: "d",
            parameters: { a: { b: 3, y: 2 }, z: 1 },
            required: false,
            available: true,
          },
        ],
      }),
    );
    expect(left.ok && right.ok).toBe(true);
    if (left.ok && right.ok) {
      expect(left.value.canonicalForm).toBe(right.value.canonicalForm);
    }
  });

  test("rejects required missing, empty, unavailable, and oversized pieces", () => {
    const missing = composePromptRequest(
      baseInput({
        sections: [
          {
            id: "product",
            role: "product-invariant",
            source: "falryn",
            content: "",
            required: true,
            available: true,
          },
          {
            id: "task-1",
            role: "task",
            source: "user",
            content: "Go",
            required: true,
            available: true,
          },
        ],
      }),
    );
    expect(missing.ok).toBe(false);
    if (!missing.ok) {
      expect(missing.error.code).toBe("required-piece-failed");
      if (missing.error.code === "required-piece-failed") {
        expect(missing.error.exclusions).toEqual([
          {
            id: "product",
            kind: "section",
            role: "product-invariant",
            reason: "missing",
            required: true,
          },
        ]);
      }
    }

    const unavailable = composePromptRequest(
      baseInput({
        sections: [
          {
            id: "product",
            role: "product-invariant",
            source: "falryn",
            content: "Stay safe.",
            required: true,
            available: false,
          },
          {
            id: "task-1",
            role: "task",
            source: "user",
            content: "Go",
            required: true,
            available: true,
          },
        ],
      }),
    );
    expect(unavailable.ok).toBe(false);
    if (!unavailable.ok && unavailable.error.code === "required-piece-failed") {
      expect(unavailable.error.exclusions[0]?.reason).toBe("unavailable");
    }

    const oversized = composePromptRequest(
      baseInput({
        budgets: {
          ...DEFAULT_PROMPT_COMPOSITION_BUDGETS,
          maxSectionTokens: 2,
        },
        sections: [
          {
            id: "product",
            role: "product-invariant",
            source: "falryn",
            content: "Stay within the workspace always.",
            required: true,
            available: true,
            estimatedTokens: 20,
          },
          {
            id: "task-1",
            role: "task",
            source: "user",
            content: "Go",
            required: true,
            available: true,
          },
        ],
      }),
    );
    expect(oversized.ok).toBe(false);
    if (!oversized.ok && oversized.error.code === "required-piece-failed") {
      expect(oversized.error.exclusions[0]?.reason).toBe("oversized");
    }
  });

  test("excludes optional empty, unavailable, and oversized pieces without failing", () => {
    const result = composePromptRequest(
      baseInput({
        budgets: {
          ...DEFAULT_PROMPT_COMPOSITION_BUDGETS,
          maxSectionTokens: 8,
          maxToolDescriptionBytes: 8,
        },
        sections: [
          {
            id: "product",
            role: "product-invariant",
            source: "falryn",
            content: "Stay safe.",
            required: true,
            available: true,
          },
          {
            id: "task-1",
            role: "task",
            source: "user",
            content: "Go",
            required: true,
            available: true,
          },
          {
            id: "empty-mem",
            role: "memory",
            source: "memory",
            content: "",
            required: false,
            available: true,
          },
          {
            id: "gone",
            role: "evidence",
            source: "pack",
            content: "bytes",
            required: false,
            available: false,
          },
          {
            id: "huge",
            role: "evidence",
            source: "pack",
            content: "0123456789abcdef",
            required: false,
            available: true,
            estimatedTokens: 64,
          },
        ],
        tools: [
          {
            name: "loud",
            description: "0123456789abcdef",
            parameters: { type: "object" },
            required: false,
            available: true,
          },
        ],
      }),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error("expected success with exclusions");
    }
    expect(result.value.sections.map((section) => section.id)).toEqual(["product", "task-1"]);
    expect(result.value.tools).toEqual([]);
    expect(result.value.exclusions.map((exclusion) => exclusion.reason).sort()).toEqual([
      "empty",
      "oversized",
      "oversized",
      "unavailable",
    ]);
  });

  test("defers optional evidence under total budget pressure", () => {
    const result = composePromptRequest(
      baseInput({
        budgets: {
          ...DEFAULT_PROMPT_COMPOSITION_BUDGETS,
          maxTotalTokens: 12,
          maxSectionTokens: 12,
        },
        sections: [
          {
            id: "product",
            role: "product-invariant",
            source: "falryn",
            content: "abcd",
            required: true,
            available: true,
            estimatedTokens: 4,
          },
          {
            id: "task-1",
            role: "task",
            source: "user",
            content: "efgh",
            required: true,
            available: true,
            estimatedTokens: 4,
          },
          {
            id: "ev-1",
            role: "evidence",
            source: "pack",
            content: "ijkl",
            required: false,
            available: true,
            estimatedTokens: 8,
          },
        ],
      }),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error("expected budget deferral success");
    }
    expect(result.value.sections.map((section) => section.id)).toEqual(["product", "task-1"]);
    expect(result.value.exclusions).toEqual([
      {
        id: "ev-1",
        kind: "section",
        role: "evidence",
        reason: "budget-exceeded",
        required: false,
      },
    ]);
  });

  test("reports insufficient context when a required product or task is absent", () => {
    const result = composePromptRequest(
      baseInput({
        sections: [
          {
            id: "task-1",
            role: "task",
            source: "user",
            content: "Go",
            required: true,
            available: true,
          },
        ],
      }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("insufficient-context");
    }
  });

  test("rejects duplicate section ids and tool names", () => {
    const sections = composePromptRequest(
      baseInput({
        sections: [
          {
            id: "same",
            role: "product-invariant",
            source: "a",
            content: "a",
            required: true,
            available: true,
          },
          {
            id: "same",
            role: "task",
            source: "b",
            content: "b",
            required: true,
            available: true,
          },
        ],
      }),
    );
    expect(sections.ok).toBe(false);
    if (!sections.ok) {
      expect(sections.error).toEqual({
        code: "invalid-section-id",
        reason: "duplicate",
        id: "same",
      });
    }

    const tools = composePromptRequest(
      baseInput({
        tools: [
          {
            name: "dup",
            description: "a",
            parameters: {},
            required: false,
            available: true,
          },
          {
            name: "dup",
            description: "b",
            parameters: {},
            required: false,
            available: true,
          },
        ],
      }),
    );
    expect(tools.ok).toBe(false);
    if (!tools.ok) {
      expect(tools.error).toEqual({
        code: "invalid-tool-name",
        reason: "duplicate",
        name: "dup",
      });
    }
  });

  test("estimates tokens deterministically", () => {
    expect(estimatePromptTokens("")).toBe(0);
    expect(estimatePromptTokens("abcd")).toBe(1);
    expect(estimatePromptTokens("abcdefgh")).toBe(2);
  });
});
