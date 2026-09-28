import { afterEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { removeTemporaryRoots, temporaryRoot } from "../../data/fixtures.ts";
import { hookServiceDecision, httpHookDeclaration } from "../../domain/extensions/hook-fixtures.ts";
import type { HookGrantRequirement } from "../../domain/extensions/hook-grants.ts";
import { packageReceiptSchema } from "../../domain/extensions/lifecycle.ts";
import { hookTestCertificate } from "../../integrations/extensions/hook-http-fixtures.ts";
import type { HookEgressOptions } from "../../integrations/extensions/host-hook-http.ts";
import { createHostSandbox } from "../../integrations/security/host-sandbox.ts";
import { nativeProductJourney, observerNotices } from "../runtime/native-product-fixtures.ts";
import { preparePackageCliFixture } from "./package-health-fixtures.ts";
import { prepareNativeCliFixture } from "./package-native-fixtures.ts";

afterEach(removeTemporaryRoots);
const tls = hookTestCertificate("hooks.test");
const unavailable = tls === null || createHostSandbox().probe().status !== "available";
const COMMAND = [process.execPath, "run", new URL("../../main.ts", import.meta.url).pathname];
const CREDENTIAL = { storeKind: "environment" as const, locator: "HOOK_TOKEN", accountLabel: null };
/** Answer an HTTP hook's approval requirement with its exact URL and this credential. */
const httpGrant = (credential: typeof CREDENTIAL | null) => (requirement: HookGrantRequirement) => {
  if (!("url" in requirement)) throw new Error("http-requirement-expected");
  return { contribution: requirement.contribution, url: requirement.url, credential };
};

/** A deterministic HTTPS decision service for the test hostname. */
function decisionService(veto: boolean) {
  if (tls === null) throw new Error("no certificate");
  const calls: (string | null)[] = [];
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    tls,
    async fetch(request) {
      calls.push(request.headers.get("authorization"));
      const body = (await request.json()) as Parameters<typeof hookServiceDecision>[0];
      return new Response(hookServiceDecision(body, veto), {
        headers: { "content-type": "application/json" },
      });
    },
  });
  return {
    url: "https://hooks.test:" + server.port + "/decide",
    calls,
    stop: () => server.stop(true),
  };
}
const egress = (reachable: readonly string[]): HookEgressOptions => ({
  resolve: async () => [{ address: "127.0.0.1", family: 4 }],
  ...(tls === null ? {} : { ca: tls.cert }),
  reachable,
});
const gates = (journey: Awaited<ReturnType<typeof nativeProductJourney>>) =>
  journey.events?.ok
    ? journey.events.value.flatMap((event) =>
        event.kind === "history.recorded" && event.payload.type === "gate" && event.payload.hook
          ? [event.payload]
          : [],
      )
    : [];

test.skipIf(unavailable).each([
  ["allow", false],
  ["veto", true],
] as const)(
  "an installed HTTP hook gates a real native tool call through its approved endpoint: %s",
  async (_name, veto) => {
    const service = decisionService(veto);
    try {
      const root = await temporaryRoot("falryn-hook-http-");
      const fixture = await prepareNativeCliFixture(COMMAND, root, {
        declarations: [httpHookDeclaration(service.url, { credential: "hook_token" })],
        files: {},
        grant: httpGrant(CREDENTIAL),
      });
      const journey = await nativeProductJourney(
        {
          home: root,
          environment: { ...fixture.environment, HOOK_TOKEN: "hook-secret" },
          name: fixture.name,
        },
        { hookEgress: egress(["127.0.0.1"]) },
      );
      // One approved POST, carrying only the user's credential for this hook.
      expect(service.calls).toEqual(["Bearer hook-secret"]);
      expect(
        gates(journey).filter((gate) => gate.decision === (veto ? "veto" : "observe")),
      ).toHaveLength(1);
      expect(journey.result.payload?.stage).toBe(veto ? "attempt-failed" : "attempt-completed");
      // The native tool ran exactly once on allow and never on veto.
      const answered = journey.requests.filter((request) => request.includes('\\"answer\\":42'));
      expect(answered).toHaveLength(veto ? 0 : 1);
      expect(JSON.stringify(journey.events)).not.toContain("hook-secret");
    } finally {
      service.stop();
    }
  },
  60_000,
);

