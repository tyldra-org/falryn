/**
 * Local presenter for structured questions (#1163).
 *
 * The host offers each newly published question with its presenter capability.
 * This owner connects as the presenter, keeps a bounded queue, and settles answers
 * or refusals through the question service. It never answers on the user's behalf,
 * holds no OpenTUI state, and keeps capabilities out of every projection.
 */
import type { ProcessTaskHandle } from "../../domain/orchestration/process-task.ts";
import type {
  QuestionAnswer,
  QuestionInput,
  QuestionSettlement,
} from "../../domain/orchestration/question.ts";
import type { ProductTaskResources } from "./product-resources.ts";
import type { StructuredQuestions } from "./structured-questions.ts";

export const QUESTION_PRESENTER_QUEUE = 64;
export const QUESTION_PRESENTER_REFRESH_MS = 1_000;

export type QuestionPresenterPrincipal = QuestionInput["presenter"];
/** What a presenter may render. Contains no capability, owner or storage facts. */
export type PresentedQuestion = {
  readonly key: string;
  readonly source: string;
  readonly items: QuestionInput["items"];
  readonly sensitivity: QuestionInput["sensitivity"];
  readonly expiresAt: number;
};
export type QuestionPresenterView = {
  /** The question to show now; null when none is waiting to be shown. */
  readonly current: PresentedQuestion | null;
  /** Further questions queued behind the current one. */
  readonly queued: number;
  /** Questions the user left without answering; they wait until reopened or expired. */
  readonly left: number;
};
export type QuestionPresenterResult =
  /** How the question stands after the action; null while it is still waiting. */
  | { readonly ok: true; readonly settlement: QuestionSettlement["kind"] | null }
  | { readonly ok: false; readonly code: string };
/** The published request and presenter capability a question producer hands over. */
export type OfferedQuestion = {
  readonly request: {
    readonly handle: ProcessTaskHandle;
    readonly items: QuestionInput["items"];
    readonly sensitivity: QuestionInput["sensitivity"];
    readonly expiresAt: number;
  };
  readonly presenterToken: string;
};

type Entry = {
  readonly key: string;
  readonly handle: ProcessTaskHandle;
  readonly token: string;
  readonly principal: QuestionPresenterPrincipal;
  readonly question: PresentedQuestion;
  shown: boolean;
};

export function createLocalQuestionPresenter(options: {
  readonly questions: Pick<StructuredQuestions, "presenter" | "inspect">;
  /** A short-lived resource scope for one presenter action; closed after use. */
  readonly openResources: () => ProductTaskResources;
}) {
  const entries = new Map<string, Entry>();
  const listeners = new Set<() => void>();
  let closed = false;
  let timer: ReturnType<typeof setInterval> | null = null;
  let view: QuestionPresenterView = { current: null, queued: 0, left: 0 };

  const keyOf = (handle: ProcessTaskHandle) => `${handle.taskId}/${handle.generation}`;
  const publish = () => {
    const shown = [...entries.values()].filter((entry) => entry.shown);
    view = {
      current: shown[0]?.question ?? null,
      queued: Math.max(0, shown.length - 1),
      left: entries.size - shown.length,
    };
    for (const listener of listeners) listener();
    if (entries.size === 0 && timer !== null) {
      clearInterval(timer);
      timer = null;
    }
  };
  const act = async (
    entry: Entry,
    action: "connect" | "disconnect" | "answer" | "refuse",
    input: unknown,
  ): Promise<QuestionPresenterResult> => {
    const resources = options.openResources();
    try {
      const result = await options.questions.presenter(
        entry.handle,
        entry.token,
        entry.principal,
        action,
        input,
        resources,
        new AbortController().signal,
      );
      return result.ok
        ? { ok: true, settlement: result.value.settlement?.kind ?? null }
        : { ok: false, code: result.error.code };
    } finally {
      resources.close();
    }
  };
  /** Drop questions the service has settled or expired; nothing else changes them. */
  const refresh = () => {
    let changed = false;
    for (const entry of entries.values()) {
      const inspected = options.questions.inspect(entry.handle, entry.token, entry.principal);
      if (!inspected.ok || inspected.value.settlement !== null) {
        entries.delete(entry.key);
        changed = true;
      }
    }
    if (changed) publish();
  };
  const settle = async (
    key: string,
    action: "answer" | "refuse",
    input: unknown,
  ): Promise<QuestionPresenterResult> => {
    const entry = entries.get(key);
    if (!entry?.shown) return { ok: false, code: "not-presented" };
    const result = await act(entry, action, input);
    // A settled, expired or withdrawn question leaves the queue whatever this attempt returned.
    refresh();
    return result;
  };

  return {
    view: (): QuestionPresenterView => view,
    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    /**
     * Accept one published question for this presenter. Returns false when the
     * presenter is closed or full; the question then keeps waiting until it expires.
     */
    async offer(
      offered: OfferedQuestion,
      principal: QuestionPresenterPrincipal,
      source: string,
    ): Promise<boolean> {
      const key = keyOf(offered.request.handle);
      if (closed || entries.has(key) || entries.size >= QUESTION_PRESENTER_QUEUE) return false;
      const entry: Entry = {
        key,
        handle: offered.request.handle,
        token: offered.presenterToken,
        principal,
        shown: true,
        question: {
          key,
          source: source.slice(0, 128),
          items: offered.request.items,
          sensitivity: offered.request.sensitivity,
          expiresAt: offered.request.expiresAt,
        },
      };
      const connected = await act(entry, "connect", null);
      if (!connected.ok || closed) return false;
      entries.set(key, entry);
      timer ??= setInterval(refresh, QUESTION_PRESENTER_REFRESH_MS);
      timer.unref?.();
      publish();
      return true;
    },
    answer: (key: string, answer: QuestionAnswer) => settle(key, "answer", answer),
    refuse: (key: string) => settle(key, "refuse", null),
    /** Stop showing a question without answering it; it keeps waiting until reopened or expired. */
    async leave(key: string): Promise<QuestionPresenterResult> {
      const entry = entries.get(key);
      if (!entry?.shown) return { ok: false, code: "not-presented" };
      entry.shown = false;
      publish();
      return act(entry, "disconnect", null);
    },
    /** Show the oldest left question again. */
    async reopen(): Promise<QuestionPresenterResult> {
      const entry = [...entries.values()].find((candidate) => !candidate.shown);
      if (!entry) return { ok: false, code: "nothing-left" };
      const connected = await act(entry, "connect", null);
      refresh();
      if (!connected.ok) return connected;
      if (entries.has(entry.key)) {
        entry.shown = true;
        publish();
      }
      return connected;
    },
    refresh,
    close() {
      closed = true;
      if (timer !== null) clearInterval(timer);
      timer = null;
      entries.clear();
      publish();
      listeners.clear();
    },
  };
}
export type LocalQuestionPresenter = ReturnType<typeof createLocalQuestionPresenter>;
