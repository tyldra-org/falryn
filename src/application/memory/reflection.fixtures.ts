import { openProductStoreOrThrow, temporaryRoot } from "../../data/fixtures.ts";
import { createReflectionRepository } from "../../data/memory/reflection-repository.ts";
import { createSqliteEventStore } from "../../data/sessions/event-store.ts";
import { sessionStarted, turnCompleted, turnStarted } from "../../domain/fixtures.ts";
import { createSystemClock } from "../../domain/foundation/index.ts";
import type {
  ReflectionAuthority,
  ReflectionBinding,
  ReflectionRepository,
  ReflectionResult,
} from "../../domain/memory/reflection.ts";
import type { ReflectionView } from "../../domain/memory/reflection-export.ts";
import type { SqliteStorePort } from "../../domain/storage/index.ts";
import { createProductResources } from "../orchestration/product-resources.ts";
import { createReflectionActions, type ReflectionResponse } from "./reflection-actions.ts";

export const reflectionBinding: ReflectionBinding = {
  sessionId: "session-fixture",
  workspaceId: "workspace-fixture",
  streamId: "session:fixture-session",
  repository: "repository-1",
  branch: "main",
  worktree: "worktree-1",
  sourceGeneration: "source-1",
  configurationGeneration: 0,
  policyGeneration: "policy-1",
  authorizationGeneration: "authorization-1",
};
export const reflectionAuthority: ReflectionAuthority = {
  current: () => reflectionBinding,
  sourceAllowed: () => true,
  artifactAllowed: () => true,
  candidateAllowed: () => true,
  preparedAllowed: () => true,
};
export function reflectionActionsFor(
  store: SqliteStorePort,
  authority: ReflectionAuthority = reflectionAuthority,
  now: () => number = Date.now,
  repository: ReflectionRepository = createReflectionRepository(store),
) {
  const resources = createProductResources(createSystemClock());
  return createReflectionActions(repository, {
    authority,
    now,
    resources: resources.openTask("configuration-1"),
  });
}
export function reflectionValue(result: ReflectionResult<ReflectionResponse>): ReflectionResponse {
  if (!result.ok) throw new Error(result.error.code);
  return result.value;
}
export function reflectionRecord(result: ReflectionResult<ReflectionResponse>): ReflectionView {
  const response = reflectionValue(result);
  if (response.kind !== "record") throw new Error(response.kind);
  return response.record;
}
export function reflectionCode(result: ReflectionResult<ReflectionResponse>): string {
  return result.ok ? result.value.kind : result.error.code;
}
export const reflectionCandidate = {
  subject: "Project decision",
  content: "Use the committed source as evidence.",
  sources: ["event-turn-done-3"],
  artifacts: [],
  method: "deterministic" as const,
  proposedScope: "workspace" as const,
  kind: "decision" as const,
  confidence: 0.5,
  sensitivity: "user-content" as const,
  contradiction: "possible" as const,
  supersedes: [],
};
export async function reflectionFixture() {
  const root = await temporaryRoot("falryn-reflection-");
  const store = await openProductStoreOrThrow(root);
  const events = createSqliteEventStore(store, { projectStartedRecords: true });
  for (const event of [sessionStarted(), turnStarted(), turnCompleted()]) {
    const result = await events.append(event);
    if (!result.ok) throw new Error(result.error.code);
  }
  const actions = reflectionActionsFor(store);
  const send = (command: unknown) => actions.execute(JSON.stringify(command));
  const create = (range = { first: 1, last: 3 }, transform = "transform-1") =>
    send({ action: "create", binding: reflectionBinding, range, transform, reason: "explicit" });
  const lease = async (id: string, durationMs = 1000) => {
    const result = reflectionValue(await send({ action: "lease", id, durationMs, process: null }));
    if (result.kind !== "record" || !result.fence) throw new Error("missing fence");
    return result.fence;
  };
  return { root, store, events, actions, send, create, lease };
}
