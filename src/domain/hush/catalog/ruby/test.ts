/** Hush command-catalog policy for ruby.test. */

import type { HushCatalogEntry } from "../contracts.ts";

export const RUBY_TEST_POLICY = {
  reducerId: "ruby.test",
  family: "test",
  projection: "test",
  executables: ["rake", "rails", "rspec"],
  examples: ["rake test", "rails test", "bundle exec rspec"],
  matches: (tokens) => tokens[0] === "rspec" || tokens.includes("test"),
} as const satisfies HushCatalogEntry;
