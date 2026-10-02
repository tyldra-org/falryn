import { packageSuggestionLines } from "../../../application/extensions/package-suggestions.ts";
import type { ExtensionSuggestionPayload } from "../../commands/extension-suggestion.ts";

/** Human lines: the shared suggestion projection plus the revision a change needs. */
export function extensionSuggestionLines(payload: ExtensionSuggestionPayload): readonly string[] {
  if (payload.status === "failed") return [`Package suggestions: failed (${payload.code}).`];
  const preferences = payload.preferences;
  const footer = [
    `Opted-in sources: ${preferences.sources.length > 0 ? preferences.sources.join(", ") : "none"}` +
      ` · dismissed ${preferences.dismissed.length} · revision ${preferences.revision ?? "none"}`,
  ];
  if ("page" in payload)
    return [
      ...packageSuggestionLines(payload.page, { proposals: preferences.proposals }),
      ...footer,
    ];
  return [
    payload.changed
      ? `Suggestion preferences updated: ${payload.status}.`
      : "Suggestion preferences already matched; nothing was written.",
    ...footer,
  ];
}
