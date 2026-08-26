/** Ordered Hush catalog group preserving executable matcher precedence. */

import { BUN_BUILD_POLICY } from "../bun/build.ts";
import { BUN_COMMAND_POLICY } from "../bun/command.ts";
import { BUN_LINT_POLICY } from "../bun/lint.ts";
import { BUN_TEST_POLICY } from "../bun/test.ts";
import { BUN_TYPECHECK_POLICY } from "../bun/typecheck.ts";
import type { HushCatalogEntry } from "../contracts.ts";
import { JS_BUILD_POLICY } from "../js/build.ts";
import { JS_FORMAT_POLICY } from "../js/format.ts";
import { JS_LINT_POLICY } from "../js/lint.ts";
import { JS_PACKAGE_POLICY } from "../js/package.ts";
import { JS_PRISMA_POLICY } from "../js/prisma.ts";
import { JS_TEST_POLICY } from "../js/test.ts";
import { JS_TYPECHECK_POLICY } from "../js/typecheck.ts";

export const JAVASCRIPT_COMMANDS = [
  JS_PACKAGE_POLICY,
  JS_TYPECHECK_POLICY,
  JS_LINT_POLICY,
  JS_FORMAT_POLICY,
  JS_TEST_POLICY,
  JS_BUILD_POLICY,
  JS_PRISMA_POLICY,
  BUN_TEST_POLICY,
  BUN_BUILD_POLICY,
  BUN_LINT_POLICY,
  BUN_TYPECHECK_POLICY,
  BUN_COMMAND_POLICY,
] as const satisfies readonly HushCatalogEntry[];
