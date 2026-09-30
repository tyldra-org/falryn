/**
 * Governed HTTPS egress shared by every in-process client (#1175, #153).
 *
 * Every resolved address must be publicly routable, and the connection is pinned to the
 * address that was checked, so a hostname cannot rebind to a private address between
 * check and connect. TLS still verifies the certificate for the hostname. Responses are
 * bounded while they stream; callers decide what a status means, and none follows a
 * redirect.
 */
import { lookup } from "node:dns/promises";
import type { IncomingHttpHeaders } from "node:http";
import https from "node:https";
import { isIP } from "node:net";
import { isPublicAddress } from "../../domain/security/network-address.ts";

export type ResolvedAddress = { readonly address: string; readonly family: 4 | 6 };

/**
 * In-process composition only. Tests resolve a hostname to a local server, trust its
 * certificate and name the exact addresses that server may use; the CLI, environment
 * and configuration cannot supply any of these.
 */
export type EgressOptions = {
  readonly resolve?: (hostname: string) => Promise<readonly ResolvedAddress[]>;
  readonly ca?: string;
  readonly reachable?: readonly string[];
};

export type PinnedDestination =
  | { readonly kind: "pinned"; readonly hostname: string; readonly pinned: ResolvedAddress }
  | { readonly kind: "unresolved" }
  | { readonly kind: "private" };

async function resolveAll(hostname: string): Promise<readonly ResolvedAddress[]> {
  const found = await lookup(hostname, { all: true, verbatim: true });
  return found.map((entry) => ({ address: entry.address, family: entry.family === 6 ? 6 : 4 }));
}

/** Resolve once and pin; a mixed answer is how rebinding hides a private address. */
export async function pinPublicDestination(
  url: URL,
  egress: EgressOptions | undefined,
): Promise<PinnedDestination> {
  const hostname = url.hostname.replace(/^\[(.*)\]$/u, "$1");
  const literal = isIP(hostname);
  let addresses: readonly ResolvedAddress[];
  try {
    addresses =
      literal === 0
        ? await (egress?.resolve ?? resolveAll)(hostname)
        : [{ address: hostname, family: literal === 6 ? 6 : 4 }];
  } catch {
    return { kind: "unresolved" };
  }
  const [pinned] = addresses;
  if (pinned === undefined) return { kind: "unresolved" };
  const reachable = new Set(egress?.reachable ?? []);
  if (addresses.some((entry) => !isPublicAddress(entry.address) && !reachable.has(entry.address)))
    return { kind: "private" };
  return { kind: "pinned", hostname, pinned };
}

export class ResponseTooLarge extends Error {}

export type PinnedResponse = {
  readonly status: number;
  readonly headers: IncomingHttpHeaders;
  readonly bytes: Uint8Array;
  readonly size: number;
};

/** One request to the pinned address; rejects with ResponseTooLarge past responseBytes. */
export function pinnedHttpsRequest(options: {
  readonly url: URL;
  readonly path: string;
  readonly destination: Extract<PinnedDestination, { kind: "pinned" }>;
  readonly method: "GET" | "POST";
  readonly headers: Readonly<Record<string, string | number>>;
  readonly body: Uint8Array | null;
  readonly responseBytes: number;
  readonly ca: string | undefined;
  readonly signal: AbortSignal;
  readonly onSent?: () => void;
}): Promise<PinnedResponse> {
  const { hostname, pinned } = options.destination;
  return new Promise((resolve, reject) => {
    const request = https.request(
      {
        host: hostname,
        ...(isIP(hostname) === 0 ? { servername: hostname } : {}),
        port: options.url.port === "" ? 443 : Number(options.url.port),
        path: options.path,
        method: options.method,
        agent: false,
        ...(options.ca === undefined ? {} : { ca: options.ca }),
        // Connect only to the address that was checked, never a fresh resolution.
        lookup: (_hostname, lookupOptions, callback) =>
          (lookupOptions as { all?: boolean } | undefined)?.all
            ? (callback as (error: null, addresses: ResolvedAddress[]) => void)(null, [pinned])
            : callback(null, pinned.address, pinned.family),
        headers: options.headers,
      },
      (response) => {
        const declared = Number(response.headers["content-length"]);
        if (Number.isFinite(declared) && declared > options.responseBytes) {
          response.destroy();
          reject(new ResponseTooLarge());
          return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        response.on("data", (chunk: Buffer) => {
          size += chunk.byteLength;
          if (size > options.responseBytes) {
            response.destroy();
            reject(new ResponseTooLarge());
            return;
          }
          chunks.push(chunk);
        });
        response.on("end", () =>
          resolve({
            status: response.statusCode ?? 0,
            headers: response.headers,
            bytes: Buffer.concat(chunks),
            size,
          }),
        );
        response.on("error", reject);
      },
    );
    const abort = () => request.destroy(new Error("aborted"));
    if (options.signal.aborted) abort();
    options.signal.addEventListener("abort", abort, { once: true });
    request.on("error", reject);
    request.on("close", () => options.signal.removeEventListener("abort", abort));
    if (options.body === null) request.end(options.onSent);
    else request.end(options.body, options.onSent);
  });
}
