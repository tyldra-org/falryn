import { describe, expect, test } from "bun:test";
import { mergeProjectItemSources } from "./project-item-sources";

type Item = { readonly id: string; readonly status: string };

const item = (id: string, status = "Todo"): Item => ({ id, status });

describe("Project item source merge", () => {
  test("recovers an item the Project list omitted", () => {
    expect(mergeProjectItemSources<Item>([], [item("recent")])).toEqual({
      items: [item("recent")],
      recovered: 1,
    });
  });

  test("prefers the issue-side value for an item both sources report", () => {
    expect(
      mergeProjectItemSources([item("shared", "Todo")], [item("shared", "In Progress")]),
    ).toEqual({ items: [item("shared", "In Progress")], recovered: 0 });
  });

  test("retains listed items the issue side did not report", () => {
    expect(mergeProjectItemSources([item("listed")], [])).toEqual({
      items: [item("listed")],
      recovered: 0,
    });
  });

  test("keeps a real gap absent when neither source reports an item", () => {
    expect(mergeProjectItemSources<Item>([], [])).toEqual({ items: [], recovered: 0 });
  });

  test("refuses duplicate item identities from either source", () => {
    expect(() => mergeProjectItemSources([], [item("twice"), item("twice")])).toThrow(
      "issue-side Project items contain duplicate item twice",
    );
    expect(() => mergeProjectItemSources([item("twice"), item("twice")], [])).toThrow(
      "listed Project items contain duplicate item twice",
    );
  });
});
