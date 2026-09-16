import { expect, test } from "bun:test";
import { configurationGeneration, createManualClock } from "../../domain/foundation/index.ts";
import { createProductResources } from "../orchestration/product-resources.ts";
import { createProfileTransitions } from "./profile-transitions.ts";
import type {
  PreparedProfileOwner,
  ProfileTransitionOwner,
  ProfileTransitionPorts,
  ProfileTransitionReceipt,
  ResolvedProfileTransition,
} from "./transition-contracts.ts";

const scope = { sessionId: "session-a", workspaceId: "workspace-a" };
function fixture(overrides: Partial<ProfileTransitionPorts> = {}) {
  const facts: ProfileTransitionReceipt[] = [];
  const state = { generation: 0, sources: "source-a", policy: "policy-a" };
  const resources = createProductResources(createManualClock()).openTask("0");
  const calls: string[] = [];
  const candidate: ResolvedProfileTransition = {
    record: {
      generation: configurationGeneration.from(1),
      values: {},
      sources: [],
      issues: [],
      provenance: [],
      overridden: [],
    },
    inspection: {
      generation: configurationGeneration.from(1),
      values: [],
      sources: [],
      issues: [],
    },
    changes: [],
    effectiveInputChanged: false,
    sourceRevision: "source-b",
    validate: async () => true,
    async publish() {
      calls.push("publish");
      state.generation++;
      state.sources = "source-b";
      return state.generation;
    },
  };
  const owner = (id: string, required = true): ProfileTransitionOwner => ({
    id,
    describe: () => ({
      owner: id,
      required,
      availability: "available",
      applicationClass: "next-turn",
      preparation: "connection",
      cost: "none",
    }),
    async prepare(_candidate, bound) {
      expect(bound).toBe(resources);
      calls.push(`prepare:${id}`);
      return {
        release: async () => {
          calls.push(`release:${id}`);
        },
        async acknowledge(generation, current) {
          expect(current()).toBe(true);
          calls.push(`ack:${id}`);
          return { state: "applied", generation, code: "applied" };
        },
      };
    },
  });
  const ports: ProfileTransitionPorts = {
    scope,
    resources,
    owners: [owner("models")],
    deadlineMs: 500,
    maxOwners: 64,
    current: () => ({ ...state }),
    authorize: () => true,
    resolve: async () => candidate,
    newIdentity: () => "candidate-b",
    record: async (receipt) => {
      facts.push(structuredClone(receipt));
      return true;
    },
    recover: async () => facts.at(-1) ?? null,
    ...overrides,
  };
  const service = createProfileTransitions(ports);
  const preview = () =>
    service.preview({
      ...scope,
      profile: "b",
      expectedGeneration: state.generation,
      expectedSources: state.sources,
      actor: "user",
    });
  const apply = (signal?: AbortSignal) =>
    service.apply(
      { ...scope, candidateId: "candidate-b", actor: "user", expectedGeneration: 0 },
      signal,
    );
  return { service, preview, apply, state, calls, facts, owner, resources, candidate, ports };
}

test("preview is inert; exact scope and candidate are required; receipts distinguish publication and acknowledgement", async () => {
  const f = fixture();
  expect((await f.preview()).kind).toBe("preview");
  expect(f.calls).toEqual([]);
  expect(f.resources.remaining("requests")).toBe(64);
  expect(
    await f.service.apply({
      ...scope,
      sessionId: "another",
      candidateId: "candidate-b",
      actor: "user",
      expectedGeneration: 0,
    }),
  ).toEqual({ kind: "refused", code: "session-target-mismatch" });
  expect((await f.apply()).kind).toBe("receipt");
  expect(f.calls).toEqual(["prepare:models", "publish", "ack:models"]);
  expect(f.facts.map((fact) => fact.stage)).toEqual([
    "prepared",
    "published",
    "published",
    "settled",
  ]);
  expect(f.facts[1]?.owners[0]?.state).toBe("pending");
  expect(f.facts.at(-1)?.publishedGeneration).toBe(1);
  expect(f.facts.at(-1)?.savedFileRevision).toBeNull();
  expect(f.resources.remaining("requests")).toBe(63);
  expect(await f.apply()).toEqual({ kind: "refused", code: "candidate-missing" });
});

