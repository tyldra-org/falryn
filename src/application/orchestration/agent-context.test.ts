import { afterEach, expect, test } from "bun:test";
import { removeTemporaryRoots } from "../../data/fixtures.ts";
import { bytesDigest } from "../../domain/extensions/canonical.ts";
import { validateAgentArtifacts } from "./agent-context.ts";
import { createProcessTaskFixture, taskValue } from "./process-task.fixtures.ts";
import { retainProcessTaskBytes } from "./process-task-output.ts";

afterEach(removeTemporaryRoots);
test("selected artifact evidence requires matching metadata, bytes, and integrity", async () => {
  const f = await createProcessTaskFixture();
  try {
    const artifact = taskValue(
      await retainProcessTaskBytes(
        f.artifacts,
        f.snapshot,
        "selected-evidence",
        Buffer.from("observed source"),
      ),
    );
    const item = {
      id: "source",
      source: "native-read",
      generation: "1",
      text: "observed source",
      digest: bytesDigest("observed source"),
      artifact,
    };
    const signal = new AbortController().signal;
    expect(await validateAgentArtifacts(f.artifacts, [item], signal)).toBe(true);
    expect(await validateAgentArtifacts(f.artifacts, [{ ...item, text: "altered" }], signal)).toBe(
      false,
    );
    expect(
      await validateAgentArtifacts(
        f.artifacts,
        [{ ...item, artifact: { ...artifact, artifactId: "missing" } }],
        signal,
      ),
    ).toBe(false);
    expect(
      await validateAgentArtifacts(
        { ...f.artifacts, verifyIntegrity: async () => ({ ok: true, value: false }) },
        [item],
        signal,
      ),
    ).toBe(false);
  } finally {
    await f.close();
  }
});
