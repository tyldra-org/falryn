/** Ordered command-reducer group mirroring the Hush catalog. */

import { BUN_BUILD_REDUCER } from "../bun/build.ts";
import { BUN_COMMAND_REDUCER } from "../bun/command.ts";
import { BUN_LINT_REDUCER } from "../bun/lint.ts";
import { BUN_TEST_REDUCER } from "../bun/test.ts";
import { BUN_TYPECHECK_REDUCER } from "../bun/typecheck.ts";
import { JS_BUILD_REDUCER } from "../js/build.ts";
import { JS_FORMAT_REDUCER } from "../js/format.ts";
import { JS_LINT_REDUCER } from "../js/lint.ts";
import { JS_PACKAGE_REDUCER } from "../js/package.ts";
import { JS_PRISMA_REDUCER } from "../js/prisma.ts";
import { JS_TEST_REDUCER } from "../js/test.ts";
import { JS_TYPECHECK_REDUCER } from "../js/typecheck.ts";

export const JAVASCRIPT_COMMAND_REDUCERS = {
  "js.package": JS_PACKAGE_REDUCER,
  "js.typecheck": JS_TYPECHECK_REDUCER,
  "js.lint": JS_LINT_REDUCER,
  "js.format": JS_FORMAT_REDUCER,
  "js.test": JS_TEST_REDUCER,
  "js.build": JS_BUILD_REDUCER,
  "js.prisma": JS_PRISMA_REDUCER,
  "bun.test": BUN_TEST_REDUCER,
  "bun.build": BUN_BUILD_REDUCER,
  "bun.lint": BUN_LINT_REDUCER,
  "bun.typecheck": BUN_TYPECHECK_REDUCER,
  "bun.command": BUN_COMMAND_REDUCER,
} as const;
