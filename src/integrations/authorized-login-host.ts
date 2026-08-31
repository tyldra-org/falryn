/** Host ports for shared authorized-provider login. */

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import {
  type CommandRunnerPort,
  duration,
  type EnvironmentPort,
  type LocalDataPlatform,
} from "../domain/index.ts";
import type {
  AuthorizationBrowserPort,
  AuthorizationCallback,
  AuthorizationCryptoPort,
  AuthorizationInteractionPort,
  AuthorizationLoopbackPort,
  AuthorizedProviderLoginHost,
} from "../providers/index.ts";

const BROWSER_TIMEOUT = duration(5_000);
const CALLBACK_CONTENT_TYPE = "text/plain; charset=utf-8";

export type HostAuthorizedProviderLoginOptions = {
  readonly commands: CommandRunnerPort;
  readonly platform: LocalDataPlatform;
  readonly environment: EnvironmentPort;
  readonly interaction?: AuthorizationInteractionPort;
  /** Browser launch is opt-in at the human-facing composition root. */
  readonly allowBrowser?: boolean;
};

export function createHostAuthorizedProviderLogin(
  options: HostAuthorizedProviderLoginOptions,
): AuthorizedProviderLoginHost {
  return {
    crypto: createAuthorizationCrypto(),
    loopback: createBunAuthorizationLoopback(),
    browser: createAuthorizationBrowser(options),
    interaction: options.interaction ?? unavailableInteraction(),
  };
}

export function createAuthorizationCrypto(): AuthorizationCryptoPort {
  return {
    randomBase64Url(bytes) {
      return randomBytes(bytes).toString("base64url");
    },
    sha256Base64Url(value) {
      return createHash("sha256").update(value).digest("base64url");
    },
    equal(left, right) {
      const leftBytes = Buffer.from(left);
      const rightBytes = Buffer.from(right);
      return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
    },
  };
}

export function createBunAuthorizationLoopback(): AuthorizationLoopbackPort {
  return {
    async listen(input) {
      const fixed = fixedLoopback(input.fixedRedirectUri);
      if (input.fixedRedirectUri !== null && fixed === null) {
        return { kind: "unavailable" as const, code: "loopback-fixed-redirect-invalid" };
      }
      const callbackPath = fixed?.pathname ?? `/callback/${encodeURIComponent(input.attemptId)}`;
      const launchPath = `/start/${encodeURIComponent(input.attemptId)}`;
      let authorizationUrl: string | null = null;
      let requestCount = 0;
      let terminal = false;
      let settle: ((callback: AuthorizationCallback) => void) | null = null;
      const callback = new Promise<AuthorizationCallback>((resolve) => {
        settle = resolve;
      });

      try {
        const server = Bun.serve({
          hostname: "127.0.0.1",
          port: fixed?.port ?? 0,
          fetch(request) {
            requestCount += 1;
            if (requestCount > input.maxRequests) {
              return response("Authorization request limit reached.", 429);
            }
            if (headerBytes(request.headers) > input.maxHeaderBytes) {
              return response("Authorization headers are too large.", 431);
            }
            const contentLength = Number(request.headers.get("content-length") ?? "0");
            if (!Number.isFinite(contentLength) || contentLength > input.maxBodyBytes) {
              return response("Authorization body is too large.", 413);
            }
            const url = new URL(request.url);
            if (request.method !== "GET") {
              return response("Authorization callback requires GET.", 405);
            }
            if (url.pathname === launchPath) {
              if (authorizationUrl === null || terminal) {
                return response("Authorization is not available.", 409);
              }
              return Response.redirect(authorizationUrl, 302);
            }
            if (url.pathname !== callbackPath) {
              return response("Authorization callback not found.", 404);
            }
            if (terminal) {
              return response("Authorization callback was already handled.", 409);
            }
            if (url.href.length > input.maxHeaderBytes) {
              return response("Authorization callback is too large.", 414);
            }
            terminal = true;
            const state = boundedParameter(url.searchParams.get("state"));
            const error = boundedParameter(url.searchParams.get("error"));
            const code = boundedParameter(url.searchParams.get("code"));
            if (error !== null) {
              settle?.({ kind: "denied", state, code: structuralCode(error) });
              return response("Authorization was not granted. You may close this window.", 200);
            }
            if (state === null || code === null) {
              settle?.({ kind: "invalid", code: "authorization-callback-malformed" });
              return response("Authorization callback was incomplete.", 400);
            }
            settle?.({ kind: "callback", state, code });
            return response("Authorization completed. You may close this window.", 200);
          },
        });
        const redirectUri = fixed?.redirectUri ?? `http://127.0.0.1:${server.port}${callbackPath}`;
        const launchUri = `http://127.0.0.1:${server.port}${launchPath}`;
        return {
          kind: "listening" as const,
          session: {
            redirectUri,
            prepareBrowserLaunch(nextAuthorizationUrl) {
              if (!nextAuthorizationUrl.startsWith("https://") || terminal) {
                return null;
              }
              authorizationUrl = nextAuthorizationUrl;
              return launchUri;
            },
            async receive(signal) {
              if (signal.aborted) {
                return { kind: "cancelled" as const };
              }
              return new Promise<AuthorizationCallback>((resolve) => {
                const onAbort = (): void => resolve({ kind: "cancelled" });
                signal.addEventListener("abort", onAbort, { once: true });
                void callback.then((value) => {
                  signal.removeEventListener("abort", onAbort);
                  resolve(value);
                });
              });
            },
            async close() {
              terminal = true;
              settle?.({ kind: "cancelled" });
              await server.stop(true);
            },
          },
        };
      } catch {
        return { kind: "unavailable" as const, code: "loopback-listener-unavailable" };
      }
    },
  };
}

