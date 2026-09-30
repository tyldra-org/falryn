/**
 * The composer suggestion list's queries (#1206).
 *
 * The composer state decides when a list is open and hands out a request number
 * for every new query. This hook is the one owner of the asynchronous part: it
 * waits out a short typing pause, asks the trigger's source, cancels a superseded
 * request and drops any answer whose number is no longer the open one. Sources read
 * metadata only; nothing here starts a server or reads a body.
 */
import { type Dispatch, useEffect, useRef } from "react";
import type { MentionTrigger } from "../../../domain/context/composer-mentions.ts";
import type { ComposerSuggestions } from "../../composer/index.ts";
import {
  type ComposerSuggestionSource,
  SUGGESTION_DEBOUNCE_MS,
} from "../../composer/suggestions.ts";
import type { ShellAction } from "../shell-state.ts";

export function useComposerSuggestions(options: {
  readonly dispatch: Dispatch<ShellAction>;
  readonly sources: readonly ComposerSuggestionSource[] | undefined;
  readonly open: ComposerSuggestions | null;
}): void {
  const { dispatch, sources, open } = options;
  const inFlight = useRef<AbortController | null>(null);

  // Only triggers with a source open a list; every other one stays a character.
  const triggers = (sources ?? []).map((source) => source.trigger).join("");
  useEffect(() => {
    dispatch({
      kind: "composer",
      action: {
        kind: "mention-triggers",
        triggers: new Set(triggers.split("").filter(Boolean) as MentionTrigger[]),
      },
    });
  }, [dispatch, triggers]);

  const request = open?.request ?? null;
  const trigger = open?.trigger ?? null;
  const query = open?.query ?? null;
  useEffect(() => {
    inFlight.current?.abort();
    inFlight.current = null;
    if (request === null || trigger === null || query === null) return;
    const source = sources?.find((item) => item.trigger === trigger);
    if (source === undefined) return;
    const controller = new AbortController();
    inFlight.current = controller;
    const timer = setTimeout(() => {
      source.query(query, controller.signal).then(
        (page) => {
          if (!controller.signal.aborted) {
            dispatch({ kind: "composer", action: { kind: "suggestion-results", request, page } });
          }
        },
        (error: unknown) => {
          if (!controller.signal.aborted) {
            dispatch({
              kind: "composer",
              action: {
                kind: "suggestion-failed",
                request,
                reason: `Suggestions are unavailable: ${error instanceof Error ? error.message : "the source failed"}.`,
              },
            });
          }
        },
      );
    }, SUGGESTION_DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [dispatch, sources, request, trigger, query]);
}
