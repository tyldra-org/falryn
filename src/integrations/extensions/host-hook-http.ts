/**
 * Governed HTTPS egress for package HTTP hooks (#1175).
 *
 * One POST to exactly the endpoint the user approved. Every resolved address must be
 * publicly routable, and the connection is pinned to the address that was checked, so
 * a hostname cannot rebind to a private address between check and connect. TLS still
 * verifies the certificate for the hostname. Redirects are refused, the request and
 * response are bounded, and only the approved origin ever receives the credential.
 */
import { lookup } from "node:dns/promises";
import https from "node:https";
import { isIP } from "node:net";
import type { HookHttpPort } from "../../application/extensions/hook-http-port.ts";
import { HookExecutionError } from "../../application/tools/tool-hook-invocation.ts";
import { hookCredentialReference } from "../../domain/extensions/hook-http.ts";
import { HOOK_LIMITS } from "../../domain/extensions/hook-points.ts";
import { decodeHookResponse, encodeHookInput } from "../../domain/extensions/hook-protocol.ts";
import type { SecretResolverPort } from "../../domain/security/credential.ts";
import { isPublicAddress } from "../../domain/security/network-address.ts";
import type { HookHandlerFacts } from "../../domain/tools/hook-evidence.ts";

export type ResolvedAddress = { readonly address: string; readonly family: 4 | 6 };

/**
 * In-process composition only. Tests resolve a hostname to a local server, trust its
 * certificate and name the exact addresses that server may use; the CLI, environment
 * and configuration cannot supply any of these.
 */
export type HookEgressOptions = {
  readonly resolve?: (hostname: string) => Promise<readonly ResolvedAddress[]>;
  readonly ca?: string;
  readonly reachable?: readonly string[];
};

type Remote = Extract<HookHandlerFacts, { kind: "remote" }>;
type Received = { readonly status: number; readonly bytes: Uint8Array; readonly size: number };

async function resolveAll(hostname: string): Promise<readonly ResolvedAddress[]> {
  const found = await lookup(hostname, { all: true, verbatim: true });
  return found.map((entry) => ({ address: entry.address, family: entry.family === 6 ? 6 : 4 }));
}

class TooLarge extends Error {}

function post(options: {
  readonly url: URL;
  readonly hostname: string;
  readonly pinned: ResolvedAddress;
  readonly body: Uint8Array;
  readonly authorization: string | null;
  readonly ca: string | undefined;
  readonly signal: AbortSignal;
  readonly onSent: () => void;
}): Promise<Received> {
  return new Promise((resolve, reject) => {
    const request = https.request(
      {
        host: options.hostname,
        ...(isIP(options.hostname) === 0 ? { servername: options.hostname } : {}),
        port: options.url.port === "" ? 443 : Number(options.url.port),
        path: options.url.pathname,
        method: "POST",
        agent: false,
        ...(options.ca === undefined ? {} : { ca: options.ca }),
        // Connect only to the address that was checked, never a fresh resolution.
        lookup: (_hostname, lookupOptions, callback) =>
          (lookupOptions as { all?: boolean } | undefined)?.all
            ? (callback as (error: null, addresses: ResolvedAddress[]) => void)(null, [
                options.pinned,
              ])
            : callback(null, options.pinned.address, options.pinned.family),
        headers: {
          "content-type": "application/json",
          accept: "application/json",
          "content-length": options.body.byteLength,
          ...(options.authorization === null ? {} : { authorization: options.authorization }),
        },
      },
      (response) => {
        const chunks: Buffer[] = [];
        let size = 0;
        response.on("data", (chunk: Buffer) => {
          size += chunk.byteLength;
          if (size > HOOK_LIMITS.responseBytes) {
            response.destroy();
            reject(new TooLarge());
            return;
          }
          chunks.push(chunk);
        });
        response.on("end", () =>
          resolve({ status: response.statusCode ?? 0, bytes: Buffer.concat(chunks), size }),
        );
        response.on("error", reject);
      },
    );
    const abort = () => request.destroy(new Error("aborted"));
    if (options.signal.aborted) abort();
    options.signal.addEventListener("abort", abort, { once: true });
    request.on("error", reject);
    request.on("close", () => options.signal.removeEventListener("abort", abort));
    request.end(options.body, options.onSent);
  });
}

