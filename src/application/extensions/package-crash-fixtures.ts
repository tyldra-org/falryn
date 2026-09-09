/** Test-only abrupt process exits at the byte/SQL publication boundary. */
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { createPackageLifecycleRepository } from "../../data/extensions/package-lifecycle-repository.ts";
import { openProductStoreOrThrow } from "../../data/fixtures.ts";
import { localPath } from "../../domain/workspace/index.ts";
import { createHostPackageCache } from "../../integrations/extensions/host-package-cache.ts";
import { inspectionHost, packageSource, pluginManifest } from "./package-fixtures.ts";
import { createPackageLifecycle } from "./package-lifecycle.ts";

const [root, phase] = process.argv.slice(2);
if (root === undefined || !["before-bytes", "after-bytes", "after-commit"].includes(phase ?? ""))
  throw new Error("invalid fixture arguments");
const store = await openProductStoreOrThrow(localPath(root));
const repository = createPackageLifecycleRepository(store);
const cache = createHostPackageCache(join(root, "packages"));
const owner = createPackageLifecycle(
  repository,
  {
    ...cache,
    stage(id, snapshot, signal) {
      if (phase === "before-bytes") process.exit(77);
      cache.stage(id, snapshot, signal);
      if (phase === "after-bytes") process.exit(77);
    },
  },
  inspectionHost,
);
const signal = new AbortController().signal;
const request = {
  packageId: "fixture",
  operationId: randomUUID(),
  expectedRevision: 1,
  retention: "retain" as const,
};
const source = packageSource(pluginManifest(undefined, { version: "2.0.0" }));
const preview = await owner.run("update", request, signal, source);
if (preview.confirmation === null) throw new Error("fixture preview failed");
const result = await owner.run(
  "update",
  { ...request, confirmation: preview.confirmation },
  signal,
  source,
);
if (result.status !== "completed") throw new Error("fixture publication failed");
process.exit(78);
