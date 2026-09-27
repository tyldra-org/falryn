import { afterEach, describe, expect, test } from "bun:test";
import { createSecretResolver } from "../../application/authentication/credential-resolver.ts";
import { HookExecutionError } from "../../application/tools/tool-hook-invocation.ts";
import {
  hookFixtureEnvelope,
  hookServiceDecision,
  httpHookDeclaration,
} from "../../domain/extensions/hook-fixtures.ts";
import { type HookGrant, httpHookContract } from "../../domain/extensions/hook-http.ts";
import { createSystemClock } from "../../domain/foundation/index.ts";
import { createInMemoryCredentialStore } from "../../domain/security/credential.ts";
import type { HookHandlerFacts } from "../../domain/tools/hook-evidence.ts";
import { hookTestCertificate } from "./hook-http-fixtures.ts";
import { createHostHookHttp, type ResolvedAddress } from "./host-hook-http.ts";

const tls = hookTestCertificate("hooks.test");
const suite = tls === null ? describe.skip : describe;
const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const close of cleanup.splice(0)) close();
});
const CONTRIBUTION = "sha256:" + "c".repeat(64);

type Reply = (request: Request, body: string) => Response | Promise<Response>;
function service(reply: Reply) {
  if (tls === null) throw new Error("no certificate");
  const seen: { authorization: string | null; host: string | null; body: string }[] = [];
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    tls,
    async fetch(request) {
      const body = await request.text();
      seen.push({
        authorization: request.headers.get("authorization"),
        host: request.headers.get("host"),
        body,
      });
      return reply(request, body);
    },
  });
  cleanup.push(() => server.stop(true));
  return { url: "https://hooks.test:" + server.port + "/decide", seen };
}

function harness(
  url: string,
  options: {
    readonly credential?: boolean;
    readonly secrets?: Record<string, string>;
    readonly resolve?: readonly ResolvedAddress[];
    readonly reachable?: readonly string[];
    readonly grant?: Partial<HookGrant>;
  } = {},
) {
  const registration = httpHookContract(
    httpHookDeclaration(url, options.credential ? { credential: "hook_token" } : {}),
  );
  const grant: HookGrant = {
    contribution: CONTRIBUTION,
    url,
    credential: options.credential
      ? { storeKind: "environment", locator: "HOOK_TOKEN", accountLabel: null }
      : null,
    ...options.grant,
  };
  const http = createHostHookHttp({
    credentials: createSecretResolver({
      stores: [
        createInMemoryCredentialStore({
          storeKind: "environment",
          secrets: options.secrets ?? { HOOK_TOKEN: "hook-secret" },
        }),
      ],
      clock: createSystemClock(),
    }),
    egress: {
      resolve: async () => options.resolve ?? [{ address: "127.0.0.1", family: 4 }],
      ...(tls === null ? {} : { ca: tls.cert }),
      reachable: options.reachable ?? ["127.0.0.1"],
    },
  });
  const envelope = hookFixtureEnvelope();
  const wire = {
    version: 1 as const,
    invocationId: "invocation-1",
    contribution: {
      packageId: "fixture",
      contributionId: CONTRIBUTION,
      generation: Number(envelope.registrationGeneration),
    },
    envelope,
  };
  const facts: HookHandlerFacts[] = [];
  const run = (
    current: () => Promise<boolean> = async () => true,
    signal = new AbortController().signal,
  ) =>
    http.run({
      registration,
      grant,
      wire,
      current,
      context: {
        signal,
        expiresAt: Date.now() + 5_000,
        resourceTaskId: "task",
        report: (value) => facts.push(value),
      },
    });
  return { run, facts };
}
async function code(promise: Promise<unknown>) {
  try {
    await promise;
    return "completed";
  } catch (error) {
    return error instanceof HookExecutionError ? error.code : String(error);
  }
}
const decide =
  (veto = false): Reply =>
  (_request, body) =>
    new Response(hookServiceDecision(JSON.parse(body), veto), {
      headers: { "content-type": "application/json" },
    });

