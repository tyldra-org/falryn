import { describe, expect, test } from "bun:test";

import { formatBuildOutput } from "./format.ts";

describe("Hush build formatting", () => {
  test("keeps every generic build step without an item cap", () => {
    const steps = Array.from(
      { length: 75 },
      (_, index) => `Build step ${index + 1}/75: compile module-${index + 1}`,
    );
    const formatted = formatBuildOutput(
      ["Falryn build", ...steps, "Build complete: dist/falryn (1.2 MB) in 420 ms"].join("\n"),
      ["build"],
    );
    expect(formatted).toContain("ok dist/falryn 1.2MB 420ms");
    expect(formatted).toContain("steps 75:");
    expect(formatted).toContain("compile module-1");
    expect(formatted).toContain("compile module-75");
    expect(formatted).not.toContain("omitted");
    expect(formatted).not.toContain("…");
  });

  test.each([
    {
      name: "Next routes",
      command: ["next", "build"],
      source: [
        "▲ Next.js 15.4.0",
        "Creating an optimized production build",
        "✓ Compiled successfully in 4.2s",
        "Collecting page data",
        "Generating static pages (2/2)",
        "Finalizing page optimization",
        "Route (app) Size First Load JS",
        "○ / 5.2kB 102kB",
        "ƒ /api/context 0B 97kB",
      ].join("\n"),
      markers: ["ok next 15.4.0 4.2s", "routes 2:", "ƒ /api/context 0B/97kB"],
    },
    {
      name: "Cargo install terminal facts",
      command: ["cargo", "install", "hush-cli"],
      source: [
        "Updating crates.io index",
        "Installing hush-cli v0.3.0",
        "Compiling terminal_size v0.4.0",
        "Compiling hush-cli v0.3.0",
        "Finished `release` profile [optimized] target(s) in 4.2s",
        "Installing /workspace/.cargo/bin/hush",
        "Installed package `hush-cli v0.3.0` (executable `hush`)",
      ].join("\n"),
      markers: ["hush-cli@0.3.0", "/workspace/.cargo/bin/hush", "compiled 2"],
    },
    {
      name: "Docker artifact and steps",
      command: ["docker", "build", "."],
      source: [
        '#0 building with "desktop-linux" instance using docker driver',
        "#1 [internal] load build definition from Dockerfile",
        "#1 DONE 0.0s",
        "#2 [1/1] RUN bun run build",
        "#2 DONE 0.3s",
        "#3 exporting to image",
        "#3 writing image sha256:736abc784def",
        "#3 naming to docker.io/library/falryn:latest",
        "#3 DONE 0.1s",
      ].join("\n"),
      markers: ["docker.io/library/falryn:latest@736abc784def", "steps 3:"],
    },
  ])("preserves $name", ({ command, source, markers }) => {
    const formatted = formatBuildOutput(source, command);
    expect(formatted).not.toBeNull();
    for (const marker of markers) expect(formatted).toContain(marker);
    expect(formatted).not.toContain("omitted");
  });

  test("rejects unfamiliar output instead of hiding facts", () => {
    expect(
      formatBuildOutput("custom build fact\nunknown terminal result", ["next", "build"]),
    ).toBeNull();
  });
});
