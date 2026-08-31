import { describe, expect, test } from "bun:test";

import { createRecordingCliStreams } from "../streams.ts";
import { createProviderAuthorizationInteraction } from "./provider.ts";

describe("provider authorization interaction", () => {
  test("projects only a local launch URI to diagnostics", async () => {
    const streams = createRecordingCliStreams();
    const interaction = createProviderAuthorizationInteraction(streams);
    expect(
      await interaction.presentLocalLaunchUri({
        providerId: "fixture",
        localLaunchUri: "http://127.0.0.1:43123/start",
      }),
    ).toEqual({ kind: "presented" });
    expect(streams.diagnosticWrites().join("")).toBe(
      "Authorize fixture: http://127.0.0.1:43123/start\n",
    );
  });

  test("accepts a manual code from protected stdin without echoing it", async () => {
    const secret = "manual-code-never-projected";
    const streams = createRecordingCliStreams({ stdin: `${secret}\n` });
    const interaction = createProviderAuthorizationInteraction(streams);
    expect(
      await interaction.requestAuthorizationCode({
        providerId: "fixture",
        authorizationUrl: "https://provider.example.test/authorize",
        signal: new AbortController().signal,
      }),
    ).toEqual({ kind: "submitted", code: secret });
    expect(streams.diagnosticWrites().join("")).not.toContain(secret);
    expect(streams.resultWrites().join("")).not.toContain(secret);
  });

  test("refuses to place device codes in a headless diagnostic stream", async () => {
    const streams = createRecordingCliStreams();
    const interaction = createProviderAuthorizationInteraction(streams);
    expect(
      await interaction.presentDeviceCode({
        providerId: "fixture",
        verificationUri: "https://provider.example.test/device",
        verificationUriComplete: null,
        userCode: "ABCD-EFGH",
      }),
    ).toEqual({ kind: "unavailable" });
    expect(streams.diagnosticWrites()).toEqual([]);
  });
});