test("required preparation failure keeps A and releases only this attempt's acquired resources", async () => {
  const f = fixture();
  const owners = [
    f.owner("models"),
    {
      ...f.owner("mcp"),
      prepare: async () => ({ kind: "refused" as const, code: "mcp-unavailable" }),
    },
  ];
  const service = createProfileTransitions({ ...f.ports, owners });
  await service.preview({
    ...scope,
    profile: "b",
    expectedGeneration: 0,
    expectedSources: "source-a",
    actor: "user",
  });
  const outcome = await service.apply({
    ...scope,
    candidateId: "candidate-b",
    actor: "user",
    expectedGeneration: 0,
  });
  expect(outcome.kind).toBe("receipt");
  expect(f.state.generation).toBe(0);
  expect(f.calls).toEqual(["prepare:models", "release:models"]);
  expect(f.facts.at(-1)?.owners[1]?.state).toBe("failed");
});

test("source invalidation and policy changes during preparation cannot publish", async () => {
  for (const change of ["source", "policy", "generation"] as const) {
    const f = fixture();
    const base = f.owner("environment");
    const service = createProfileTransitions({
      ...f.ports,
      owners: [
        {
          ...base,
          async prepare(candidate, resources, signal) {
            const prepared = await base.prepare(candidate, resources, signal);
            if (change === "source") service.invalidate();
            if (change === "policy") f.state.policy = "revoked";
            if (change === "generation") f.state.generation = 2;
            return prepared;
          },
        },
      ],
    });
    await service.preview({
      ...scope,
      profile: "b",
      expectedGeneration: 0,
      expectedSources: "source-a",
      actor: "user",
    });
    await service.apply({
      ...scope,
      candidateId: "candidate-b",
      actor: "user",
      expectedGeneration: 0,
    });
    expect(f.calls).toEqual(["prepare:environment", "release:environment"]);
    expect(f.facts.at(-1)?.publishedGeneration).toBeNull();
  }
});

test("optional missing owner remains visible beside restart-required and pending acknowledgements", async () => {
  const f = fixture();
  const base = f.owner("processes");
  const service = createProfileTransitions({
    ...f.ports,
    owners: [
      {
        ...f.owner("optional-package", false),
        prepare: async () => ({ kind: "refused", code: "package-absent" }),
      },
      {
        ...base,
        prepare: async () => ({
          release: async () => {},
          acknowledge: async () => ({
            state: "restart-required",
            generation: 0,
            code: "running-process",
          }),
        }),
      },
    ],
  });
  await service.preview({
    ...scope,
    profile: "b",
    expectedGeneration: 0,
    expectedSources: "source-a",
    actor: "user",
  });
  const result = await service.apply({
    ...scope,
    candidateId: "candidate-b",
    actor: "user",
    expectedGeneration: 0,
  });
  expect(result.kind === "receipt" && result.receipt.code).toBe("partial");
  expect(f.facts.at(-1)?.owners.map((owner) => owner.state)).toEqual([
    "unavailable",
    "restart-required",
  ]);
  const recovered = createProfileTransitions(f.ports);
  expect(await recovered.inspect()).toEqual(f.facts.at(-1) ?? null);
  expect(f.calls).toEqual(["publish"]);
});

test("cancellation after publication preserves facts and fences a late acknowledgement", async () => {
  const f = fixture();
  const stop = new AbortController();
  let lateCurrent: (() => boolean) | undefined;
  const service = createProfileTransitions({
    ...f.ports,
    owners: [
      {
        ...f.owner("models"),
        prepare: async () => ({
          release: async () => {
            throw new Error("published ownership must be retained");
          },
          acknowledge: async (_generation, current) => {
            lateCurrent = current;
            stop.abort();
            return { state: "applied", generation: 1, code: "late" };
          },
        }),
      },
    ],
  });
  await service.preview({
    ...scope,
    profile: "b",
    expectedGeneration: 0,
    expectedSources: "source-a",
    actor: "user",
  });
  const outcome = await service.apply(
    { ...scope, candidateId: "candidate-b", actor: "user", expectedGeneration: 0 },
    stop.signal,
  );
  expect(outcome.kind === "receipt" && outcome.receipt.publishedGeneration).toBe(1);
  expect(f.facts.at(-1)?.owners[0]?.state).toBe("pending");
  expect(lateCurrent?.()).toBe(false);
});

test("no transition can reset an exhausted resource allowance", async () => {
  const f = fixture();
  f.resources.tighten({ operations: 0 });
  await f.preview();
  await f.apply();
  expect(f.calls).toEqual([]);
  expect(f.state.generation).toBe(0);
  expect(f.facts.at(-1)?.owners[0]?.code).toContain("preparation-");
});

