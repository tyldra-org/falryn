/**
 * Governed HTTPS egress for package HTTP hooks (#1175).
 *
 * One POST to exactly the endpoint the user approved. Every resolved address must be
 * publicly routable, and the connection is pinned to the address that was checked, so
 * a hostname cannot rebind to a private address between check and connect. TLS still
 * verifies the certificate for the hostname. Redirects are refused, the request and
 * response are bounded, and only the approved origin ever receives the credential.
 */
import type { HookHttpPort } from "../../application/extensions/hook-http-port.ts";
import { HookExecutionError } from "../../application/tools/tool-hook-invocation.ts";
import { hookCredentialReference } from "../../domain/extensions/hook-http.ts";
import { HOOK_LIMITS } from "../../domain/extensions/hook-points.ts";
import { decodeHookResponse, encodeHookInput } from "../../domain/extensions/hook-protocol.ts";
import type { SecretResolverPort } from "../../domain/security/credential.ts";
import type { HookHandlerFacts } from "../../domain/tools/hook-evidence.ts";
import {
  type EgressOptions,
  type PinnedResponse,
  pinnedHttpsRequest,
  pinPublicDestination,
  ResponseTooLarge,
} from "../security/pinned-https.ts";

type Remote = Extract<HookHandlerFacts, { kind: "remote" }>;

export function createHostHookHttp(ports: {
  readonly credentials: SecretResolverPort;
  readonly egress?: EgressOptions;
}): HookHttpPort {
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
        const destination = await pinPublicDestination(url, ports.egress);
        if (destination.kind === "unresolved")
          throw signal.aborted ? stopped() : new HookExecutionError("hook-destination-unresolved");
        if (destination.kind === "private")
          throw new HookExecutionError("hook-destination-private");
        if (!(await input.current()) || signal.aborted)
          throw signal.aborted ? stopped() : new HookExecutionError("hook-authority-stale");
        let received: PinnedResponse;
        try {
          received = await pinnedHttpsRequest({
            url,
            path: url.pathname,
            destination,
            method: "POST",
            headers: {
              "content-type": "application/json",
              accept: "application/json",
              "content-length": body.byteLength,
              ...(authorization === null ? {} : { authorization }),
            },
            body,
            responseBytes: HOOK_LIMITS.responseBytes,
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
          if (error instanceof ResponseTooLarge) {
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
