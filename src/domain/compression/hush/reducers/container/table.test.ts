import { describe, expect, test } from "bun:test";

import { formatContainerTableOutput } from "./table.ts";

describe("Hush container table formatting", () => {
  test("keeps every container row without an item cap", () => {
    const rows = Array.from(
      { length: 80 },
      (_, index) =>
        `${String(index).padStart(12, "0")}   falryn:${index}   Up ${index + 1} minutes   app-${index}`,
    );
    const formatted = formatContainerTableOutput(
      ["CONTAINER ID   IMAGE   STATUS   NAMES", ...rows].join("\n"),
      ["docker", "ps"],
    );
    expect(formatted).not.toBeNull();
    expect(formatted).toContain("000000000000");
    expect(formatted).toContain("000000000079");
    expect(formatted).not.toContain("omitted");
    expect(formatted).not.toContain("…");
  });

  test("minifies complete inspect JSON without dropping nested values", () => {
    const formatted = formatContainerTableOutput(
      JSON.stringify(
        [
          {
            Id: "sha256:736",
            Name: "/falryn",
            State: { Status: "running", ExitCode: 0 },
            NetworkSettings: { Ports: { "3000/tcp": [{ HostPort: "3000" }] } },
          },
        ],
        null,
        2,
      ),
      ["docker", "inspect", "falryn"],
    );
    expect(formatted).toBe(
      '[{"Id":"sha256:736","Name":"/falryn","State":{"Status":"running","ExitCode":0},"NetworkSettings":{"Ports":{"3000/tcp":[{"HostPort":"3000"}]}}}]',
    );
  });

  test("reports an empty native table without repeating its layout", () => {
    expect(
      formatContainerTableOutput("CONTAINER ID   IMAGE   STATUS   NAMES\n", ["podman", "ps"]),
    ).toBe("none");
  });

  test("declines caller-owned formats and malformed inspect output", () => {
    expect(
      formatContainerTableOutput("falryn\n", ["docker", "ps", "--format", "{{.Names}}"]),
    ).toBeNull();
    expect(formatContainerTableOutput("{partial", ["skopeo", "inspect", "image"])).toBeNull();
  });
});
