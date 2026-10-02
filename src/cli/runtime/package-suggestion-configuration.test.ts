import { expect, test } from "bun:test";
import { documentSettingPath } from "../../config/document/organized.ts";
import {
  PACKAGE_SUGGESTION_PROPOSALS_KEY,
  PACKAGE_SUGGESTIONS_KEY,
} from "../../domain/extensions/package-suggestion.ts";
import {
  PACKAGE_SUGGESTION_CONFIGURATION_KEYS,
  packageSuggestionPreferences,
  packageSuggestionProposals,
} from "./package-suggestion-configuration.ts";

const descriptor = (path: string) =>
  PACKAGE_SUGGESTION_CONFIGURATION_KEYS.find((key) => key.descriptor.path === path)?.descriptor;

test("opting in is user-only; a project can only propose sources", () => {
  expect(descriptor(PACKAGE_SUGGESTIONS_KEY)?.scopes).toEqual(["user"]);
  expect(descriptor(PACKAGE_SUGGESTION_PROPOSALS_KEY)?.scopes).toEqual(["project"]);
  expect(documentSettingPath(PACKAGE_SUGGESTIONS_KEY, "user")).toBe(
    "connections.packageSuggestions",
  );
  expect(documentSettingPath(PACKAGE_SUGGESTION_PROPOSALS_KEY, "project")).toBe(
    "defaults.capabilities.packageSuggestionProposals",
  );
  expect(
    packageSuggestionProposals({ [PACKAGE_SUGGESTION_PROPOSALS_KEY]: { sources: ["team"] } }),
  ).toEqual(["team"]);
  expect(packageSuggestionProposals({ [PACKAGE_SUGGESTION_PROPOSALS_KEY]: "nope" })).toEqual([]);
});

test("preferences fail closed when configuration is unread or malformed", () => {
  const record = (outcome: string) =>
    ({ sources: [{ outcome }] }) as unknown as Parameters<typeof packageSuggestionPreferences>[1];
  expect(packageSuggestionPreferences({}, record("loaded"))).toEqual({
    sources: [],
    dismissed: [],
  });
  expect(packageSuggestionPreferences({}, null)).toBeNull();
  expect(packageSuggestionPreferences({}, record("unreadable"))).toBeNull();
  expect(
    packageSuggestionPreferences(
      { [PACKAGE_SUGGESTIONS_KEY]: { sources: ["a", "a"] } },
      record("loaded"),
    ),
  ).toBeNull();
});
