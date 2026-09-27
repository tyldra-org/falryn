/**
 * The answer being composed for one presented question.
 *
 * Pure and renderer-free: the sheet maps keys to actions, this module decides what
 * they mean, and the presenter settles the finished answer. Validation mirrors the
 * question contract so an invalid answer is refused here with a reason instead of
 * reaching the service.
 */
import type { PresentedQuestion } from "../../application/orchestration/question-presenter.ts";
import type { QuestionAnswer } from "../../domain/orchestration/question.ts";

type Item = PresentedQuestion["items"][number];
export type ItemDraft =
  | { readonly kind: "choice"; readonly cursor: number; readonly chosen: readonly string[] }
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "review"; readonly acknowledged: boolean };
export type QuestionDraft = {
  readonly key: string;
  /** The item being answered. */
  readonly index: number;
  readonly items: readonly ItemDraft[];
  /** Why the last commit was refused; cleared by the next edit. */
  readonly problem: string | null;
};
export type DraftAction =
  | { readonly kind: "move"; readonly delta: 1 | -1 }
  | { readonly kind: "toggle" }
  | { readonly kind: "insert"; readonly text: string }
  | { readonly kind: "delete" }
  | { readonly kind: "back" }
  | { readonly kind: "commit" };
export type DraftStep =
  | { readonly kind: "editing"; readonly draft: QuestionDraft }
  | { readonly kind: "submit"; readonly draft: QuestionDraft; readonly answer: QuestionAnswer };

const encoder = new TextEncoder();
export const textBytes = (text: string) => encoder.encode(text).length;

export function createQuestionDraft(question: PresentedQuestion): QuestionDraft {
  return {
    key: question.key,
    index: 0,
    problem: null,
    items: question.items.map((item): ItemDraft => {
      if (item.kind === "free-text") return { kind: "text", text: "" };
      if (item.kind === "review") return { kind: "review", acknowledged: false };
      return { kind: "choice", cursor: 0, chosen: [] };
    }),
  };
}

/** Why an item cannot be accepted yet, or null when it can. */
export function itemProblem(item: Item, draft: ItemDraft | undefined): string | null {
  if (item.kind === "free-text")
    return draft?.kind === "text" && textBytes(draft.text) <= item.maxBytes
      ? null
      : `The answer is longer than ${item.maxBytes} bytes.`;
  if (item.kind === "review") return null;
  const chosen = draft?.kind === "choice" ? draft.chosen.length : 0;
  if (item.kind === "single-select") return chosen === 1 ? null : "Choose one option.";
  if (chosen < item.minimum) return `Choose at least ${item.minimum}.`;
  if (chosen > item.maximum) return `Choose at most ${item.maximum}.`;
  return null;
}

function answerFrom(question: PresentedQuestion, draft: QuestionDraft): QuestionAnswer {
  return question.items.map((item, index) => {
    const value = draft.items[index];
    if (item.kind === "free-text")
      return {
        itemId: item.id,
        kind: "text" as const,
        text: value?.kind === "text" ? value.text : "",
      };
    if (item.kind === "review")
      return { itemId: item.id, kind: "review" as const, acknowledged: true as const };
    return {
      itemId: item.id,
      kind: "selection" as const,
      optionIds: value?.kind === "choice" ? [...value.chosen] : [],
    };
  });
}

function replace(draft: QuestionDraft, next: ItemDraft): QuestionDraft {
  return {
    ...draft,
    problem: null,
    items: draft.items.map((item, index) => (index === draft.index ? next : item)),
  };
}

export function stepQuestionDraft(
  question: PresentedQuestion,
  draft: QuestionDraft,
  action: DraftAction,
): DraftStep {
  const item = question.items[draft.index];
  const current = draft.items[draft.index];
  const editing = (next: QuestionDraft): DraftStep => ({ kind: "editing", draft: next });
  if (!item || !current) return editing(draft);
  const options = "options" in item ? item.options : [];
  switch (action.kind) {
    case "move":
      if (current.kind !== "choice" || options.length === 0) return editing(draft);
      return editing(
        replace(draft, {
          ...current,
          cursor: (current.cursor + action.delta + options.length) % options.length,
        }),
      );
    case "toggle": {
      if (current.kind !== "choice") return editing(draft);
      const id = options[current.cursor]?.id;
      if (id === undefined) return editing(draft);
      if (item.kind === "single-select")
        return editing(replace(draft, { ...current, chosen: [id] }));
      return editing(
        replace(draft, {
          ...current,
          chosen: current.chosen.includes(id)
            ? current.chosen.filter((chosen) => chosen !== id)
            : [...current.chosen, id],
        }),
      );
    }
    case "insert": {
      if (current.kind !== "text" || item.kind !== "free-text") return editing(draft);
      const text = current.text + action.text;
      // Input beyond the item's byte limit is refused whole, never truncated.
      if (textBytes(text) > item.maxBytes)
        return editing({
          ...draft,
          problem: `The answer is limited to ${item.maxBytes} bytes.`,
        });
      return editing(replace(draft, { kind: "text", text }));
    }
    case "delete":
      if (current.kind !== "text") return editing(draft);
      return editing(
        replace(draft, { kind: "text", text: [...current.text].slice(0, -1).join("") }),
      );
    case "back":
      return editing({ ...draft, problem: null, index: Math.max(0, draft.index - 1) });
    case "commit": {
      // Enter on a single-select chooses the highlighted option.
      const committed =
        item.kind === "single-select" && current.kind === "choice"
          ? replace(draft, { ...current, chosen: [options[current.cursor]?.id ?? ""] })
          : item.kind === "review"
            ? replace(draft, { kind: "review", acknowledged: true })
            : draft;
      const problem = itemProblem(item, committed.items[draft.index]);
      if (problem !== null) return editing({ ...committed, problem });
      if (draft.index < question.items.length - 1)
        return editing({ ...committed, index: draft.index + 1 });
      return { kind: "submit", draft: committed, answer: answerFrom(question, committed) };
    }
  }
}
