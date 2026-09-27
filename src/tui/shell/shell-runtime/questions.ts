/**
 * The shell's binding to the local question presenter (#1163).
 *
 * The presenter owns the queue and settlement; the reducer owns which overlay is
 * showing; this hook keeps the answer being composed and turns presenter results
 * into notices. Nothing here answers for the user: leaving keeps the question
 * waiting, and a failed submission leaves it in whatever state the service reports.
 */
import {
  type Dispatch,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type { QuestionPresenterView } from "../../../application/orchestration/question-presenter.ts";
import {
  createQuestionDraft,
  type DraftAction,
  type PresentedQuestion,
  type QuestionDraft,
  type QuestionPresenterPort,
  stepQuestionDraft,
} from "../../questions/index.ts";
import type { ShellAction } from "../shell-state.ts";

export type QuestionSheetState = {
  readonly question: PresentedQuestion;
  readonly draft: QuestionDraft;
  /** Further questions waiting behind this one. */
  readonly queued: number;
  /** True while an answer or refusal is being settled. */
  readonly settling: boolean;
};

export type ShellQuestions = {
  readonly sheet: QuestionSheetState | null;
  edit(action: DraftAction): void;
  refuse(): void;
  leave(): void;
  reopen(): boolean;
};

const IDLE: QuestionPresenterView = { current: null, queued: 0, left: 0 };
const idle = () => IDLE;
const noSubscription = () => () => {};

/** Why a settlement attempt did not answer, in the user's terms. */
export function questionNotice(code: string): string {
  switch (code) {
    case "conflicting-answer":
      return "This question was already settled; your answer was not used.";
    case "malformed":
      return "That answer does not fit the question and was not sent.";
    case "not-presented":
    case "denied":
    case "not-found":
      return "This question is no longer waiting.";
    case "disconnected-presenter":
      return "The question sheet lost its connection; show waiting questions to try again.";
    default:
      return `The question could not be settled (${code}).`;
  }
}

function settledNotice(kind: string | null, action: "answer" | "refuse"): string {
  if (kind === "answered") return "Answer sent.";
  if (kind === "refused") return "Question refused.";
  if (kind === "expired") return "This question expired before it was settled.";
  if (kind === "cancelled") return "The question was withdrawn before it was settled.";
  return action === "answer" ? "Answer sent." : "Question refused.";
}

export function useShellQuestions(options: {
  readonly dispatch: Dispatch<ShellAction>;
  readonly presenter: QuestionPresenterPort | null;
}): ShellQuestions {
  const { dispatch, presenter } = options;
  const view = useSyncExternalStore(
    presenter?.subscribe ?? noSubscription,
    presenter?.view ?? idle,
    presenter?.view ?? idle,
  );
  const current = view.current;
  const [stored, setStored] = useState<QuestionDraft | null>(null);
  // Keys can arrive faster than renders; each edit steps from the latest draft, not the rendered one.
  const latest = useRef<QuestionDraft | null>(null);
  const [settling, setSettling] = useState<string | null>(null);
  const draft = useMemo(
    () =>
      current === null ? null : stored?.key === current.key ? stored : createQuestionDraft(current),
    [current, stored],
  );

  useEffect(() => {
    dispatch({ kind: "question-view", key: current?.key ?? null, left: view.left });
  }, [dispatch, current?.key, view.left]);

  const settle = useCallback(
    (
      key: string,
      action: "answer" | "refuse",
      run: () => ReturnType<QuestionPresenterPort["refuse"]>,
    ) => {
      setSettling(key);
      void run()
        .then((result) => {
          dispatch({
            kind: "notice",
            message: result.ok
              ? settledNotice(result.settlement, action)
              : questionNotice(result.code),
          });
        })
        .catch(() => {
          dispatch({ kind: "notice", message: questionNotice("unavailable") });
        })
        .finally(() => {
          setSettling((currentKey) => (currentKey === key ? null : currentKey));
        });
    },
    [dispatch],
  );

  const edit = useCallback(
    (action: DraftAction): void => {
      if (presenter === null || current === null || settling === current.key) {
        return;
      }
      // Protected answers are a non-retention fact this presenter cannot collect.
      if (current.sensitivity === "protected") return;
      const base =
        latest.current?.key === current.key ? latest.current : createQuestionDraft(current);
      const step = stepQuestionDraft(current, base, action);
      latest.current = step.draft;
      setStored(step.draft);
      if (step.kind === "submit") {
        const key = current.key;
        settle(key, "answer", () => presenter.answer(key, step.answer));
      }
    },
    [presenter, current, settling, settle],
  );

  const refuse = useCallback((): void => {
    if (presenter === null || current === null || settling === current.key) return;
    const key = current.key;
    settle(key, "refuse", () => presenter.refuse(key));
  }, [presenter, current, settling, settle]);

  const leave = useCallback((): void => {
    if (presenter === null || current === null) {
      dispatch({ kind: "close-overlay" });
      return;
    }
    void presenter.leave(current.key).then((result) => {
      dispatch({
        kind: "notice",
        message: result.ok
          ? "Question left waiting. Use Show waiting questions to return to it."
          : questionNotice(result.code),
      });
    });
  }, [presenter, current, dispatch]);

  const reopen = useCallback((): boolean => {
    if (presenter === null || view.left === 0) return false;
    void presenter.reopen().then((result) => {
      if (!result.ok) dispatch({ kind: "notice", message: questionNotice(result.code) });
    });
    return true;
  }, [presenter, view.left, dispatch]);

  // Stable between question changes, so commands and key bindings are not rebuilt every frame.
  return useMemo(
    () => ({
      sheet:
        current === null || draft === null
          ? null
          : { question: current, draft, queued: view.queued, settling: settling === current.key },
      edit,
      refuse,
      leave,
      reopen,
    }),
    [current, draft, view.queued, settling, edit, refuse, leave, reopen],
  );
}