test.skipIf(unavailable)(
  "a destination that resolves privately fails the gate closed before any request",
  async () => {
    const service = decisionService(false);
    try {
      const root = await temporaryRoot("falryn-hook-http-private-");
      const fixture = await prepareNativeCliFixture(COMMAND, root, {
        declarations: [httpHookDeclaration(service.url)],
        files: {},
        grant: httpGrant(null),
      });
      const journey = await nativeProductJourney(
        { home: root, environment: fixture.environment, name: fixture.name },
        { hookEgress: egress([]) },
      );
      expect(service.calls).toEqual([]);
      expect(journey.result.payload?.stage).toBe("attempt-failed");
      expect(journey.requests.filter((request) => request.includes('\\"answer\\":42'))).toEqual([]);
    } finally {
      service.stop();
    }
  },
  60_000,
);

test.skipIf(unavailable)(
  "an async HTTP observer completes after the tool settles and leaves one attributed notice",
  async () => {
    const service = decisionService(false);
    try {
      const root = await temporaryRoot("falryn-hook-http-async-");
      const fixture = await prepareNativeCliFixture(COMMAND, root, {
        declarations: [
          httpHookDeclaration(service.url, { point: "after-capability-invocation", mode: "async" }),
        ],
        files: {},
        grant: httpGrant(null),
      });
      const journey = await nativeProductJourney(
        { home: root, environment: fixture.environment, name: fixture.name },
        { hookEgress: egress(["127.0.0.1"]) },
      );
      expect(journey.result.payload?.stage).toBe("attempt-completed");
      expect(
        journey.requests.filter((request) => request.includes('\\"answer\\":42')),
      ).toHaveLength(1);
      // The tool settled without waiting; the run then drained its admitted observer.
      expect(gates(journey).map((gate) => gate.decision)).toEqual([
        "hook-chain-bound",
        "queued",
        "observe",
      ]);
      expect(service.calls).toEqual([null]);
      // Reading the stored session back projects one notice and sends nothing again.
      const notices = observerNotices(journey);
      expect(notices).toHaveLength(1);
      expect(notices[0]).toContain("observe");
      await new Promise((resolve) => setTimeout(resolve, 500));
      expect(service.calls).toHaveLength(1);
    } finally {
      service.stop();
    }
  },
  60_000,
);

test.skipIf(unavailable)(
  "enabling lists what each HTTP hook needs and refuses a missing or different grant",
  async () => {
    const root = await temporaryRoot("falryn-hook-http-grant-");
    const url = "https://hooks.example.com/decide";
    const fixture = await preparePackageCliFixture(COMMAND, root, "healthy", true, {
      declarations: [httpHookDeclaration(url, { credential: "hook_token" })],
      files: {},
    });
    const enable = (grants?: unknown) =>
      fixture.invoke(
        ["package", "enable"],
        {
          operationId: randomUUID(),
          packageId: "fixture",
          expectedRevision: 1,
          nativeActivation: {
            scope: "user",
            expectedRevision: 0,
            contributions: [fixture.contribution, ...fixture.extraContributions],
            ...(grants === undefined ? {} : { grants }),
          },
        },
        packageReceiptSchema,
      );
    const missing = await enable();
    expect(missing).toMatchObject({
      status: "failed",
      code: "hook-grant-required",
      confirmation: null,
    });
    const { requirements } = z
      .object({ requirements: z.array(z.custom<HookGrantRequirement>()) })
      .parse(missing.data);
    const [hook] = fixture.extraContributions;
    if (hook === undefined) throw new Error("missing hook contribution");
    expect(requirements).toEqual([{ contribution: hook, url, credential: "hook_token" }]);
    expect(
      await enable([{ contribution: hook, url: url + "/other", credential: CREDENTIAL }]),
    ).toMatchObject({ code: "hook-grant-destination-mismatch" });
    expect(await enable([{ contribution: hook, url, credential: null }])).toMatchObject({
      code: "hook-grant-credential-mismatch",
    });
    expect(
      await enable([
        { contribution: hook, url, credential: CREDENTIAL },
        { contribution: fixture.contribution, url, credential: null },
      ]),
    ).toMatchObject({ code: "hook-grant-unexpected" });
    const approved = await enable([{ contribution: hook, url, credential: CREDENTIAL }]);
    expect(approved).toMatchObject({
      status: "preview",
      code: "native-activation-confirmation-required",
      data: { requirements },
    });
  },
  60_000,
);
