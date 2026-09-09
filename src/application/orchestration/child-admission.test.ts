import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { createManualClock } from "../../domain/foundation/index.ts";
import type {
  ChildAuthority,
  ChildWorkTarget,
} from "../../domain/orchestration/child-admission.ts";
import { NO_RETRY, workUnitId } from "../../domain/orchestration/work.ts";
import {
  type ChildAdmissionResult,
  createChildAdmission,
  isAdmittedChild,
} from "./child-admission.ts";
import { createProductResources, type ResourceWork } from "./product-resources.ts";
import { createScopeTree, MAX_SCOPE_DEPTH } from "./scope-tree.ts";

const provider = {
  providerId: "provider",
  providerProfileId: "account",
  providerDestinationId: "destination",
  modelId: "model",
  reasoning: "provider-default",
  reasoningControl: null,
};
const authority: ChildAuthority = {
  version: 1,
  workspaceId: "workspace",
  configurationGeneration: "1",
  capabilityGeneration: "1",
  providers: [provider],
  capabilities: ["read", "write"],
  effects: ["observation", "mutation"],
};
const request = (id: string, requested = authority) => ({
  id,
  authority: requested,
  limits: {},
  workDigest: createHash("sha256").update(id).digest("hex"),
});
function admitted(result: ChildAdmissionResult) {
  if (result.kind !== "admitted") throw new Error(result.reason);
  return result.child;
}
function setup() {
  const clock = createManualClock();
  const resources = createProductResources(clock, { maxConcurrent: 1 });
  const root = resources.openTask("1", { requests: 3 });
  const tree = createScopeTree({ clock });
  const admission = createChildAdmission({ resources: root, tree, scope: tree.root(), authority });
  return { clock, resources, root, tree, admission };
}
function work(id: string, target?: ChildWorkTarget): ResourceWork<string> {
  return {
    operation: id,
    attempt: "a",
    generation: "1",
    inputBytes: 1,
    amounts: { requests: 1 },
    signal: new AbortController().signal,
    ...(target === undefined ? {} : { target }),
    unit: {
      id: workUnitId(id),
      priority: "interactive",
      effect: "observation",
      conflictKeys: [],
      dependencies: [],
      deadline: null,
      expectedOutputBytes: 0,
      retry: NO_RETRY,
      scopeId: null,
    },
    run: async () => ({ value: "ok", terminated: true }),
  };
}
const read: ChildWorkTarget = {
  kind: "tool",
  workspaceId: "workspace",
  capabilityId: "read",
  capabilityGeneration: "1",
};

test("nested authority intersects ancestors and is immutable", async () => {
  const s = setup();
  const first = admitted(
    s.admission.admit(
      request("first", { ...authority, capabilities: ["read"], effects: ["observation"] }),
    ),
  );
  const second = admitted(first.admit(request("second")));
  expect(second.authority.capabilities).toEqual(["read"]);
  expect(second.authority.effects).toEqual(["observation"]);
  expect(Object.isFrozen(second.authority.providers[0])).toBe(true);
  expect((await second.resources.execute(work("read", read))).kind).toBe("completed");
  expect(
    (await second.resources.execute(work("write", { ...read, capabilityId: "write" }))).receipt
      .state,
  ).toBe("authority-denied");
  expect((await second.resources.execute(work("missing"))).receipt.state).toBe("authority-denied");
  expect(
    (await second.resources.execute(work("foreign", { ...read, workspaceId: "foreign" }))).receipt
      .state,
  ).toBe("authority-denied");
  expect(s.root.remaining("requests")).toBe(2);
  first.close();
  expect(second.scope.signal.aborted).toBe(true);
  s.root.close();
});

test("provider account, destination, model and thinking are pinned before any request", async () => {
  const s = setup();
  const child = admitted(s.admission.admit(request("child")));
  for (const key of [
    "providerProfileId",
    "providerDestinationId",
    "modelId",
    "reasoning",
  ] as const) {
    const changed = { ...provider, [key]: "different" };
    expect(
      (
        await child.resources.execute(
          work(key, { kind: "provider", workspaceId: "workspace", binding: changed }),
        )
      ).receipt.state,
    ).toBe("authority-denied");
  }
  expect(
    (
      await child.resources.execute(
        work("allowed", { kind: "provider", workspaceId: "workspace", binding: provider }),
      )
    ).kind,
  ).toBe("completed");
  expect(
    s.admission.admit(
      request("wider", { ...authority, providers: [{ ...provider, modelId: "other" }] }),
    ),
  ).toEqual({ kind: "refused", reason: "authority-denied" });
  s.root.close();
});

