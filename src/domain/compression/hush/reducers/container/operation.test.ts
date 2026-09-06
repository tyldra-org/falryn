import { describe, expect, test } from "bun:test";

import { formatContainerOperationOutput } from "./operation.ts";

describe("Hush container operation formatting", () => {
  test("keeps Docker pull identity, digest, final layer states, and status", () => {
    const formatted = formatContainerOperationOutput(
      [
        "1.4: Pulling from library/bun",
        "a736: Pulling fs layer",
        "b784: Download complete",
        "a736: Pull complete",
        "Digest: sha256:736abc784def",
        "Status: Downloaded newer image for bun:1.4",
        "docker.io/library/bun:1.4",
      ].join("\n"),
      ["docker", "pull", "bun:1.4"],
    );
    expect(formatted).toContain("ok docker pull docker.io/library/bun:1.4@sha256:736abc784def");
    expect(formatted).toContain("a736=Pull complete");
    expect(formatted).toContain("b784=Download complete");
    expect(formatted).toContain("Downloaded newer image for bun:1.4");
  });

  test("keeps every Skopeo blob plus config and terminal writes", () => {
    const formatted = formatContainerOperationOutput(
      [
        "Getting image source signatures",
        "Copying blob sha256:111aaa",
        "Copying blob sha256:222bbb",
        "Copying config sha256:333ccc",
        "Writing manifest to image destination",
        "Storing signatures",
      ].join("\n"),
      ["skopeo", "copy", "docker://source", "docker://target"],
    );
    expect(formatted).toBe(
      [
        "ok skopeo copy 2 blobs",
        "sha256:111aaa, sha256:222bbb",
        "config sha256:333ccc; manifest; signatures",
      ].join("\n"),
    );
  });

  test("does not reinterpret run, exec, or incomplete progress output", () => {
    const source = "application-owned output\nsecond exact line";
    expect(formatContainerOperationOutput(source, ["docker", "run", "image"])).toBeNull();
    expect(formatContainerOperationOutput(source, ["podman", "exec", "app", "cmd"])).toBeNull();
    expect(
      formatContainerOperationOutput("Copying blob sha256:111aaa", [
        "skopeo",
        "copy",
        "source",
        "target",
      ]),
    ).toBeNull();
  });
});
