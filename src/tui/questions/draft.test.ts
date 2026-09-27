import { expect, test } from "bun:test";
import type { PresentedQuestion } from "../../application/orchestration/question-presenter.ts";
import {
  createQuestionDraft,
  type DraftAction,
  type QuestionDraft,
  stepQuestionDraft,
} from "./draft.ts";

const question: PresentedQuestion = {
  key: "q/1",
  source: "Workflow question",
  sensitivity: "normal",
  expiresAt: 60_000,
  items: [
    {
      id: "size",
      kind: "single-select",
      prompt: "Pick a size",
      options: [
        { id: "s", label: "Small" },
        { id: "l", label: "Large" },
      ],
    },
    {
      id: "tags",
      kind: "multi-select",
      prompt: "Pick tags",
      options: [
        { id: "a", label: "A" },
        { id: "b", label: "B" },
        { id: "c", label: "C" },
      ],
      minimum: 1,
      maximum: 2,
    },
    { id: "note", kind: "free-text", prompt: "Add a note", maxBytes: 4 },
    { id: "ok", kind: "review", prompt: "Review the plan" },
  ],
};
function run(draft: QuestionDraft, ...actions: DraftAction[]) {
  let current = draft;
  for (const action of actions) {
    const step = stepQuestionDraft(question, current, action);
    if (step.kind === "submit") return step;
    current = step.draft;
  }
  return { kind: "editing" as const, draft: current };
}

test("each item is answered in order and the last commit submits a valid answer", () => {
  const step = run(
    createQuestionDraft(question),
    { kind: "move", delta: 1 },
    { kind: "commit" },
    { kind: "toggle" },
    { kind: "move", delta: -1 },
    { kind: "toggle" },
    { kind: "commit" },
    { kind: "insert", text: "hé" },
    { kind: "commit" },
    { kind: "commit" },
  );
  expect(step.kind).toBe("submit");
  if (step.kind !== "submit") return;
  expect(step.answer).toEqual([
    { itemId: "size", kind: "selection", optionIds: ["l"] },
    { itemId: "tags", kind: "selection", optionIds: ["a", "c"] },
    { itemId: "note", kind: "text", text: "hé" },
    { itemId: "ok", kind: "review", acknowledged: true },
  ]);
});

test("selection bounds and text limits refuse the commit with a reason", () => {
  const atTags = run(createQuestionDraft(question), { kind: "commit" }).draft;
  expect(atTags.index).toBe(1);
  const empty = run(atTags, { kind: "commit" }).draft;
  expect(empty).toMatchObject({ index: 1, problem: "Choose at least 1." });
  const three = run(
    empty,
    { kind: "toggle" },
    { kind: "move", delta: 1 },
    { kind: "toggle" },
    { kind: "move", delta: 1 },
    { kind: "toggle" },
    { kind: "commit" },
  ).draft;
  expect(three).toMatchObject({ index: 1, problem: "Choose at most 2." });
  // Toggling again removes a choice and clears the problem.
  const two = run(three, { kind: "toggle" }).draft;
  expect(two.problem).toBeNull();
  const atNote = run(two, { kind: "commit" }).draft;
  expect(atNote.index).toBe(2);
  // Input that would exceed the byte limit is refused whole, not truncated.
  const full = run(atNote, { kind: "insert", text: "abcd" }, { kind: "insert", text: "e" }).draft;
  expect(full.items[2]).toEqual({ kind: "text", text: "abcd" });
  expect(full.problem).toBe("The answer is limited to 4 bytes.");
  const deleted = run(full, { kind: "delete" }).draft;
  expect(deleted.items[2]).toEqual({ kind: "text", text: "abc" });
});

test("back returns to the previous item and keeps what was chosen", () => {
  const second = run(
    createQuestionDraft(question),
    { kind: "move", delta: 1 },
    { kind: "commit" },
  ).draft;
  const back = run(second, { kind: "back" }).draft;
  expect(back.index).toBe(0);
  expect(back.items[0]).toEqual({ kind: "choice", cursor: 1, chosen: ["l"] });
  expect(run(back, { kind: "back" }).draft.index).toBe(0);
  // Moves wrap within the options.
  expect(run(back, { kind: "move", delta: 1 }).draft.items[0]).toMatchObject({ cursor: 0 });
});
