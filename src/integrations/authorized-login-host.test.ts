import { describe, expect, test } from "bun:test";

import { createStubCommandRunner, instant } from "../domain/index.ts";
import {
  createBunAuthorizationLoopback,
  createHostAuthorizedProviderLogin,
} from "./authorized-login-host.ts";

describe("authorized login host", () => {
  test("uses a random loopback listener, relays the provider URL locally, and rejects replay", async () => {
    const opened = await createBunAuthorizationLoopback().listen({
      attemptId: "fixture-attempt",
      deadline: instant(Date.now() + 5_000),
      fixedRedirectUri: null,
      maxHeaderBytes: 16_384,
      maxBodyBytes: 4_096,
      maxRequests: 4,
    });
    expect(opened.kind).toBe("listening");
    if (opened.kind !== "listening") throw new Error("loopback listener unavailable");
    const providerUrl = "https://provider.example.test/authorize?state=opaque";
    const launch = opened.session.prepareBrowserLaunch(providerUrl);
    expect(launch).toStartWith("http://127.0.0.1:");
    if (launch === null) throw new Error("local launch URL unavailable");

    const redirected = await fetch(launch, { redirect: "manual" });
    expect(redirected.status).toBe(302);
    expect(redirected.headers.get("location")).toBe(providerUrl);
    const callbackUrl = new URL(opened.session.redirectUri);
    callbackUrl.searchParams.set("state", "state-fixture");
    callbackUrl.searchParams.set("code", "callback-code");
    const received = opened.session.receive(new AbortController().signal);
    expect((await fetch(callbackUrl)).status).toBe(200);
    expect(await received).toEqual({
      kind: "callback",
      state: "state-fixture",
      code: "callback-code",
    });
    expect((await fetch(callbackUrl)).status).toBe(409);
    await opened.session.close();
  });

  test("rejects malformed callbacks and oversized declared bodies", async () => {
    const malformed = await createBunAuthorizationLoopback().listen({
      attemptId: "malformed-attempt",
      deadline: instant(Date.now() + 5_000),
      fixedRedirectUri: null,
      maxHeaderBytes: 16_384,
      maxBodyBytes: 4,
      maxRequests: 3,
    });
    if (malformed.kind !== "listening") throw new Error("loopback listener unavailable");
    const oversized = await fetch(malformed.session.redirectUri, {
      method: "POST",
      body: "12345",
    });
    expect(oversized.status).toBe(413);
    const received = malformed.session.receive(new AbortController().signal);
    expect((await fetch(malformed.session.redirectUri)).status).toBe(400);
    expect(await received).toEqual({
      kind: "invalid",
      code: "authorization-callback-malformed",
    });
    await malformed.session.close();
  });

  test("binds an exact provider-registered loopback redirect", async () => {
    const probe = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response() });
    const port = probe.port;
    await probe.stop(true);
    const redirectUri = `http://127.0.0.1:${port}/registered/callback`;
    const opened = await createBunAuthorizationLoopback().listen({
      attemptId: "fixed-attempt",
      deadline: instant(Date.now() + 5_000),
      fixedRedirectUri: redirectUri,
      maxHeaderBytes: 16_384,
      maxBodyBytes: 4_096,
      maxRequests: 2,
    });
    expect(opened.kind).toBe("listening");
    if (opened.kind !== "listening") throw new Error("fixed loopback listener unavailable");
    expect(opened.session.redirectUri).toBe(redirectUri);
    await opened.session.close();
  });

  test("does not launch a browser unless the human-facing caller opted in", async () => {
    const runner = createStubCommandRunner(() => ({ kind: "exited", exitCode: 0, stdout: "" }));
    const host = createHostAuthorizedProviderLogin({
      commands: runner,
      platform: "darwin",
      environment: { get: () => null },
      allowBrowser: false,
    });
    expect(
      await host.browser.launch("http://127.0.0.1:43123/start", new AbortController().signal),
    ).toEqual({ kind: "unavailable", code: "browser-launch-disabled" });
    expect(runner.requests()).toEqual([]);
  });
});
