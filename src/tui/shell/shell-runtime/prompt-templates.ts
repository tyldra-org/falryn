/**
 * The shell's package prompt-template expansion (#1168, #1169).
 *
 * Expansion turns slash text naming an admitted template into draft text for
 * review; nothing is ever sent from here. When the template declares required
 * variables that the invocation did not give, the composer asks for each in turn:
 * the typed draft becomes the value and Enter moves on. Escape cancels, restores
 * the original invocation and sends nothing. Entered values live only in this
 * hook until the expansion settles; they never reach notices, facts or history.
 */
import { type Dispatch, useCallback, useMemo, useRef } from "react";
import type {
  PromptExpansion,
  PromptVariableRequest,
} from "../../../application/extensions/native-prompt-owner.ts";
import { parsePromptInvocation } from "../../../domain/context/prompt-templates.ts";
import type { ShellAction } from "../shell-state.ts";

type Expand = (
  text: string,
  signal: AbortSignal,
  entered?: Readonly<Record<string, string>>,
) => Promise<PromptExpansion>;

/** Required variables still being asked for one invocation. */
type Entry = {
  readonly requested: string;
  readonly name: string;
  readonly pending: readonly PromptVariableRequest[];
  readonly entered: Readonly<Record<string, string>>;
};

export type ShellPromptTemplates = {
  /** Take submitted text as the value being asked for; false when nothing is asked. */
  answer(text: string): boolean;
  /** Expand slash text naming a template; false when the text names none. */
  expand(text: string): boolean;
  /** Cancel an expansion or the value entry in progress; false when none is. */
  cancel(): boolean;
};

function askNotice(name: string, variable: PromptVariableRequest): string {
  return (
    "/" +
    name +
    " needs " +
    variable.name +
    " (" +
    variable.expected +
    (variable.sensitive ? "; sensitive, kept only in this draft" : "") +
    ")" +
    (variable.description === "" ? "" : ": " + variable.description) +
    ". Type a value and press Enter; Escape cancels and sends nothing."
  );
}

/** The textarea may echo the submitting Enter as a trailing line break; that is no edit. */
function settledText(text: string): string {
  return text.replace(/\n+$/u, "");
}

export function useShellPromptTemplates(options: {
  readonly dispatch: Dispatch<ShellAction>;
  readonly expand: Expand | undefined;
  /** The composer's current draft text. */
  readonly draft: () => string;
  readonly replaceDraft: (text: string) => void;
  /** Whether an expansion or value entry is in progress, so Escape can cancel it. */
  readonly onPending: (pending: boolean) => void;
}): ShellPromptTemplates {
  const { dispatch, expand, draft, replaceDraft, onPending } = options;
  const running = useRef<{ controller: AbortController; requested: string } | null>(null);
  const entry = useRef<Entry | null>(null);
  const sync = useCallback(
    () => onPending(running.current !== null || entry.current !== null),
    [onPending],
  );
  const notice = useCallback(
    (message: string) => dispatch({ kind: "notice", message }),
    [dispatch],
  );

  const run = useCallback(
    /**
     * Expand; the result applies only while the draft is still `expected`: the
     * invocation itself, or the entry field cleared after the last answer.
     */
    (requested: string, expected: string, entered?: Readonly<Record<string, string>>): void => {
      if (expand === undefined) return;
      const controller = new AbortController();
      running.current = { controller, requested };
      sync();
      const restore = (message: string) => {
        if (entered !== undefined) replaceDraft(requested);
        notice(message + " Your draft is unchanged.");
      };
      void expand(requested, controller.signal, entered)
        .then(
          (expansion) => {
            if (controller.signal.aborted) return;
            if (settledText(draft()) !== settledText(expected)) {
              notice("A prompt template was not applied because the draft changed.");
              return;
            }
            if (expansion.kind === "not-template") return restore("Not a prompt template.");
            if (expansion.kind === "failed")
              return restore("Not expanded: " + expansion.message + ".");
            if (expansion.kind === "needs-input") {
              const [first] = expansion.variables;
              // Entered values satisfy every variable asked for; a second request is a fault.
              if (first === undefined || entered !== undefined)
                return restore("Not expanded: /" + expansion.name + " is still missing values.");
              entry.current = {
                requested,
                name: expansion.name,
                pending: expansion.variables,
                entered: {},
              };
              replaceDraft("");
              notice(askNotice(expansion.name, first));
              return;
            }
            replaceDraft(expansion.text);
            notice(
              "Expanded /" +
                expansion.name +
                " from " +
                expansion.fact.prompt +
                " (" +
                expansion.fact.contentDigest +
                "). Review the draft, then send.",
            );
          },
          () => {
            if (!controller.signal.aborted) restore("Prompt template expansion is unavailable.");
          },
        )
        .finally(() => {
          if (running.current?.controller === controller) running.current = null;
          sync();
        });
    },
    [expand, draft, replaceDraft, notice, sync],
  );

  const answer = useCallback(
    (text: string): boolean => {
      const current = entry.current;
      const variable = current?.pending[0];
      if (current === null || variable === undefined) return false;
      const value = settledText(text);
      if (value === "") {
        notice(askNotice(current.name, variable));
        return true;
      }
      const entered = { ...current.entered, [variable.name]: value };
      const pending = current.pending.slice(1);
      replaceDraft("");
      const [next] = pending;
      if (next !== undefined) {
        entry.current = { ...current, pending, entered };
        notice(askNotice(current.name, next));
        return true;
      }
      entry.current = null;
      run(current.requested, "", entered);
      return true;
    },
    [notice, replaceDraft, run],
  );

  const expandText = useCallback(
    (text: string): boolean => {
      if (expand === undefined || parsePromptInvocation(text) === null) return false;
      if (running.current !== null) notice("A prompt template is already expanding.");
      else run(text, text);
      return true;
    },
    [expand, notice, run],
  );

  const cancel = useCallback((): boolean => {
    const active = running.current;
    const asking = entry.current;
    if (active === null && asking === null) return false;
    active?.controller.abort();
    running.current = null;
    entry.current = null;
    sync();
    const requested = asking?.requested ?? active?.requested;
    if (requested !== undefined && settledText(draft()) !== settledText(requested))
      replaceDraft(requested);
    notice("Prompt template cancelled. Nothing was sent; your draft is restored.");
    return true;
  }, [draft, replaceDraft, notice, sync]);

  return useMemo(() => ({ answer, expand: expandText, cancel }), [answer, expandText, cancel]);
}