function fixedLoopback(value: string | null): {
  readonly port: number;
  readonly pathname: string;
  readonly redirectUri: string;
} | null {
  if (value === null) {
    return null;
  }
  try {
    const parsed = new URL(value);
    const port = Number(parsed.port);
    if (
      parsed.protocol !== "http:" ||
      parsed.hostname !== "127.0.0.1" ||
      !Number.isSafeInteger(port) ||
      port < 1 ||
      port > 65_535 ||
      parsed.username.length > 0 ||
      parsed.password.length > 0 ||
      parsed.search.length > 0 ||
      parsed.hash.length > 0
    ) {
      return null;
    }
    return { port, pathname: parsed.pathname, redirectUri: parsed.href };
  } catch {
    return null;
  }
}

function createAuthorizationBrowser(
  options: HostAuthorizedProviderLoginOptions,
): AuthorizationBrowserPort {
  return {
    async launch(localLaunchUri, signal) {
      if (options.allowBrowser !== true) {
        return { kind: "unavailable", code: "browser-launch-disabled" };
      }
      const command = browserCommand(options.platform);
      if (command === null) {
        return { kind: "unavailable", code: "browser-command-unavailable" };
      }
      const executable = Bun.which(command.executable);
      if (executable === null) {
        return { kind: "unavailable", code: "browser-command-unavailable" };
      }
      const outcome = await options.commands.run({
        executable,
        argv: [...command.prefix, localLaunchUri],
        environment: browserEnvironment(options.environment),
        timeoutMs: BROWSER_TIMEOUT,
        maxOutputBytes: 1_024,
        signal,
      });
      return outcome.kind === "exited" && outcome.exitCode === 0
        ? { kind: "opened" }
        : { kind: "unavailable", code: `browser-${outcome.kind}` };
    },
  };
}

function browserCommand(
  platform: LocalDataPlatform,
): { readonly executable: string; readonly prefix: readonly string[] } | null {
  switch (platform) {
    case "darwin":
      return { executable: "open", prefix: [] };
    case "linux":
      return { executable: "xdg-open", prefix: [] };
    case "win32":
      return { executable: "rundll32.exe", prefix: ["url.dll,FileProtocolHandler"] };
    default:
      return null;
  }
}

function browserEnvironment(environment: EnvironmentPort): Readonly<Record<string, string>> {
  const names = ["DISPLAY", "WAYLAND_DISPLAY", "XDG_RUNTIME_DIR", "HOME", "USERPROFILE"];
  return Object.fromEntries(
    names.flatMap((name) => {
      const value = environment.get(name);
      return value === null ? [] : [[name, value] as const];
    }),
  );
}

function unavailableInteraction(): AuthorizationInteractionPort {
  return {
    presentLocalLaunchUri: async () => ({ kind: "unavailable" }),
    requestAuthorizationCode: async () => ({ kind: "unavailable" }),
    presentDeviceCode: async () => ({ kind: "unavailable" }),
  };
}

function response(text: string, status: number): Response {
  return new Response(text, {
    status,
    headers: {
      "cache-control": "no-store",
      "content-security-policy": "default-src 'none'",
      "content-type": CALLBACK_CONTENT_TYPE,
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
    },
  });
}

function headerBytes(headers: Headers): number {
  let bytes = 0;
  for (const [name, value] of headers) {
    bytes += Buffer.byteLength(name) + Buffer.byteLength(value) + 4;
  }
  return bytes;
}

function boundedParameter(value: string | null): string | null {
  return value !== null && value.length > 0 && value.length <= 4_096 && !value.includes("\0")
    ? value
    : null;
}

function structuralCode(value: string): string {
  return /^[a-z0-9][a-z0-9._-]{0,127}$/iu.test(value)
    ? value.toLowerCase()
    : "authorization-denied";
}
