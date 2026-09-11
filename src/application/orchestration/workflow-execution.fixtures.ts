import { createWorkflowStore } from "../../data/orchestration/workflow-store.ts";
import { canonicalDigest } from "../../domain/extensions/canonical.ts";
import { createProcessTaskFixture } from "./process-task.fixtures.ts";
import { createProductResources } from "./product-resources.ts";
import { createWorkflowArtifacts } from "./workflow-artifacts.ts";
import { createWorkflowExecution } from "./workflow-execution.ts";
import type { WorkflowHost } from "./workflow-host.ts";

export async function workflowFixture(execute?: WorkflowHost["execute"]) {
  const f = await createProcessTaskFixture();
  const resources = createProductResources(f.clock);
  const task = resources.openTask("0");
  const store = createWorkflowStore(f.database);
  const artifacts = createWorkflowArtifacts(f.artifacts);
  const execution = createWorkflowExecution({ store, artifacts, clock: f.clock });
  const calls: string[] = [];
  const host: WorkflowHost = {
    owner: { ...f.snapshot.owner, resourceTaskId: task.id },
    resources: task,
    authority: canonicalDigest("host-authority"),
    sourceGeneration: "source-1",
    current: () => true,
    validate: () => [],
    routes: () => ({}),
    reservation: () => ({ operations: 1 }),
    execute: async (...args) => {
      calls.push(args[0].key);
      return execute ? execute(...args) : { state: "completed", effect: "none", value: {} };
    },
    question: async () => ({ state: "waiting", effect: "none" }),
    fenced: async () => true,
    reusable: async () => true,
  };
  return {
    ...f,
    store,
    nativeArtifacts: f.artifacts,
    artifacts,
    execution,
    host,
    calls,
    async close() {
      task.close();
      await resources.shutdown();
      await f.close();
    },
  };
}