suite("governed HTTPS hook egress", () => {
  test("posts the wire document to the approved endpoint with its own credential", async () => {
    const { url, seen } = service(decide(true));
    const h = harness(url, { credential: true });
    const decision = await h.run();
    expect(decision).toMatchObject({ kind: "veto", reason: "remote-veto" });
    expect(seen).toHaveLength(1);
    expect(seen[0]?.authorization).toBe("Bearer hook-secret");
    expect(seen[0]?.host).toStartWith("hooks.test:");
    expect(JSON.parse(seen[0]?.body ?? "{}")).toMatchObject({ invocationId: "invocation-1" });
    expect(h.facts).toEqual([
      {
        kind: "remote",
        transport: "http",
        status: "completed",
        httpStatus: 200,
        schemaGeneration: null,
        response: "valid",
        omittedBytes: expect.any(Number),
        effects: "unknown",
      },
    ]);
    expect(JSON.stringify(h.facts)).not.toContain("hook-secret");
    // Without a named credential nothing is sent in its place.
    const plain = harness(url);
    expect((await plain.run()).kind).toBe("veto");
    expect(seen[1]?.authorization).toBeNull();
  });

  test("refuses before sending anything when the grant, credential or destination is wrong", async () => {
    const { url, seen } = service(decide());
    const cases: [string, ReturnType<typeof harness>["run"]][] = [
      ["hook-destination-unapproved", harness(url, { grant: { url: url + "x" } }).run],
      [
        "hook-destination-unapproved",
        harness(url, { grant: { contribution: "sha256:" + "d".repeat(64) } }).run,
      ],
      ["hook-credential-unavailable", harness(url, { credential: true, secrets: {} }).run],
      [
        "hook-destination-private",
        harness(url, { resolve: [{ address: "10.1.2.3", family: 4 }], reachable: [] }).run,
      ],
      // A public answer beside a private one is how rebinding hides.
      [
        "hook-destination-private",
        harness(url, {
          resolve: [
            { address: "127.0.0.1", family: 4 },
            { address: "::ffff:192.168.0.1", family: 6 },
          ],
        }).run,
      ],
      ["hook-destination-unresolved", harness(url, { resolve: [] }).run],
    ];
    for (const [expected, run] of cases) expect(await code(run())).toBe(expected);
    const literal = harness("https://10.0.0.8:443/decide", { reachable: [] });
    expect(await code(literal.run())).toBe("hook-destination-private");
    expect(await code(harness(url).run(async () => false))).toBe("hook-authority-stale");
    const aborted = new AbortController();
    aborted.abort();
    expect(await code(harness(url).run(undefined, aborted.signal))).toBe("cancelled");
    expect(seen).toEqual([]);
  });

  test("redirects, failed statuses and unusable bodies are failures, never decisions", async () => {
    const cases: [Reply, string][] = [
      [() => Response.redirect("https://hooks.test/elsewhere", 307), "hook-redirect-refused"],
      [() => new Response("nope", { status: 500 }), "hook-http-status"],
      [() => new Response(null, { status: 204 }), "invalid-hook-response"],
      [() => new Response(""), "invalid-hook-response"],
      [() => new Response("{not json"), "invalid-hook-response"],
      [() => new Response("x".repeat(20_000)), "hook-response-too-large"],
      [
        (_request, body) =>
          new Response(hookServiceDecision({ ...JSON.parse(body), invocationId: "other" }, false)),
        "invalid-hook-response",
      ],
    ];
    for (const [reply, expected] of cases) {
      const { url } = service(reply);
      const h = harness(url);
      expect(await code(h.run())).toBe(expected);
      expect(h.facts[0]?.kind === "remote" && h.facts[0].effects).toBe("unknown");
    }
  });

  test("a lost connection after sending stays unknown, and a wrong certificate name fails", async () => {
    const { url } = service(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5_000));
      return new Response("late");
    });
    const abort = new AbortController();
    const h = harness(url);
    setTimeout(() => abort.abort(), 100);
    expect(await code(h.run(undefined, abort.signal))).toBe("cancelled");
    expect(h.facts[0]).toMatchObject({ status: "cancelled", effects: "unknown" });

    const other = service(decide());
    const mismatch = harness(other.url.replace("hooks.test", "other.test"));
    expect(await code(mismatch.run())).toBe("hook-transport-failed");
    expect(other.seen).toEqual([]);
  });
});
