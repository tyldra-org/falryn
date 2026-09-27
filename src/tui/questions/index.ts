/** Local structured-question presentation (#1163). */
import type { LocalQuestionPresenter } from "../../application/orchestration/question-presenter.ts";

export type {
  PresentedQuestion,
  QuestionPresenterView,
} from "../../application/orchestration/question-presenter.ts";
export {
  createQuestionDraft,
  type DraftAction,
  type DraftStep,
  type ItemDraft,
  itemProblem,
  type QuestionDraft,
  stepQuestionDraft,
  textBytes,
} from "./draft.ts";

/** What the shell may do with the host's presenter; offering questions stays with the host. */
export type QuestionPresenterPort = Pick<
  LocalQuestionPresenter,
  "view" | "subscribe" | "answer" | "refuse" | "leave" | "reopen"
>;
