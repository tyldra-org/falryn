/**
 * A compiled entry that runs the storage bootstrap.
 *
 * #17 made `src/main.ts` a command tree, so the bare invocation no longer opens
 * and migrates the database. That removed the only compiled path that applied a
 * migration — and applying migrations inside a standalone executable is exactly
 * the thing a compiled check exists to protect, because SQL kept in a file tree
 * needs a loader to be embedded and a database that looks unmigrated is a
 * failure source mode cannot see.
 *
 * Rather than leave that uncovered until some future command opens storage for
 * writing, this entry stands in for one. It is the same pattern
 * `src/cli/probe-fixtures.ts` established: a fixture that ships in no build —
 * `bun run build` compiles `src/main.ts` — which the test compiles itself.
 *
 * It composes nothing of its own. Whatever `main()` does is what is measured.
 */

import { bootstrapExitCode, main } from "./main.ts";

const report = await main();
// Through the same table the product path uses, so a bootstrap failure is
// reported here exactly as a user would see it.
process.exitCode = bootstrapExitCode(report);