test("restart reconciliation observes owners without replaying preparation or trusting stale applied flags", async () => {
  const f = fixture();
  await f.preview();
  await f.apply();
  const recovered = createProfileTransitions({
    ...f.ports,
    owners: [
      {
        ...f.owner("models"),
        inspect: async () => ({
          state: "pending",
          generation: 0,
          code: "binding-revalidation-required",
        }),
      },
    ],
  });
  const calls = [...f.calls];
  const result = await recovered.reconcile("user");
  expect(result.kind === "receipt" && result.receipt.owners[0]?.state).toBe("pending");
  expect(f.calls).toEqual(calls);
});

test("a model cannot apply a candidate reviewed by the user", async () => {
  const f = fixture();
  await f.preview();
  expect(
    await f.service.apply({
      ...scope,
      candidateId: "candidate-b",
      actor: "model",
      expectedGeneration: 0,
    }),
  ).toEqual({ kind: "refused", code: "profile-policy-denied" });
  expect(f.calls).toEqual([]);
});

test("a before-switch veto produces a rejected fact and never emits an applied acknowledgement", async () => {
  const f = fixture();
  const service = createProfileTransitions({
    ...f.ports,
    owners: [
      {
        ...f.owner("model.switch.before"),
        prepare: async () => ({ kind: "refused", code: "user-policy-veto" }),
      },
    ],
  });
  await service.preview({
    ...scope,
    profile: "b",
    expectedGeneration: 0,
    expectedSources: "source-a",
    actor: "user",
  });
  await service.apply({
    ...scope,
    candidateId: "candidate-b",
    actor: "user",
    expectedGeneration: 0,
  });
  expect(f.facts.at(-1)).toMatchObject({
    stage: "rejected",
    publishedGeneration: null,
    owners: [{ state: "failed", code: "user-policy-veto" }],
  });
  expect(f.calls).toEqual([]);
});

test("a durable session refuses a required ephemeral owner before publication", async () => {
  const f = fixture();
  const owner = f.owner("retention");
  const service = createProfileTransitions({
    ...f.ports,
    owners: [
      {
        ...owner,
        describe: (candidate) => ({
          ...owner.describe(candidate),
          availability: "new-session-required",
        }),
      },
    ],
  });
  await service.preview({
    ...scope,
    profile: "ephemeral",
    expectedGeneration: 0,
    expectedSources: "source-a",
    actor: "user",
  });
  await service.apply({
    ...scope,
    candidateId: "candidate-b",
    actor: "user",
    expectedGeneration: 0,
  });
  expect(f.calls).toEqual([]);
  expect(f.facts.at(-1)?.owners[0]?.state).toBe("new-session-required");
});

test("late preparation after cancellation is cleaned up and cannot acknowledge", async () => {
  const f = fixture();
  const stop = new AbortController();
  let finish!: (value: PreparedProfileOwner) => void;
  let started!: () => void;
  const began = new Promise<void>((resolve) => {
    started = resolve;
  });
  const service = createProfileTransitions({
    ...f.ports,
    owners: [
      {
        ...f.owner("mcp"),
        prepare: async () => {
          started();
          return new Promise((resolve) => {
            finish = resolve;
          });
        },
      },
    ],
  });
  await service.preview({
    ...scope,
    profile: "b",
    expectedGeneration: 0,
    expectedSources: "source-a",
    actor: "user",
  });
  const applied = service.apply(
    { ...scope, candidateId: "candidate-b", actor: "user", expectedGeneration: 0 },
    stop.signal,
  );
  await began;
  stop.abort();
  await applied;
  let released!: () => void;
  const cleaned = new Promise<void>((resolve) => {
    released = resolve;
  });
  finish({
    release: async () => {
      released();
    },
    acknowledge: async () => {
      throw new Error("late callback");
    },
  });
  await cleaned;
  expect(f.state.generation).toBe(0);
});

test("reconciliation refuses an owner's mismatched applied generation", async () => {
  const f = fixture();
  await f.preview();
  await f.apply();
  const recovered = createProfileTransitions({
    ...f.ports,
    owners: [
      {
        ...f.owner("models"),
        inspect: async () => ({
          state: "applied",
          generation: 0,
          code: "stale",
        }),
      },
    ],
  });
  const result = await recovered.reconcile("user");
  expect(result.kind === "receipt" && result.receipt.code).toBe("partial");
  expect(result.kind === "receipt" && result.receipt.owners[0]).toMatchObject({
    state: "failed",
    generation: null,
    code: "acknowledgement-generation-mismatch",
  });
});
