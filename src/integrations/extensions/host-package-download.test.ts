import { afterEach, describe, expect, test } from "bun:test";
import { createSecretResolver } from "../../application/authentication/credential-resolver.ts";
import { createSystemClock } from "../../domain/foundation/index.ts";
import { createInMemoryCredentialStore } from "../../domain/security/credential.ts";
import { hookTestCertificate } from "./hook-http-fixtures.ts";
import { createHostPackageDownload } from "./host-package-download.ts";

const tls = hookTestCertificate("registry.test");
const suite = tls === null ? describe.skip : describe;
const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const close of cleanup.splice(0)) close();
});
const ARCHIVE = new Uint8Array([0x1f, 0x8b, 1, 2, 3]);

function server(reply: (request: Request, base: string) => Response) {
  if (tls === null) throw new Error("no certificate");
  const seen: { path: string; authorization: string | null }[] = [];
  const box = { base: "" };
  const instance = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    tls,
    fetch(request) {
      const url = new URL(request.url);
      seen.push({
        path: url.pathname + url.search,
        authorization: request.headers.get("authorization"),
      });
      return reply(request, box.base);
    },
  });
  box.base = `https://registry.test:${instance.port}`;
  cleanup.push(() => instance.stop(true));
  return { base: box.base, seen };
}
function client(options: { reachable?: readonly string[] } = {}) {
  return createHostPackageDownload({
    credentials: createSecretResolver({
      stores: [
        createInMemoryCredentialStore({ storeKind: "environment", secrets: { TOKEN: "secret" } }),
      ],
      clock: createSystemClock(),
    }),
    egress: {
      resolve: async () => [{ address: "127.0.0.1", family: 4 }],
      ...(tls === null ? {} : { ca: tls.cert }),
      reachable: options.reachable ?? ["127.0.0.1"],
    },
  });
}
const credential = (origin: string) => ({
  origin,
  reference: {
    storeKind: "environment" as const,
    locator: "TOKEN",
    consumer: "marketplace:m",
    accountLabel: null,
  },
});
const signal = () => new AbortController().signal;

suite("package archive download", () => {
  test("a same-origin redirect keeps the credential; another origin never receives it", async () => {
    const elsewhere = server(() => new Response(ARCHIVE));
    const registry = server((request, base) => {
      const path = new URL(request.url).pathname;
      if (path === "/pkg/1.0.0/package.tgz") return Response.redirect(`${base}/blob?sig=1`, 302);
      return Response.redirect(`${elsewhere.base}/final.tgz`, 307);
    });
    const received = await client().download(
      { url: `${registry.base}/pkg/1.0.0/package.tgz`, credential: credential(registry.base) },
      signal(),
    );
    expect(received).toMatchObject({
      kind: "received",
      redirects: 2,
      url: `${elsewhere.base}/final.tgz`,
    });
    expect(received.kind === "received" && [...received.bytes]).toEqual([...ARCHIVE]);
    expect(registry.seen).toEqual([
      { path: "/pkg/1.0.0/package.tgz", authorization: "Bearer secret" },
      { path: "/blob?sig=1", authorization: "Bearer secret" },
    ]);
    expect(elsewhere.seen).toEqual([{ path: "/final.tgz", authorization: null }]);
  });

  test("redirect limits, insecure hops and private destinations are refused", async () => {
    const loop = server((_request, base) => Response.redirect(`${base}/again`, 302));
    expect(
      await client().download({ url: `${loop.base}/start`, credential: null }, signal()),
    ).toEqual({
      kind: "failed",
      code: "package-download-redirect-limit",
    });
    expect(loop.seen).toHaveLength(4);
    const insecure = server(() => Response.redirect("http://registry.test/plain.tgz", 302));
    expect(
      await client().download({ url: `${insecure.base}/x`, credential: null }, signal()),
    ).toEqual({
      kind: "failed",
      code: "package-download-insecure-redirect",
    });
    const privateHost = server(() => new Response(ARCHIVE));
    expect(
      await client({ reachable: [] }).download(
        { url: `${privateHost.base}/x`, credential: null },
        signal(),
      ),
    ).toEqual({ kind: "failed", code: "package-download-private" });
    expect(privateHost.seen).toEqual([]);
  });

  test.each([
    ["unauthorized", () => new Response("no", { status: 401 }), "package-download-unauthorized"],
    ["missing", () => new Response("no", { status: 404 }), "package-download-http-status"],
    [
      "encoded",
      () => new Response(ARCHIVE, { headers: { "content-encoding": "br" } }),
      "package-download-encoding",
    ],
  ] as const)("a %s response is refused", async (_name, reply, code) => {
    const registry = server(reply);
    expect(
      await client().download({ url: `${registry.base}/x`, credential: null }, signal()),
    ).toEqual({
      kind: "failed",
      code,
    });
  });

  test("cancellation is reported and nothing is requested", async () => {
    const registry = server(() => new Response(ARCHIVE));
    const controller = new AbortController();
    controller.abort();
    expect(
      await client().download({ url: `${registry.base}/x`, credential: null }, controller.signal),
    ).toEqual({
      kind: "failed",
      code: "package-download-cancelled",
    });
    expect(registry.seen).toEqual([]);
  });
});