export function createHostHookHttp(ports: {
  readonly credentials: SecretResolverPort;
  readonly egress?: HookEgressOptions;
}): HookHttpPort {
  const resolve = ports.egress?.resolve ?? resolveAll;
  const reachable = new Set(ports.egress?.reachable ?? []);
  return {
    async run(input) {
      const { registration, grant, context } = input;
      const facts: Remote = {
        kind: "remote",
        transport: "http",
        status: "not-started",
        httpStatus: null,
        schemaGeneration: null,
        response: "missing",
        omittedBytes: 0,
        effects: "none",
      };
      const signal = context.signal;
      const stopped = () =>
        new HookExecutionError(Date.now() >= context.expiresAt ? "timed-out" : "cancelled");
      try {
        if (signal.aborted) throw stopped();
        // The grant approves exactly this contribution's declared endpoint, nothing else.
        const url = new URL(registration.handler.url);
        if (
          grant.url !== registration.handler.url ||
          grant.contribution !== input.wire.contribution.contributionId ||
          url.protocol !== "https:"
        )
          throw new HookExecutionError("hook-destination-unapproved");
        const body = encodeHookInput(input.wire);
        if (body.byteLength > HOOK_LIMITS.inputBytes)
          throw new HookExecutionError("hook-input-too-large");
        let authorization: string | null = null;
        const reference = hookCredentialReference(grant);
        if (reference !== null) {
          const resolved = await ports.credentials.resolve(
            { reference, consumer: reference.consumer },
            (secret) => secret,
            { signal },
          );
          if (resolved.kind !== "resolved")
            throw signal.aborted
              ? stopped()
              : new HookExecutionError("hook-credential-unavailable");
          authorization = "Bearer " + resolved.value;
        }
        const hostname = url.hostname.replace(/^\[(.*)\]$/u, "$1");
        const literal = isIP(hostname);
        let addresses: readonly ResolvedAddress[];
        try {
          addresses =
            literal === 0
              ? await resolve(hostname)
              : [{ address: hostname, family: literal === 6 ? 6 : 4 }];
        } catch {
          throw signal.aborted ? stopped() : new HookExecutionError("hook-destination-unresolved");
        }
        const [pinned] = addresses;
        if (pinned === undefined) throw new HookExecutionError("hook-destination-unresolved");
        // Every answer must be public: a mixed answer is how rebinding hides a private one.
        if (
          addresses.some(
            (entry) => !isPublicAddress(entry.address) && !reachable.has(entry.address),
          )
        )
          throw new HookExecutionError("hook-destination-private");
        if (!(await input.current()) || signal.aborted)
          throw signal.aborted ? stopped() : new HookExecutionError("hook-authority-stale");
        let received: Received;
        try {
          received = await post({
            url,
            hostname,
            pinned,
            body,
            authorization,
            ca: ports.egress?.ca,
            signal,
            onSent: () => {
              facts.effects = "unknown";
            },
          });
        } catch (error) {
          // Anything may have happened remotely once bytes left; the effect stays unknown.
          facts.effects = "unknown";
          if (signal.aborted) {
            facts.status = Date.now() >= context.expiresAt ? "timed-out" : "cancelled";
            throw stopped();
          }
          if (error instanceof TooLarge) {
            facts.status = "failed";
            facts.response = "invalid";
            facts.omittedBytes = HOOK_LIMITS.responseBytes;
            throw new HookExecutionError("hook-response-too-large");
          }
          facts.status = "disconnected";
          throw new HookExecutionError("hook-transport-failed");
        }
        facts.effects = "unknown";
        facts.httpStatus = received.status;
        // The body is never retained; only its decoded decision leaves this owner.
        facts.omittedBytes = received.size;
        facts.status = "completed";
        if (received.status >= 300 && received.status < 400)
          throw new HookExecutionError("hook-redirect-refused");
        if (received.status < 200 || received.status >= 300)
          throw new HookExecutionError("hook-http-status");
        if (received.status === 204 || received.bytes.byteLength === 0)
          throw new HookExecutionError("invalid-hook-response");
        if (!(await input.current()) || signal.aborted)
          throw signal.aborted ? stopped() : new HookExecutionError("hook-authority-stale");
        try {
          const decision = decodeHookResponse(received.bytes, input.wire, registration);
          facts.response = "valid";
          return decision;
        } catch {
          facts.response = "invalid";
          throw new HookExecutionError("invalid-hook-response");
        }
      } finally {
        context.report?.(facts);
      }
    },
  };
}
