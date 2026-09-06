import { describe, expect, test } from "bun:test";

import { formatOperationOutput } from "./format.ts";

describe("Hush operation formatting", () => {
  test("preserves Prisma generation identity and output", () => {
    const formatted = formatOperationOutput(
      [
        "Environment variables loaded from .env",
        "Prisma schema loaded from prisma/schema.prisma",
        "✔ Generated Prisma Client (v6.14.0) to ./node_modules/@prisma/client in 123ms",
        "Start by importing your Prisma Client",
      ].join("\n"),
      ["prisma", "generate"],
    );
    expect(formatted).toBe(
      "ok prisma generate Prisma Client@6.14.0 123ms prisma/schema.prisma -> ./node_modules/@prisma/client",
    );
  });

  test("does not reinterpret arbitrary Ollama, Java, or PHP program output", () => {
    const source = "application-owned output\nsecond exact line";
    expect(formatOperationOutput(source, ["ollama", "run", "model"])).toBeNull();
    expect(formatOperationOutput(source, ["java", "-jar", "app.jar"])).toBeNull();
    expect(formatOperationOutput(source, ["php", "app.php"])).toBeNull();
  });

  test("rejects incomplete known output", () => {
    expect(
      formatOperationOutput("Prisma schema loaded from prisma/schema.prisma", [
        "prisma",
        "generate",
      ]),
    ).toBeNull();
  });
});
