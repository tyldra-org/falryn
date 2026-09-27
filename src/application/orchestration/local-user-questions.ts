/**
 * Ask the local user one structured question (#1154).
 *
 * The interactive host's owner for asking: it creates and publishes a question for the local
 * presenter principal, offers it to the presenter and waits for its settlement. A presenter
 * that cannot take the question, a failed publication or an abandoned wait cancels the
 * question. Nothing here answers for the user.
 */
import { randomUUID } from "node:crypto";
import {
  QUESTION_LIMITS,
  type QuestionAnswer,
  type QuestionInput,
  type QuestionOwner,
} from "../../domain/orchestration/question.ts";
import type { ProductTaskResources } from "./product-resources.ts";
import type { LocalQuestionPresenter, QuestionPresenterPrincipal } from "./question-presenter.ts";
import type { StructuredQuestions } from "./structured-questions.ts";

export type LocalUserAnswer =
  | { readonly kind: "answered"; readonly answer: QuestionAnswer }
  | { readonly kind: "refused" | "expired" | "cancelled" | "unavailable" };

export type LocalUserQuestion = {
  /** The asking task; its resource scope closing cancels the question. */
  readonly owner: QuestionOwner;
  readonly resources: ProductTaskResources;
  readonly items: QuestionInput["items"];
  readonly waitMs: number;
  /** Shown to the user as where the question came from. */
  readonly source: string;
  readonly signal: AbortSignal;
};

export function createLocalUserQuestions(options: {
  readonly questions: Pick<StructuredQuestions, "create">;
  readonly presenter: Pick<LocalQuestionPresenter, "offer" | "refresh">;
  readonly principal: QuestionPresenterPrincipal;
}) {
  return {
    async ask(question: LocalUserQuestion): Promise<LocalUserAnswer> {
      const created = await options.questions.create(
        question.owner,
        question.resources,
        {
          version: 1,
          handle: {
            version: 1,
            taskId: `question-${randomUUID()}`,
            generation: question.resources.generation,
          },
          items: question.items,
          sensitivity: "normal",
          retention: "answer",
          presenter: options.principal,
          waitMs: Math.max(1, Math.min(QUESTION_LIMITS.maxWaitMs, Math.floor(question.waitMs))),
          missingPresenter: "wait",
        },
        question.signal,
      );
      if (!created.ok) return { kind: "unavailable" };
      const control = created.value.control;
      const abandon = async (kind: "cancelled" | "unavailable"): Promise<LocalUserAnswer> => {
        await control.cancel(new AbortController().signal);
        // The presenter drops a withdrawn question now rather than on its next refresh.
        options.presenter.refresh();
        return { kind };
      };
      if (!(await control.publish(question.signal)).ok) return abandon("unavailable");
      const offered = await options.presenter.offer(
        created.value,
        options.principal,
        question.source,
      );
      if (!offered) return abandon("unavailable");
      const settled = await control.wait(question.signal);
      if (!settled.ok) return abandon("cancelled");
      const { kind, answer } = settled.value;
      if (kind === "answered")
        return answer ? { kind: "answered", answer } : { kind: "unavailable" };
      return { kind };
    },
  };
}
export type LocalUserQuestions = ReturnType<typeof createLocalUserQuestions>;