test("same definition may do distinct work, but an alias cannot repeat unchanged work", () => {
  const s = setup();
  const original = request("original");
  const child = admitted(s.admission.admit(original));
  child.close();
  expect(s.admission.admit(original)).toEqual({ kind: "refused", reason: "duplicate-child" });
  expect(s.admission.admit({ ...original, id: "alias" })).toEqual({
    kind: "refused",
    reason: "no-progress",
  });
  const anotherFacade = createChildAdmission({
    resources: s.root,
    tree: s.tree,
    scope: s.tree.root(),
    authority,
  });
  expect(anotherFacade.admit({ ...original, id: "another-alias" })).toEqual({
    kind: "refused",
    reason: "no-progress",
  });
  expect(s.admission.admit(request("new-evidence"))).toMatchObject({ kind: "admitted" });
  s.root.close();
});

test("a serialized child handle cannot grant execution after restart", () => {
  const s = setup();
  const child = admitted(s.admission.admit(request("child")));
  expect(isAdmittedChild(child)).toBe(true);
  expect(Object.isFrozen(child.resources)).toBe(true);
  expect(Object.isFrozen(child.scope)).toBe(true);
  expect(isAdmittedChild(JSON.parse(JSON.stringify(child)))).toBe(false);
  expect(isAdmittedChild({ ...child })).toBe(false);
  child.close();
  expect(s.tree.state(child.scope.scopeId)?.status).toBe("terminal");
  s.root.close();
});

test("an admission facade captures its original owner when host options are reused", () => {
  const s = setup();
  const options = { resources: s.root, tree: s.tree, scope: s.tree.root(), authority };
  const facade = createChildAdmission(options);
  admitted(facade.admit(request("first"))).close();
  options.resources = s.resources.openTask("1");
  expect(facade.admit(request("first"))).toEqual({ kind: "refused", reason: "duplicate-child" });
  options.resources.close();
  s.root.close();
});

test("cancellation retains uncertain capacity until the native operation actually terminates", async () => {
  const s = setup();
  const first = admitted(s.admission.admit(request("first")));
  const sibling = admitted(s.admission.admit(request("sibling")));
  const hold = Promise.withResolvers<{ value: string; terminated: boolean }>();
  const started = Promise.withResolvers<void>();
  const active = first.resources.execute({
    ...work("held", { kind: "provider", workspaceId: "workspace", binding: provider }),
    run: async () => {
      started.resolve();
      return hold.promise;
    },
  });
  await started.promise;
  first.close();
  expect((await active).receipt.uncertain).toBe(true);
  expect(s.tree.state(first.scope.scopeId)?.status).toBe("cancelling");
  let siblingRan = false;
  const queued = sibling.resources.execute({
    ...work("sibling", read),
    run: async () => {
      siblingRan = true;
      return { value: "ok", terminated: true };
    },
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(siblingRan).toBe(false);
  hold.resolve({ value: "ok", terminated: true });
  expect((await queued).kind).toBe("completed");
  expect(s.tree.state(first.scope.scopeId)?.status).toBe("terminal");
  expect(s.resources.report().uncertain).toBe(0);
  sibling.close();
  s.root.close();
});

test("scope depth counts infrastructure scopes and rejects before a child can run", () => {
  const s = setup();
  let scope = s.tree.root();
  for (let depth = 0; depth < MAX_SCOPE_DEPTH - 1; depth++) {
    const derived = s.tree.derive(scope.scopeId, { kind: "invocation" });
    if (!derived.ok) throw new Error(derived.error.code);
    scope = derived.value;
  }
  const admission = createChildAdmission({ resources: s.root, tree: s.tree, scope, authority });
  expect(admission.admit(request("too-deep"))).toEqual({ kind: "refused", reason: "scope-limit" });
  s.root.close();
});

test("idle parents do not hold runnable slots and nested work debits the original root", async () => {
  const s = setup();
  const parent = admitted(s.admission.admit(request("parent")));
  const child = admitted(parent.admit(request("child")));
  expect(s.resources.report().scheduler.running).toBe(0);
  expect((await child.resources.execute(work("child-1", read))).kind).toBe("completed");
  expect((await parent.resources.execute(work("resume-parent", read))).kind).toBe("completed");
  expect((await child.resources.execute(work("continuation", read))).kind).toBe("completed");
  expect((await parent.resources.execute(work("exhausted", read))).receipt.state).toBe(
    "limit-exceeded",
  );
  s.tree.cancel(s.tree.root().scopeId, { kind: "requested" });
  expect(parent.admit(request("late"))).toEqual({ kind: "refused", reason: "stale-parent" });
  s.root.close();
});
