import { afterEach, describe, expect, test } from "bun:test";
import { createSecretResolver } from "../../application/authentication/credential-resolver.ts";
import { marketplaceSourceSchema } from "../../domain/extensions/marketplace.ts";
import { createSystemClock } from "../../domain/foundation/index.ts";
import { createInMemoryCredentialStore } from "../../domain/security/credential.ts";
import { hookTestCertificate } from "./hook-http-fixtures.ts";
import { createHostMarketplaceHttp } from "./host-marketplace-http.ts";

const tls = hookTestCertificate("market.test");
const suite = tls === null ? describe.skip : describe;
const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const close of cleanup.splice(0)) close();
});

function service(reply: (request: Request) => Response) {
  if (tls === null) throw new Error("no certificate");
  const seen: { path: string; authorization: string | null; accept: string | null }[] = [];
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    tls,
    fetch(request) {
      seen.push({
        path: new URL(request.url).pathname,
        authorization: request.headers.get("authorization"),
        accept: request.headers.get("accept"),
      });
      return reply(request);
    },
  });
  cleanup.push(() => server.stop(true));
  return { url: `https://market.test:${server.port}/catalog.json`, seen };
}

function client(options: { reachable?: readonly string[]; secrets?: Record<string, string> } = {}) {
  return createHostMarketplaceHttp({
    credentials: createSecretResolver({
      stores: [
        createInMemoryCredentialStore({
          storeKind: "environment",
          secrets: options.secrets ?? { MARKET_TOKEN: "market-secret" },
        }),
      ],
      clock: createSystemClock(),
    }),
    now: () => 42,
    egress: {
      resolve: async () => [{ address: "127.0.0.1", family: 4 }],
      ...(tls === null ? {} : { ca: tls.cert }),
      reachable: options.reachable ?? ["127.0.0.1"],
    },
  });
}
const json = (body: string, headers: Record<string, string> = {}) =>
  new Response(body, {
    headers: { "content-type": "application/json; charset=utf-8", ...headers },
  });
const source = (url: string, credential = false) =>
  marketplaceSourceSchema.parse({
    id: "market",
    url,
    ...(credential ? { credentialEnvironment: "MARKET_TOKEN" } : {}),
  });
const signal = () => new AbortController().signal;

suite("marketplace transport", () => {
  test("one GET of the configured location carries only that marketplace's credential", async () => {
    const market = service(() => json('{"schema":"falryn.curated-catalog"}'));
    const fetched = await client().fetch(source(market.url, true), signal());
    expect(fetched).toMatchObject({ kind: "received", fetchedAt: 42 });
    if (fetched.kind !== "received") throw new Error(fetched.code);
    expect(new TextDecoder().decode(fetched.bytes)).toBe('{"schema":"falryn.curated-catalog"}');
    expect(market.seen).toEqual([
      { path: "/catalog.json", authorization: "Bearer market-secret", accept: "application/json" },
    ]);
  });

  test("a redirect is refused and never followed, so the credential stays at its origin", async () => {
    const elsewhere = service(() => json("{}"));
    const market = service(() => Response.redirect(elsewhere.url, 302));
    expect(await client().fetch(source(market.url, true), signal())).toEqual({
      kind: "failed",
      code: "marketplace-redirect-refused",
    });
    expect(elsewhere.seen).toEqual([]);
  });

  test.each([
    ["private address", { reachable: [] }, () => json("{}"), "marketplace-destination-private"],
    ["missing credential", { secrets: {} }, () => json("{}"), "marketplace-credential-unavailable"],
  ] as const)("%s is refused before any request", async (_name, options, reply, code) => {
    const market = service(reply);
    expect(await client(options).fetch(source(market.url, true), signal())).toEqual({
      kind: "failed",
      code,
    });
    expect(market.seen).toEqual([]);
  });

  test.each([
    ["unauthorized", () => new Response("no", { status: 401 }), "marketplace-unauthorized"],
    ["server error", () => new Response("no", { status: 503 }), "marketplace-http-status"],
    [
      "html",
      () => new Response("<html>", { headers: { "content-type": "text/html" } }),
      "marketplace-content-type",
    ],
    ["compressed", () => json("{}", { "content-encoding": "gzip" }), "marketplace-content-type"],
    ["oversized", () => json("x".repeat(1_048_577)), "marketplace-response-too-large"],
  ] as const)("a %s response is refused", async (_name, reply, code) => {
    const market = service(reply);
    expect(await client().fetch(source(market.url), signal())).toEqual({ kind: "failed", code });
  });

  test("cancellation stops the request and reports it", async () => {
    const market = service(() => json("{}"));
    const controller = new AbortController();
    controller.abort();
    expect(await client().fetch(source(market.url), controller.signal)).toEqual({
      kind: "failed",
      code: "marketplace-cancelled",
    });
    expect(market.seen).toEqual([]);
  });
});
