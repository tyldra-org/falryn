import { describe, expect, test } from "bun:test";

import { formatInfrastructureOutput } from "./format.ts";

describe("Hush infrastructure dispatch", () => {
  test("keeps SOPS and unknown operations exact through a null projection", () => {
    expect(
      formatInfrastructureOutput("token: secret-shaped-value", ["sops", "config.yaml"]),
    ).toBeNull();
    expect(formatInfrastructureOutput("ready", ["helm", "status", "falryn"])).toBeNull();
  });
});
